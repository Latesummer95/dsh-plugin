/**
 * level-probe — does this route actually honour the thinking level it advertises?
 *
 * ## The question this answers
 *
 * A route advertises thinking levels (the picker reads them from
 * `listModels(...).reasoning.efforts`), but an advertisement is a claim about
 * what the *adapter* can express, not about what the *upstream* will do with it.
 * A relay commonly maps several levels onto the same upstream parameter, so
 * `xhigh` and `max` cost the same and think the same — and the user pays for a
 * level that means nothing. The reverse also happens: a level that the picker
 * offers is rejected outright.
 *
 * Neither failure is visible from the outside. The only way to know is to ask
 * the **same question** at every level and compare what came back, which is what
 * this probe does.
 *
 * ## What is measured
 *
 * The task is a chain of modular arithmetic with exactly one right answer, so
 * both effort and correctness are observable:
 *
 *   - **reasoning tokens** (`usage.reasoning`) — the direct signal. If the
 *     provider reports them, two levels that report the same count are the same
 *     level, whatever they are called.
 *   - **reasoning text length** — the fallback when `usage.reasoning` is absent
 *     but the adapter still streams `reasoning-delta` parts.
 *   - **latency and accuracy** — the last resort, and the tie-breaker: a level
 *     that thinks longer but scores the same has bought nothing.
 *
 * The signal actually used is reported per level, and a verdict is only called
 * *distinct* against the previous level when the signal moved by more than
 * {@link SIGNAL_TOLERANCE}. When no signal exists the verdict says so rather
 * than guessing from noise.
 *
 * ## Why the task is generated
 *
 * A fixed question can be memorised, and a memorised answer is identical at
 * every level — which would read as "all levels are the same". The numbers are
 * drawn from a seeded generator per run, so the correct answer is not reachable
 * from recall at any level.
 *
 * @module dsh-level-probe
 */

/** Host plugin name, as referenced by the profile patch. */
export const name = "level-probe";

/** Both halves of the job need these. */
export const inject = ["webServer", "llm"];

/** Route prefix; the client reads progress back through this. */
export const ROUTE_PREFIX = "/level-probe";

/**
 * The level vocabulary, in the order a user thinks about it.
 *
 * Mirrors the host's own `THINKING_LEVELS`. It is only used to *order* and to
 * filter what the route advertises — a model that does not advertise a level is
 * never asked for it, because an unadvertised level is a 400 rather than a
 * finding about the upstream.
 */
export const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * How much the signal must move for two levels to count as different.
 *
 * Below this, the difference is indistinguishable from sampling noise: a model
 * asked the same question twice does not spend exactly the same number of
 * thinking tokens. 15% is deliberately generous — the cost of wrongly calling
 * two levels identical is that a user leaves a useful level off, and the cost of
 * wrongly calling them distinct is that they keep paying for a level that does
 * nothing.
 */
export const SIGNAL_TOLERANCE = 0.15;

/** Defaults; the profile patch may override any of them. */
export const DEFAULTS = {
	/**
	 * Provider route to probe; empty means every provider the profile has
	 * configured.
	 *
	 * Not a vendor id baked into the source: this plugin is installed into
	 * arbitrary profiles, and a hard-coded route either fails `listModels`
	 * outright or preselects models the user never configured.
	 */
	provider: "",
	/** Substring filter applied to the configured models; empty means no filter. */
	modelPattern: "",
	/** Explicit `provider/model` list; overrides provider + modelPattern when set. */
	models: [],
	/**
	 * Levels to probe; empty means exactly what the model advertises.
	 *
	 * Asking for a level the route does not advertise is not a finding, it is a
	 * malformed request — so this is a filter, never an expansion.
	 */
	levels: [],
	/**
	 * Distinct questions per level.
	 *
	 * One answer per level cannot separate "this level thinks more" from "this
	 * answer happened to be longer". Two makes the signal a comparison rather
	 * than a coin flip; more only smooths it further.
	 */
	tasksPerLevel: 2,
	/** Max output tokens per attempt. The answer is one number; thinking needs the room. */
	maxTokens: 4000,
	/** Per-attempt wall clock budget. */
	timeoutMs: 120000,
	/** Models to probe concurrently, 1–{@link MAX_CONCURRENCY}. */
	concurrency: 1,
	/** Pause between models in milliseconds. */
	spacingMs: 500
};

/** Upper bound on models probed at once; gateways throttle hard. */
export const MAX_CONCURRENCY = 2;

/** Clamp a configured concurrency into the usable range. */
function concurrencyWidth(value) {
	return Math.max(1, Math.min(Number(value) || 1, MAX_CONCURRENCY));
}

/** Clamp a configured task count into the usable range. */
function taskWidth(value) {
	return Math.max(1, Math.min(Math.floor(Number(value) || 1), 5));
}

/* ------------------------------------------------------------------ *
 * Task generation
 * ------------------------------------------------------------------ */

/**
 * A small deterministic PRNG (mulberry32).
 *
 * The seed is reported in the run manifest, so a surprising result can be
 * reproduced exactly by re-running with the same tasks.
 *
 * @param seed - 32-bit integer seed.
 * @returns a `() => number` in `[0, 1)`.
 */
export function mulberry32(seed) {
	let a = seed >>> 0;
	return function next() {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The moduli and coefficients the generator draws from. */
const MODULUS = 1000;
const MULTIPLIERS = [3, 7, 11, 13, 17, 19];
const INCREMENTS = [7, 13, 29, 37, 53];
const STARTS = [101, 137, 211, 307, 433, 509];

/**
 * Build `count` chain-arithmetic tasks from a seed.
 *
 * Each task is `x ← (x * m + c) mod 1000` repeated `steps` times. Every step is
 * trivial; the difficulty is that they must all be right, which is exactly the
 * kind of work a thinking budget changes and recall cannot supply.
 *
 * @param count - how many tasks to draw.
 * @param seed - the run's seed.
 * @returns `[{id, prompt, expected, steps}]`.
 */
export function makeTasks(count, seed) {
	const total = Math.max(1, Math.min(Math.floor(Number(count) || 1), 5));
	const random = mulberry32(seed);
	const pick = (list) => list[Math.floor(random() * list.length)];
	const tasks = [];
	for (let index = 0; index < total; index += 1) {
		const multiplier = pick(MULTIPLIERS);
		const increment = pick(INCREMENTS);
		const start = pick(STARTS);
		// 12–16 steps: long enough that a skipped or fumbled step shows up in the
		// answer, short enough that a model without a thinking budget can still
		// finish it and reveal that it did not need one.
		const steps = 12 + Math.floor(random() * 5);
		let value = start;
		for (let step = 0; step < steps; step += 1) value = (value * multiplier + increment) % MODULUS;
		tasks.push({
			id: `t${index + 1}-${start}-${multiplier}-${increment}-${steps}`,
			prompt:
				`从 ${start} 开始，重复执行下面这一步 ${steps} 次：\n` +
				`  x = (x * ${multiplier} + ${increment}) mod ${MODULUS}\n` +
				`请一步一步算，但**只输出最终的数字**，不要输出任何其他文字。`,
			expected: value,
			steps
		});
	}
	return tasks;
}

/**
 * Read the model's answer and decide whether it is right.
 *
 * The last integer in the reply is the answer: the prompt asks for a bare
 * number, but a model that thinks out loud still ends with it. Taking the last
 * one rather than the first is what makes an answer that shows its working
 * scoreable instead of looking wrong.
 *
 * @param text - the reply text.
 * @param expected - the correct value.
 * @returns `{answer, correct}`.
 */
export function checkAnswer(text, expected) {
	const matches = String(text ?? "").match(/-?\d+/g);
	if (matches === null || matches.length === 0) return { answer: null, correct: false };
	const answer = Number(matches[matches.length - 1]);
	return { answer, correct: answer === expected };
}

/* ------------------------------------------------------------------ *
 * Measurement
 * ------------------------------------------------------------------ */

/**
 * Drain a stream into text, reasoning, usage and termination reason.
 *
 * @param stream - the async iterable of stream parts.
 * @returns `{text, reasoning, usage, reason}`.
 */
async function drainStream(stream) {
	let text = "";
	let reasoning = "";
	let usage;
	let reason;
	for await (const chunk of stream) {
		if (chunk === null || typeof chunk !== "object") continue;
		switch (chunk.type) {
			case "text-delta":
				if (typeof chunk.text === "string") text += chunk.text;
				break;
			case "reasoning-delta":
				if (typeof chunk.text === "string") reasoning += chunk.text;
				break;
			case "usage":
				usage = chunk.usage;
				break;
			case "finish":
				reason = chunk.reason;
				break;
			default:
				break;
		}
	}
	return { text, reasoning, usage, reason };
}

/**
 * Ask one model one question at one explicit thinking level.
 *
 * Never throws: a rejected level and a dropped stream are both findings about
 * the route, and the caller needs them side by side with the success cases.
 *
 * @param ctx - the plugin context.
 * @param target - `{provider, model}`.
 * @param level - the thinking level to send.
 * @param task - the generated task.
 * @param config - the resolved plugin config.
 * @returns the attempt record.
 */
export async function measure(ctx, target, level, task, config) {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.timeoutMs);
	try {
		const options = {
			provider: target.provider,
			model: target.model,
			// `content` is a readonly array of content blocks, not a bare string:
			// adapters call `content.some(...)`, so a string throws.
			messages: [{ role: "user", content: [{ type: "text", text: task.prompt }] }],
			maxTokens: config.maxTokens,
			// The whole point of the probe: ask for this exact level. Unlike the
			// other probes there is no "omit the field" mode, because "what happens
			// when the route chooses" is not a level.
			reasoningEffort: level,
			signal: controller.signal
		};
		const { text, reasoning, usage, reason } = await drainStream(ctx.llm.stream(options));
		const { answer, correct } = checkAnswer(text, task.expected);
		const failed = reason !== undefined && reason.kind !== "stop" && reason.kind !== "max-tokens";
		return {
			level,
			taskId: task.id,
			expected: task.expected,
			ok: !failed,
			answer,
			correct,
			latencyMs: Date.now() - started,
			/**
			 * A reasoning-token count, when one is reported at all.
			 *
			 * Kept distinct from `0`, which is a real answer ("this level thought
			 * not at all"). Note that the host's own pi-ai adapter drops this field
			 * when it maps a provider's usage onto `TokenUsage`, so in practice this
			 * is `null` on every relay and the reasoning *text* is the signal. It is
			 * still read here because it is the only first-hand measurement, and a
			 * future adapter that keeps it should be used automatically.
			 */
			reasoningTokens: typeof usage?.reasoning === "number" ? usage.reasoning : null,
			/**
			 * `outputTokens`, not `output`: the field is renamed by the adapter
			 * (`mapUsage` maps pi-ai's `usage.output` onto DSH's `outputTokens`).
			 * Reading `usage.output` here silently produced an empty column.
			 */
			outputTokens: typeof usage?.outputTokens === "number" ? usage.outputTokens : null,
			reasoningChars: reasoning.length,
			outputChars: text.length,
			finish: reason?.kind ?? null,
			error: failed
				? String(reason?.failure?.message ?? reason?.kind)
				: null,
			preview: String(text).slice(0, 200)
		};
	} catch (error) {
		return {
			level,
			taskId: task.id,
			expected: task.expected,
			ok: false,
			answer: null,
			correct: false,
			latencyMs: Date.now() - started,
			reasoningTokens: null,
			outputTokens: null,
			reasoningChars: 0,
			outputChars: 0,
			finish: null,
			error: error instanceof Error ? error.message : String(error),
			preview: ""
		};
	} finally {
		clearTimeout(timer);
	}
}

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

/** Mean of the numeric values, or `null` when there are none. */
function mean(values) {
	const present = values.filter((v) => typeof v === "number" && Number.isFinite(v));
	if (present.length === 0) return null;
	return present.reduce((a, b) => a + b, 0) / present.length;
}

/** The numeric values present, in order; `[]` when the key is never a number. */
function samplesOf(attempts, key) {
	return attempts.map((a) => a[key]).filter((v) => typeof v === "number" && Number.isFinite(v));
}

/**
 * Collapse one level's attempts into the numbers a verdict is read from.
 *
 * The per-attempt values are kept alongside their mean because a mean alone
 * cannot say whether a difference is real. Two levels whose samples overlap —
 * `[1311]` against `[1372]` — are not distinguishable no matter how the means
 * compare, and reporting only the means invites exactly that misreading.
 *
 * @param level - the level id.
 * @param attempts - its attempt records.
 * @returns the level's aggregate row.
 */
export function summarizeLevel(level, attempts) {
	const ok = attempts.filter((a) => a.ok);
	// Only a request that came back can have been answered correctly. Counting
	// `correct` over all attempts let a level whose every request failed report a
	// 100% accuracy — which is exactly backwards, and would have made a rejected
	// level look like the best one in the table.
	const right = ok.filter((a) => a.correct);
	const reasoningTokens = samplesOf(ok, "reasoningTokens");
	const reasoningChars = samplesOf(ok, "reasoningChars");
	const latencyMs = samplesOf(ok, "latencyMs");
	return {
		level,
		attempts: attempts.length,
		ok: ok.length,
		failed: attempts.length - ok.length,
		correct: right.length,
		accuracy: attempts.length === 0 ? null : right.length / attempts.length,
		reasoningTokens: mean(reasoningTokens),
		outputTokens: mean(samplesOf(ok, "outputTokens")),
		reasoningChars: mean(reasoningChars),
		latencyMs: mean(latencyMs),
		/** The raw per-attempt values, so a reader can see the spread. */
		samples: { reasoningTokens, reasoningChars, latencyMs },
		errors: [...new Set(attempts.filter((a) => !a.ok).map((a) => a.error).filter(Boolean))]
	};
}

/**
 * Pick the metric that can actually separate these levels.
 *
 * Order matters: a token count reported by the provider is a fact, a reasoning
 * character count is a decent proxy, and latency is only a hint — it moves with
 * load as much as with effort. The chosen signal is named in the report so a
 * verdict never looks stronger than its evidence.
 *
 * @param rows - the per-level aggregate rows.
 * @returns `{signal, key}` where `signal` is a human name or `null`.
 */
export function chooseSignal(rows) {
	const live = rows.filter((row) => row.ok > 0);
	const allHave = (key) => live.length > 0 && live.every((row) => typeof row[key] === "number");
	if (allHave("reasoningTokens")) return { signal: "reasoning-tokens", key: "reasoningTokens" };
	if (allHave("reasoningChars") && live.some((row) => row.reasoningChars > 0)) {
		return { signal: "reasoning-text", key: "reasoningChars" };
	}
	if (allHave("latencyMs")) return { signal: "latency", key: "latencyMs" };
	return { signal: null, key: null };
}

/**
 * Whether two levels' samples are separable at all.
 *
 * A mean difference is not evidence when the underlying values overlap: with one
 * sample per level, `1311` and `1372` are two draws from the same distribution as
 * far as anything here can tell, and calling that "distinct" is reading noise.
 * The test is therefore whether the ranges are disjoint — the only claim two
 * small samples can actually support.
 *
 * @param a - the previous level's samples.
 * @param b - this level's samples.
 * @returns `true` when the two sets cannot be told apart.
 */
export function overlaps(a, b) {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return true;
	const lowA = Math.min(...a);
	const highA = Math.max(...a);
	const lowB = Math.min(...b);
	const highB = Math.max(...b);
	return lowA <= highB && lowB <= highA;
}

/**
 * Decide, for each level, whether it does anything the previous one did not.
 *
 * The comparison is always against the **previous usable level**, not against
 * the maximum: a chain of aliases should read as one run of "same as previous"
 * rather than each level looking distinct from the one before it by noise.
 *
 * A level is only called `distinct` when both tests pass — its samples do not
 * overlap the previous level's, *and* the means differ by more than
 * {@link SIGNAL_TOLERANCE}. Failing the overlap test means "the difference is
 * inside the spread of the answers themselves"; failing the magnitude test means
 * "the difference is real but too small to matter". Both are reported as
 * `same-as-previous`, with the reason in the note, because the decision the user
 * is making is whether to pay for the level.
 *
 * @param rows - the per-level aggregate rows, in level order.
 * @returns `{signal, verdicts}`; `verdicts` aligns with `rows`.
 */
export function analyzeLevels(rows) {
	const { signal, key } = chooseSignal(rows);
	let previous = null;
	const verdicts = rows.map((row) => {
		if (row.ok === 0) {
			return {
				level: row.level,
				status: "unavailable",
				vs: null,
				delta: null,
				note: row.errors[0] ?? "每一次请求都失败了"
			};
		}
		if (key === null) {
			previous = row;
			return { level: row.level, status: "unknown", vs: null, delta: null, note: "该中转没有暴露任何可用于比较的信号" };
		}
		const value = row[key];
		if (previous === null) {
			const verdict = { level: row.level, status: "baseline", vs: null, delta: null, note: "最低可用档位，作为比较基准" };
			previous = row;
			return verdict;
		}
		const base = previous[key];
		// A zero baseline has no meaningful ratio; the absolute move is the only
		// honest reading, and any move at all is a difference.
		const delta = base === 0 ? (value === 0 ? 0 : 1) : (value - base) / base;
		const spread = overlaps(previous.samples?.[key], row.samples?.[key]);
		const bigEnough = Math.abs(delta) > SIGNAL_TOLERANCE;
		const status = !spread && bigEnough ? "distinct" : "same-as-previous";
		let note;
		if (status === "distinct") {
			note = `比 ${previous.level} 高 ${(delta * 100).toFixed(1)}%`;
		} else if (spread) {
			note = `与 ${previous.level} 的样本重叠，区别在噪声范围内`;
		} else {
			note = `与 ${previous.level} 只差 ${(delta * 100).toFixed(1)}%，不足以说明有区别`;
		}
		const verdict = { level: row.level, status, vs: previous.level, delta, note };
		previous = row;
		return verdict;
	});
	return { signal, verdicts };
}

/**
 * The cheapest level that is as accurate as the best one.
 *
 * This is the report's actionable line. If `high` scores what `max` scores, the
 * answer to "should I turn max on" is no — and it is not a guess, it is the
 * accuracy column.
 *
 * @param rows - the per-level aggregate rows, in level order.
 * @returns `{level, bestAccuracy, note}` or `null` when nothing scored.
 */
export function recommend(rows) {
	const scored = rows.filter((row) => row.ok > 0 && row.accuracy !== null);
	if (scored.length === 0) return null;
	const best = Math.max(...scored.map((row) => row.accuracy));
	if (best === 0) {
		return { level: null, bestAccuracy: 0, note: "所有档位都没答对，无法据此推荐——这个模型的推理档位对这道题没有帮助" };
	}
	const cheapest = scored.find((row) => row.accuracy >= best);
	if (cheapest === undefined) return null;
	const dearest = scored[scored.length - 1];
	if (cheapest.level === dearest.level) {
		return { level: cheapest.level, bestAccuracy: best, note: `${cheapest.level} 是唯一答对的档位，需要开到这个档` };
	}
	return {
		level: cheapest.level,
		bestAccuracy: best,
		note: `${cheapest.level} 已经达到最高正确率，${cheapest.level} 以上的档位没有额外收益`
	};
}

/* ------------------------------------------------------------------ *
 * Catalog
 * ------------------------------------------------------------------ */

/**
 * List every provider/model the panel can offer, with each model's advertised
 * thinking levels.
 *
 * **`listModels` does not carry reasoning metadata.** It returns a catalog entry
 * — provider, id, name, input modalities — and nothing else, so a probe built on
 * `listModels(model).reasoning` sees `undefined` for every model and silently
 * offers nothing to run. The levels live on `resolveModelInfo(provider, model)`,
 * which is the same call the model picker reads, so the probe can only ever ask
 * for a level the UI would actually offer — a level the route never advertised
 * is a malformed request, not a finding.
 *
 * The lookup is per model because the API is per model; it is in-process
 * validation and does not touch the network.
 *
 * @param ctx - the plugin context.
 * @returns `{providers, models, failed}`.
 */
export async function listCandidates(ctx) {
	const providers = (ctx.llm.listProviders?.() ?? [])
		.map((p) => String(p?.id ?? p?.provider ?? p?.name ?? ""))
		.filter((id) => id.length > 0);
	const models = [];
	const failed = [];
	for (const provider of providers) {
		let listed;
		try {
			listed = await ctx.llm.listModels(provider);
		} catch (error) {
			failed.push({ provider, error: error instanceof Error ? error.message : String(error) });
			continue;
		}
		for (const model of listed) {
			const id = String(model.id);
			let efforts;
			try {
				efforts = (await ctx.llm.resolveModelInfo?.(provider, id))?.reasoning?.efforts;
			} catch (error) {
				// A model whose metadata the host rejects is still listed: hiding it
				// would make the panel disagree with the picker about what exists.
				// It is offered with no levels, which is the truthful description.
				failed.push({
					provider,
					model: id,
					error: error instanceof Error ? error.message : String(error)
				});
				efforts = undefined;
			}
			const advertised = (efforts ?? [])
				.map((effort) => String(effort?.id ?? effort ?? ""))
				.filter((level) => LEVEL_ORDER.includes(level));
			models.push({
				provider,
				model: id,
				name: model.name ?? null,
				levels: LEVEL_ORDER.filter((level) => advertised.includes(level))
			});
		}
	}
	models.sort((a, b) =>
		a.provider === b.provider ? a.model.localeCompare(b.model) : a.provider.localeCompare(b.provider)
	);
	return { providers, models, failed };
}

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

/** Parse a `provider/model` list, or `null` when the shape is wrong. */
export function parseModels(value) {
	if (!Array.isArray(value)) return value === undefined ? undefined : null;
	const out = [];
	for (const entry of value) {
		const text = String(entry ?? "").trim();
		if (text.length === 0) continue;
		const slash = text.indexOf("/");
		if (slash <= 0 || slash === text.length - 1) return null;
		out.push({ provider: text.slice(0, slash), model: text.slice(slash + 1) });
	}
	return out;
}

/**
 * Resolve the targets to probe.
 *
 * Explicit `models` win; otherwise the configured `provider` (or every provider)
 * is filtered by `modelPattern`. Only models that advertise at least one
 * thinking level are eligible: a model with no levels has nothing to compare,
 * and probing it would produce a row of identical `unknown` verdicts.
 *
 * @param ctx - the plugin context.
 * @param config - the resolved plugin config.
 * @param requested - an explicit selection from the request, or `undefined`.
 * @returns the target list.
 */
export async function resolveTargets(ctx, config, requested) {
	if (Array.isArray(requested) && requested.length > 0) {
		const catalog = await listCandidates(ctx);
		const known = new Map(catalog.models.map((m) => [`${m.provider}/${m.model}`, m]));
		return requested
			.map(({ provider, model }) => known.get(`${provider}/${model}`))
			.filter((entry) => entry !== undefined);
	}
	const catalog = await listCandidates(ctx);
	const pattern = String(config.modelPattern ?? "").toLowerCase();
	const explicit = config.models ?? [];
	return catalog.models.filter((entry) => {
		if (entry.levels.length === 0) return false;
		if (explicit.length > 0) {
			return explicit.some((m) => `${entry.provider}/${entry.model}` === String(m).trim());
		}
		if (config.provider && entry.provider !== config.provider) return false;
		if (pattern.length > 0 && !entry.model.toLowerCase().includes(pattern)) return false;
		return true;
	});
}

/**
 * Probe one model across its levels.
 *
 * Levels run **in sequence** so their latencies are comparable; the tasks within
 * a level run together, since they are the same question and their relative
 * timing carries no meaning.
 *
 * @param ctx - the plugin context.
 * @param target - `{provider, model, levels}`.
 * @param tasks - the generated tasks.
 * @param config - the resolved plugin config.
 * @param onProgress - optional status callback.
 * @returns the model's record.
 */
export async function probeModel(ctx, target, tasks, config, onProgress) {
	const label = `${target.provider}/${target.model}`;
	const allowed = new Set(target.levels.length > 0 ? target.levels : LEVEL_ORDER);
	const wanted = (config.levels ?? []).filter((level) => level !== undefined && level !== null && level !== "");
	const levels = LEVEL_ORDER.filter((level) => allowed.has(level) && (wanted.length === 0 || wanted.includes(level)));
	const rows = [];

	for (const level of levels) {
		onProgress?.(`${label}：档位 ${level}（${tasks.length} 道题）`);
		const attempts = await Promise.all(
			tasks.map((task) => measure(ctx, target, level, task, config))
		);
		rows.push(summarizeLevel(level, attempts));
	}

	const { signal, verdicts } = analyzeLevels(rows);
	return {
		provider: target.provider,
		model: target.model,
		levels: rows,
		verdicts,
		signal,
		recommendation: recommend(rows)
	};
}

/**
 * Run a detection over the resolved targets.
 *
 * @param ctx - the plugin context.
 * @param targets - the targets to probe.
 * @param config - the resolved plugin config.
 * @param onProgress - optional status callback.
 * @param report - optional live report; each finished model is pushed as it completes.
 * @returns the report's model list.
 */
export async function runDetection(ctx, targets, config, onProgress, report) {
	const tasks = makeTasks(taskWidth(config.tasksPerLevel), config.seed);
	const models = report?.models ?? [];
	const width = concurrencyWidth(config.concurrency);
	const queue = targets.map((target, index) => ({ target, index }));
	const lanes = Math.max(1, Math.min(width, queue.length));
	const run = async () => {
		for (;;) {
			const item = queue.shift();
			if (item === undefined) return;
			const { target, index } = item;
			onProgress?.(`[${index + 1}/${targets.length}] ${target.provider}/${target.model}`);
			try {
				models.push(await probeModel(ctx, target, tasks, config, onProgress));
			} catch (error) {
				models.push({
					provider: target.provider,
					model: target.model,
					levels: [],
					verdicts: [],
					signal: null,
					recommendation: null,
					error: error instanceof Error ? error.message : String(error)
				});
			}
			if (queue.length > 0 && config.spacingMs > 0) {
				await new Promise((r) => setTimeout(r, config.spacingMs));
			}
		}
	};
	await Promise.all(Array.from({ length: lanes }, run));
	return models;
}

/** The single-slot run registry, keyed by nothing: one detection at a time. */
export function createRunRegistry() {
	let current = null;
	return {
		start(manifest, work) {
			const job = {
				id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
				phase: "running",
				startedAt: new Date().toISOString(),
				finishedAt: null,
				error: null,
				progress: null,
				report: null
			};
			current = job;
			job.report = { startedAt: job.startedAt, ...manifest, models: [] };
			const done = (async () => {
				try {
					job.report.models = await work(job.report, (message) => {
						job.progress = message;
					});
				} catch (error) {
					job.error = error instanceof Error ? error.message : String(error);
				} finally {
					job.phase = job.error === null ? "done" : "error";
					job.finishedAt = new Date().toISOString();
					job.report.finishedAt = job.finishedAt;
				}
			})();
			return { job, done };
		},
		current: () => current
	};
}

/** Read a request body, bounded so a malformed client cannot exhaust memory. */
async function readBody(req, limit = 1024 * 1024) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw new Error("请求体过大");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * Register the probe's routes.
 *
 * @param ctx - the plugin context.
 * @param config - optional overrides for {@link DEFAULTS}.
 */
export function apply(ctx, config = {}) {
	const cfg = { ...DEFAULTS, ...config };
	const runs = createRunRegistry();

	const rejectRequest = (req) => {
		const connection = ctx.get("connection");
		const gate = connection?.requestRejection;
		return typeof gate === "function" ? gate.call(connection, req) : undefined;
	};

	const sendJson = (res, status, payload) => {
		res.statusCode = status;
		res.setHeader("content-type", "application/json; charset=utf-8");
		res.setHeader("cache-control", "no-store");
		res.end(JSON.stringify(payload));
	};

	ctx.effect(() =>
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/catalog`,
			handler: async (req, res) => {
				const rejection = rejectRequest(req);
				if (rejection !== undefined) {
					res.statusCode = rejection;
					res.end();
					return;
				}
				try {
					sendJson(res, 200, await listCandidates(ctx));
				} catch (error) {
					sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		})
	);

	ctx.effect(() =>
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/run`,
			handler: async (req, res) => {
				const rejection = rejectRequest(req);
				if (rejection !== undefined) {
					res.statusCode = rejection;
					res.end();
					return;
				}
				if (req.method === "GET") {
					const job = runs.current();
					if (job === null) {
						sendJson(res, 200, { phase: "idle" });
						return;
					}
					sendJson(res, 200, {
						id: job.id,
						phase: job.phase,
						startedAt: job.startedAt,
						finishedAt: job.finishedAt,
						error: job.error,
						progress: job.progress,
						report: job.report
					});
					return;
				}
				if (req.method !== "POST") {
					res.statusCode = 405;
					res.setHeader("allow", "GET, POST");
					res.end();
					return;
				}
				let body = {};
				try {
					const raw = await readBody(req);
					body = raw.trim().length === 0 ? {} : JSON.parse(raw);
				} catch (error) {
					sendJson(res, 400, { error: `无法解析请求体：${error instanceof Error ? error.message : String(error)}` });
					return;
				}
				const requested = parseModels(body.models);
				if (requested === null) {
					sendJson(res, 400, { error: "models 必须是 `provider/model` 形式的数组" });
					return;
				}
				const seeding = body.seed;
				const seed = Number.isFinite(Number(seeding)) ? Number(seeding) >>> 0 : Math.floor(Math.random() * 2 ** 32);
				let targets;
				try {
					targets = await resolveTargets(ctx, cfg, requested);
				} catch (error) {
					sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
					return;
				}
				if (targets.length === 0) {
					sendJson(res, 400, { error: "没有可探测的模型：所选模型都没有声明任何思考档位" });
					return;
				}
				const runCfg = { ...cfg, seed };
				const manifest = {
					provider: cfg.provider,
					seed,
					tasksPerLevel: taskWidth(cfg.tasksPerLevel),
					targets: targets.map((t) => ({ provider: t.provider, model: t.model, levels: t.levels }))
				};
				const { job } = runs.start(manifest, (report, onProgress) =>
					runDetection(ctx, targets, runCfg, onProgress, report)
				);
				sendJson(res, 202, { id: job.id, phase: job.phase, startedAt: job.startedAt });
			}
		})
	);

	ctx.logger?.info(
		"level-probe: ready (provider=%s, tasks/level=%s, models-at-once=%s)",
		cfg.provider.length > 0 ? cfg.provider : "(every configured provider)",
		taskWidth(cfg.tasksPerLevel),
		concurrencyWidth(cfg.concurrency)
	);
}
