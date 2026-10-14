/**
 * fingerprint-probe — identify which model an API route actually serves.
 *
 * ## The question this answers
 *
 * A relay can claim to serve one model while routing to another. This plugin
 * checks that claim without relying on the API's own metadata: it asks the model
 * to write a few hundred "random" integers, and compares the distribution it
 * produces against a bank of reference models. Language models are not uniform
 * samplers — their preferred values, bands and last digits are stable enough to
 * rank candidates.
 *
 * ## Why it is not a chat probe
 *
 * Nothing here asks the model what it is. Self-reports are worth exactly what
 * the relay's config says, and a system prompt can assert any identity. The
 * signal used instead is a by-product of generation that the endpoint does not
 * control or even see as a claim.
 *
 * ## What the verdict is and is not
 *
 * The result is a **closed-set ranking among the 58 reference models**. An
 * out-of-bank model still receives a nearest candidate and a confidence share,
 * so the output is evidence about which known model the route most resembles —
 * not proof of identity. The panel says this next to the numbers rather than in
 * a footnote, because the failure mode of a fingerprint tool is being believed
 * more than it deserves.
 *
 * Three valid answers are required for a calibrated verdict. Fewer yields an
 * explicit partial ranking with no confidence attached.
 *
 * ## Provenance
 *
 * Algorithm and reference data are ported from Ikaleio/lm-detector (MIT), pinned
 * to a commit and verified against real reference samples in `test/`. See
 * `NOTICE.md`.
 *
 * @module dsh-fingerprint-probe
 */

import { generateChallenges, LANGUAGE_IDS, LANGUAGE_LABELS } from "./lib/challenge.js";
import { loadReference, loadBankMeta, cacheStatus, UPSTREAM } from "./lib/data.js";
import { analyzeOutputs, parseNumbers, REQUIRED_OUTPUTS } from "./lib/detector.js";

const name = "fingerprint-probe";

/** Route prefix owned by this plugin. Served outside `/api` behind an origin gate. */
const ROUTE_PREFIX = "/fingerprint-probe";

/**
 * Services this plugin requires.
 *
 * `llm` is used rather than raw HTTP so a detection exercises the same route the
 * agent does — including its auth, reasoning cap and throttling. A hand-rolled
 * request could reach an upstream the configured route never touches, which
 * would answer a different question than the one asked.
 */
const inject = ["webServer", "llm"];

/** Conservative defaults; every field is overridable from the profile patch. */
const DEFAULTS = {
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
	 * Challenge languages to draw from; empty means all five.
	 *
	 * The reference bank was collected with these prompt environments, so the
	 * language is the one axis of "what to detect" this probe has. Restricting
	 * it answers a narrower question — "what does this route look like in
	 * Chinese" — at a proportionally smaller cost.
	 */
	languages: [],
	/** Reasoning effort forwarded to the route; `null` omits the field entirely. */
	reasoningEffort: null,
	/** Max output tokens per challenge. 292–332 integers need room, not depth. */
	maxTokens: 8000,
	/** Per-request wall clock budget. Generation is a single long completion. */
	timeoutMs: 180000,
	/** Models to probe concurrently, 1–{@link MAX_CONCURRENCY}. Gateways throttle hard, so the default is one at a time. */
	concurrency: 1,
	/** Pause between models in milliseconds. */
	spacingMs: 1500,
	/**
	 * Replacement challenges per failed slot.
	 *
	 * A calibrated verdict needs three valid answers, and a gateway can drop one
	 * mid-stream for reasons that say nothing about the model. Without a
	 * replacement, a single transport blip downgrades the whole round to an
	 * uncalibrated ranking; with one, the round is simply re-asked. Bounded so a
	 * genuinely uncooperative model cannot spin.
	 */
	replacements: 1
};

/**
 * Minimum valid integers for an answer to count.
 *
 * Mirrors the detector's own rule (`max(80, ceil(0.55 * expected))`): the
 * threshold is part of how the reference bank was built, so relaxing it here
 * would score answers the ranker was never fitted to accept.
 */
function minimumNumbers(expected) {
	return Math.max(80, Math.ceil((expected || 0) * 0.55));
}

/**
 * Turn `provider/model` (or a bare model id) strings into targets.
 *
 * @param entries - the requested selection.
 * @param fallbackProvider - provider used for entries with no `/`.
 * @returns the parsed targets.
 */
function parseSelection(entries, fallbackProvider) {
	return entries.map((entry) => {
		const at = String(entry).indexOf("/");
		if (at < 0) return { provider: fallbackProvider, model: String(entry) };
		return { provider: String(entry).slice(0, at), model: String(entry).slice(at + 1) };
	});
}

/**
 * Resolve which models to probe.
 *
 * Precedence, highest first: the panel's explicit selection, then a pinned
 * `config.models` list, then the profile's own configured routes
 * (`config.provider` when set, otherwise every provider `llm` reports,
 * optionally narrowed by `config.modelPattern`). The panel always sends a
 * selection, so a detection never silently grades a different set than the
 * user ticked.
 *
 * The last step is what keeps this plugin free of a baked-in vendor id: it
 * reads the catalog `llm` built from the profile, so the default is "what this
 * machine is actually configured with".
 *
 * @param ctx - the plugin context.
 * @param config - the resolved plugin config.
 * @param requested - optional explicit selection from the request.
 * @returns the `{provider, model}` pairs to probe.
 */
async function resolveTargets(ctx, config, requested) {
	if (Array.isArray(requested) && requested.length > 0) return parseSelection(requested, config.provider);
	if (Array.isArray(config.models) && config.models.length > 0) return parseSelection(config.models, config.provider);
	const pattern = String(config.modelPattern ?? "");
	const targets = [];
	const failed = [];
	for (const provider of configuredProviders(ctx, config)) {
		try {
			for (const model of await ctx.llm.listModels(provider)) {
				const id = String(model?.id ?? "");
				if (id.length === 0) continue;
				if (pattern.length > 0 && !id.includes(pattern)) continue;
				targets.push({ provider, model: id });
			}
		} catch (error) {
			// One unreachable route must not blank the default selection, but a
			// total failure has to surface: an empty list would otherwise read
			// as "you configured no models".
			failed.push(`${provider}（${error instanceof Error ? error.message : String(error)}）`);
		}
	}
	if (targets.length === 0 && failed.length > 0) {
		throw new Error(`无法读取已配置的模型：${failed.join("；")}`);
	}
	return targets;
}

/**
 * The provider routes the profile has configured.
 *
 * An explicit `config.provider` wins; otherwise this is whatever `llm` reports
 * as configured, so the plugin never names a vendor the profile may not define.
 *
 * @param ctx - the plugin context.
 * @param config - the resolved plugin config.
 * @returns provider ids, possibly empty when nothing is configured.
 */
function configuredProviders(ctx, config) {
	const explicit = String(config?.provider ?? "").trim();
	if (explicit.length > 0) return [explicit];
	const listed = ctx.llm?.listProviders?.() ?? [];
	const ids = listed
		.map((p) => String(p?.id ?? p?.provider ?? p?.name ?? ""))
		.filter((id) => id.length > 0);
	return Array.from(new Set(ids));
}

/**
 * The languages a round may draw from.
 *
 * Absent means every language; an explicit selection is filtered to known ids,
 * so a stale client cannot ask for a template that does not exist.
 *
 * @param ids - requested language ids, or `undefined` for "all".
 * @returns known language ids, in the canonical order; empty means all.
 */
function resolveLanguages(ids) {
	if (!Array.isArray(ids)) return [];
	const wanted = new Set(ids.map((id) => String(id).trim()));
	return LANGUAGE_IDS.filter((id) => wanted.has(id));
}

/**
 * Describe the language menu for the panel.
 *
 * @returns serialisable descriptors.
 */
function describeLanguages() {
	return LANGUAGE_IDS.map((id) => ({ id, label: LANGUAGE_LABELS[id] ?? id }));
}

/**
 * List every provider/model the panel can offer.
 *
 * A provider whose catalog fails is reported with its error and skipped rather
 * than failing the whole listing: one unreachable route must not hide the models
 * that are reachable.
 *
 * @param ctx - the plugin context.
 * @returns `{providers, models, failed}`.
 */
async function listCandidates(ctx) {
	const providers = (ctx.llm.listProviders?.() ?? [])
		.map((p) => String(p?.id ?? p?.provider ?? p?.name ?? ""))
		.filter((id) => id.length > 0);
	const models = [];
	const failed = [];
	for (const provider of providers) {
		try {
			for (const model of await ctx.llm.listModels(provider)) {
				models.push({ provider, model: String(model.id), name: model.name ?? null });
			}
		} catch (error) {
			failed.push({ provider, error: error instanceof Error ? error.message : String(error) });
		}
	}
	models.sort((a, b) =>
		a.provider === b.provider ? a.model.localeCompare(b.model) : a.provider.localeCompare(b.provider)
	);
	return { providers, models, failed };
}

/**
 * Collect a bounded request body as UTF-8 text.
 *
 * @param req - the incoming request.
 * @returns the body text, or `""` when absent/oversized.
 */
async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.byteLength;
		if (size > 1024 * 1024) {
			// Drain rather than destroy: the client may still be writing, and an
			// abrupt close would surface as a connection error instead of a 4xx.
			req.resume?.();
			return "";
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, size).toString("utf8");
}

/**
 * Read and parse a POST body once.
 *
 * The request stream can only be consumed a single time, so the model and the
 * language selection have to come out of this one read — reading the body twice
 * would silently lose whichever field came second.
 *
 * @param req - the incoming request.
 * @returns the parsed object, or `{}` when absent, oversized, or not an object.
 */
async function readRequest(req) {
	const text = await readBody(req);
	if (text.trim().length === 0) return {};
	try {
		const body = JSON.parse(text);
		return body !== null && typeof body === "object" && !Array.isArray(body) ? body : {};
	} catch {
		return {};
	}
}

/**
 * Read the requested model selection out of a parsed body.
 *
 * @param body - the parsed POST body.
 * @returns the selection, or `undefined` to fall back to the configured targets.
 */
function selectionFrom(body) {
	const raw = body?.models ?? body?.targets;
	if (!Array.isArray(raw)) return undefined;
	const cleaned = raw.map((m) => String(m).trim()).filter((m) => m.length > 0);
	return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Read the requested language selection out of a parsed body.
 *
 * Absent means "every language" (an older client, or a scripted run). A
 * present-but-empty selection is reported as an empty array rather than
 * silently upgraded to all five: the route turns that into a 400, because
 * drawing from every language when the user asked for none would be the
 * expensive version of ignoring them.
 *
 * @param body - the parsed POST body.
 * @returns the requested language ids, or `undefined` when the field is absent.
 */
function languagesFrom(body) {
	const raw = body?.languages;
	if (!Array.isArray(raw)) return undefined;
	return resolveLanguages(raw);
}

/**
 * Read the requested model selection from a POST body.
 *
 * @param req - the incoming request.
 * @returns the selection, or `undefined` to fall back to the configured targets.
 */
async function readSelection(req) {
	return selectionFrom(await readRequest(req));
}

/**
 * Drain an LLM stream into text plus its termination reason.
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
 * Ask one model for one sequence of numbers.
 *
 * A challenge that never completes and one that completes with too few numbers
 * are different failures: the first says nothing about the route's identity,
 * the second says the model would not perform the task. Both are reported with
 * their own message so the panel can show why an answer was dropped.
 *
 * @param ctx - the plugin context.
 * @param target - the `{provider, model}` pair under test.
 * @param challenge - one generated challenge.
 * @param config - the resolved plugin config.
 * @returns a per-challenge record.
 */
async function elicit(ctx, target, challenge, config) {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.timeoutMs);
	try {
		const options = {
			provider: target.provider,
			model: target.model,
			// `content` is a readonly array of content blocks, not a bare string:
			// adapters call `content.some(...)`, so a string throws and every
			// challenge looks like a miss.
			messages: [{ role: "user", content: [{ type: "text", text: challenge.prompt }] }],
			maxTokens: config.maxTokens,
			signal: controller.signal
		};
		if (config.reasoningEffort !== null && config.reasoningEffort !== undefined) {
			options.reasoningEffort = config.reasoningEffort;
		}
		const { text, reasoning, usage, reason } = await drainStream(ctx.llm.stream(options));
		const numbers = parseNumbers(text);
		const minimum = minimumNumbers(challenge.expected_count);
		const failed = reason !== undefined && reason.kind !== "stop" && reason.kind !== "max-tokens";
		const accepted = !failed && numbers.length >= minimum;
		return {
			challengeId: challenge.id,
			language: challenge.language,
			expected: challenge.expected_count,
			minimum,
			accepted,
			/**
			 * Whether the model actually produced an answer.
			 *
			 * This separates "the stream died" from "the model declined or
			 * rambled": the first is worth re-asking because no answer exists,
			 * the second is the model's answer and re-rolling it would bias the
			 * sample toward runs that happened to comply.
			 */
			answered: text.trim().length > 0,
			numbers: numbers.length,
			ms: Date.now() - started,
			outputTokens: usage?.outputTokens ?? null,
			finish: reason?.kind ?? null,
			/**
			 * The full raw reply, kept even when rejected.
			 *
			 * The scorer re-derives acceptance from the text itself, and it needs
			 * the real reply to report an accurate `parsed_numbers`. Blanking it
			 * here would make every rejection look like an empty answer and would
			 * collapse the "0/3 valid" denominator to "0/0". It is stripped from
			 * the payload sent to the browser.
			 */
			text,
			preview: accepted ? "" : String(text).slice(0, 400),
			error: failed
				? String(reason?.failure?.message ?? reason?.kind)
				: accepted
					? null
					: `有效整数不足：${numbers.length} < ${minimum}`
		};
	} catch (error) {
		return {
			challengeId: challenge.id,
			language: challenge.language,
			expected: challenge.expected_count,
			minimum: minimumNumbers(challenge.expected_count),
			accepted: false,
			answered: false,
			numbers: 0,
			ms: Date.now() - started,
			outputTokens: null,
			finish: null,
			text: "",
			preview: "",
			error: error instanceof Error ? error.message : String(error)
		};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Probe one model and score it.
 *
 * @param ctx - the plugin context.
 * @param target - the `{provider, model}` pair under test.
 * @param reference - `{detector, bank}` from {@link loadReference}.
 * @param config - the resolved plugin config.
 * @param onProgress - optional status callback.
 * @returns the model's record.
 */
async function probeModel(ctx, target, reference, config, onProgress) {
	const label = `${target.provider}/${target.model}`;
	const attempts = [];
	// Counts stay distinct within the round so a replacement cannot duplicate a
	// challenge still in play, matching how the reference bank was collected.
	const used = [];
	const draw = () => {
		const [challenge] = generateChallenges(1, used, config.languages);
		used.push(challenge.expected_count);
		return challenge;
	};

	for (let slot = 0; slot < REQUIRED_OUTPUTS; slot += 1) {
		let challenge = draw();
		let attempt;
		for (let retry = 0; retry <= config.replacements; retry += 1) {
			onProgress?.(
				`${label}：挑战 ${slot + 1}/${REQUIRED_OUTPUTS}（${LANGUAGE_LABELS[challenge.language] ?? challenge.language}，要求 ${challenge.expected_count} 个整数）` +
					(retry > 0 ? `，第 ${retry + 1} 次尝试` : "")
			);
			attempt = await elicit(ctx, target, challenge, config);
			// Only a transport-level failure is worth re-asking: the model never
			// answered, so this is a fresh draw rather than a second opinion on
			// the same question. A model that answered but wrote too few numbers
			// has given its answer, and re-rolling it would bias the sample.
			if (attempt.accepted || attempt.answered) break;
			if (retry < config.replacements) {
				challenge = draw();
				if (config.spacingMs > 0) await new Promise((r) => setTimeout(r, config.spacingMs));
			}
		}
		attempts.push(attempt);
		if (slot < REQUIRED_OUTPUTS - 1 && config.spacingMs > 0) await new Promise((r) => setTimeout(r, config.spacingMs));
	}

	// All three attempts are handed to the scorer, not just the accepted ones:
	// it applies the acceptance rule itself and reports `used_outputs` against
	// the real attempt count. Pre-filtering here made a round where every
	// challenge failed report "0/0 valid answers" instead of "0/3".
	const accepted = attempts.filter((a) => a.accepted);
	const analysis = analyzeOutputs(
		attempts.map((a) => ({ text: a.text, expected_count: a.expected })),
		reference.bank,
		reference.detector,
		{ allowPartial: true }
	);
	return {
		provider: target.provider,
		model: target.model,
		accepted: accepted.length,
		total: REQUIRED_OUTPUTS,
		attempts: attempts.map(({ text, ...rest }) => rest),
		analysis
	};
}

/**
 * Upper bound on how many models may be probed at once.
 *
 * Gateways here throttle hard, and a higher bound mostly buys 429s — which the
 * panel reports honestly as "refused, never reached the model" rather than as a
 * failure, but which still costs the round its samples. The sibling coding probe
 * uses the same bound; keeping them equal means one config value means the same
 * thing in both halves of the merged panel.
 */
const MAX_CONCURRENCY = 2;

/**
 * Clamp a configured concurrency into the usable range.
 *
 * A missing, zero, negative, or non-numeric value means "one at a time", which
 * is what the plugin did unconditionally before this was honoured.
 *
 * @param value - the configured `concurrency`.
 * @returns an integer in `[1, MAX_CONCURRENCY]`.
 */
function concurrencyWidth(value) {
	return Math.max(1, Math.min(Number(value) || 1, MAX_CONCURRENCY));
}

/**
 * Run `worker` over `items` with at most `width` in flight.
 *
 * The worker owns its own error handling: one lane that throws would otherwise
 * abandon the items still queued behind it. `runDetection`'s worker catches per
 * target for exactly that reason.
 *
 * @param items - the work items.
 * @param width - maximum lanes.
 * @param worker - `async (item, remaining) => void`, where `remaining` is how
 *   many items are still queued (0 for the last one drawn).
 * @returns a promise that settles when every item has been handed out.
 */
async function runPool(items, width, worker) {
	const queue = [...items];
	const lanes = Math.max(1, Math.min(width, queue.length));
	const run = async () => {
		for (;;) {
			const item = queue.shift();
			if (item === undefined) return;
			await worker(item, queue.length);
		}
	};
	await Promise.all(Array.from({ length: lanes }, run));
}

/**
 * Run a detection over the resolved targets.
 *
 * Models run `config.concurrency` at a time (default 1, i.e. the serial
 * behaviour this always had). Concurrency is the only lever here that shortens
 * a multi-model round without changing what is measured: each model still gets
 * its full three challenges, and a throttled request is still counted as
 * refused rather than as a failure.
 *
 * With `concurrency > 1` the report's model order is completion order, not
 * target order — the array is the live partial result a polling panel reads,
 * so a finished model has to appear the moment it finishes.
 *
 * @param ctx - the plugin context.
 * @param targets - the `{provider, model}` pairs to probe.
 * @param config - the resolved plugin config.
 * @param onProgress - optional status callback.
 * @param report - optional live report; each finished model is pushed into it
 *   as it completes so a polling reader sees partial results.
 * @returns the report's model list.
 */
async function runDetection(ctx, targets, config, onProgress, report) {
	const reference = await loadReference({ onProgress });
	const models = report?.models ?? [];
	const width = concurrencyWidth(config.concurrency);
	// The index travels with the target rather than being recovered by
	// `indexOf`, which would report the same position twice for a duplicated
	// `provider/model`.
	await runPool(targets.map((target, index) => ({ target, index })), width, async ({ target, index }, remaining) => {
		onProgress?.(`[${index + 1}/${targets.length}] ${target.provider}/${target.model}`);
		try {
			models.push(await probeModel(ctx, target, reference, config, onProgress));
		} catch (error) {
			models.push({
				provider: target.provider,
				model: target.model,
				accepted: 0,
				total: REQUIRED_OUTPUTS,
				attempts: [],
				analysis: null,
				error: error instanceof Error ? error.message : String(error)
			});
		}
		// Only pace when something is still queued: waiting after the last item
		// of a round is pure latency.
		if (remaining > 0 && config.spacingMs > 0) await new Promise((r) => setTimeout(r, config.spacingMs));
	});
	return models;
}

/**
 * Create the single-slot detection registry.
 *
 * A detection takes minutes, and the panel that started it can be unmounted at
 * any moment: the main slot renders one panel at a time, and the workspace
 * clears the active panel when the session changes. Tying the run to the
 * request that started it would discard the work exactly when it is most
 * expensive, which is why a conversation switch used to look as though the
 * probe had never run.
 *
 * The registry decouples the two. `start` returns at once, the job keeps
 * running with no reader attached, and the panel reads progress back through
 * GET.
 *
 * @returns the registry.
 */
function createRunRegistry() {
	let current = null;
	return {
		/**
		 * Start a job and hand back its descriptor immediately.
		 *
		 * @param manifest - the run's manifest, echoed into the report.
		 * @param work - the async detection.
		 * @returns `{job, done}`; `done` settles when the detection does.
		 */
		start(manifest, work) {
			const job = {
				id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
				phase: "running",
				startedAt: new Date().toISOString(),
				finishedAt: null,
				error: null,
				report: null
			};
			current = job;
			// The report is built up as the detection goes, not only at the end:
			// the panel polls GET, so a run that is re-opened halfway through
			// shows the models that have already finished.
			job.report = { startedAt: job.startedAt, ...manifest, models: [] };
			// Deliberately not awaited: the job has to outlive the request that
			// started it. Every failure path is recorded on the job, so nothing
			// is left to reject unhandled.
			const done = (async () => {
				try {
					job.report.models = await work(job.report);
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
		/** The most recent job, or `null` when nothing has run. */
		current: () => current
	};
}

/**
 * Register the detection routes.
 *
 * @param ctx - the plugin context.
 * @param config - optional overrides for {@link DEFAULTS}.
 */
function apply(ctx, config = {}) {
	const cfg = { ...DEFAULTS, ...config };
	/** One detection at a time: a second POST supersedes the first. */
	const runs = createRunRegistry();

	/**
	 * Apply the host's own request gate (origin fence + browser login).
	 *
	 * The gate must be read and invoked per request, and it must be *bound* to
	 * the connection service: `requestRejection` reads `this.trustedHosts` and
	 * `this.browserAuth`, so calling it detached throws and the webserver turns
	 * that throw into an opaque 400 for every request.
	 *
	 * @param req - the incoming request.
	 * @returns a rejection status, or `undefined` when the request may proceed.
	 */
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

	ctx.effect(
		() =>
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
					if (req.method !== "POST" && req.method !== "GET") {
						res.statusCode = 405;
						res.setHeader("allow", "GET, POST");
						res.end();
						return;
					}
					// The body is read exactly once — see {@link readRequest}.
					const body = req.method === "POST" ? await readRequest(req) : {};
					const requested = req.method === "POST" ? selectionFrom(body) : undefined;
					const askedLanguages = req.method === "POST" ? languagesFrom(body) : undefined;
					if (req.method === "POST" && Array.isArray(body.languages) && askedLanguages.length === 0) {
						// An explicit empty selection is a client bug, not a
						// request to draw from every language.
						sendJson(res, 400, { error: "请至少选择一种挑战语言" });
						return;
					}
					// An absent field means every language; an explicit one is
					// already filtered to known ids.
					const languages = askedLanguages === undefined ? [] : askedLanguages;
					let targets;
					try {
						targets = await resolveTargets(ctx, cfg, requested);
					} catch (error) {
						sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
						return;
					}
					const manifest = {
						provider: cfg.provider,
						modelPattern: cfg.modelPattern ?? null,
						reasoningEffort: cfg.reasoningEffort,
						timeoutMs: cfg.timeoutMs,
						// The effective value, not the configured one: the knob is
						// clamped, and a panel that echoed 8 back would explain
						// nothing about why the round ran two at a time.
						concurrency: concurrencyWidth(cfg.concurrency),
						upstream: UPSTREAM,
						cache: cacheStatus(),
						languages: languages.length > 0 ? languages : [...LANGUAGE_IDS],
						targets: targets.map((t) => `${t.provider}/${t.model}`)
					};
					// GET reports the current job's state, or what WOULD run when
					// nothing has run yet, and always returns immediately. Running
					// the detection here would make a plain curl hang for minutes
					// and look like a broken route.
					if (req.method === "GET") {
						const job = runs.current();
						if (job === null) {
							sendJson(res, 200, { phase: "idle", ...manifest });
							return;
						}
						sendJson(res, 200, {
							phase: job.phase,
							id: job.id,
							startedAt: job.startedAt,
							finishedAt: job.finishedAt,
							error: job.error,
							...(job.report ?? manifest)
						});
						return;
					}
					// POST starts the job and returns at once. The panel polls GET,
					// so navigating away mid-run no longer throws the work away.
					const { job, done } = runs.start(manifest, (live) =>
						runDetection(ctx, targets, { ...cfg, languages }, (message) => ctx.logger?.info("fingerprint-probe: %s", message), live)
					);
					// Keep the promise observed even though the response has already
					// been sent, so a rejected detection cannot surface as an
					// unhandled rejection.
					done.catch(() => {});
					sendJson(res, 202, { phase: job.phase, id: job.id, startedAt: job.startedAt, ...manifest });
				}
			}),
		`fingerprint-probe: ${ROUTE_PREFIX}/run`
	);

	// Reference-bank summary and model catalog. Kept off the run route so
	// opening the panel never triggers a download or a detection.
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "exact",
				path: `${ROUTE_PREFIX}/models`,
				handler: async (req, res) => {
					const rejection = rejectRequest(req);
					if (rejection !== undefined) {
						res.statusCode = rejection;
						res.end();
						return;
					}
					if (req.method !== "GET") {
						res.statusCode = 405;
						res.setHeader("allow", "GET");
						res.end();
						return;
					}
					try {
						const catalog = await listCandidates(ctx);
						const bank = loadBankMeta();
						// The language menu needs no download and no detection, so
						// it ships with the payload the picker already fetches:
						// one request populates both selectors.
						const defaultLanguages = cfg.languages.length > 0
							? resolveLanguages(cfg.languages)
							: [...LANGUAGE_IDS];
						let defaults = [];
						try {
							defaults = (await resolveTargets(ctx, cfg)).map((t) => `${t.provider}/${t.model}`);
						} catch {
							defaults = [];
						}
						// Fall back to the catalog only when the config asked for no
						// restriction at all. A pattern that matches nothing is a
						// deliberate narrowing whose empty result is the answer —
						// silently preselecting something else would hide a stale
						// config behind a plausible-looking run.
						const restricted = String(cfg.provider ?? "").trim().length > 0
							|| String(cfg.modelPattern ?? "").trim().length > 0
							|| (Array.isArray(cfg.models) && cfg.models.length > 0);
						if (defaults.length === 0 && !restricted) {
							defaults = catalog.models.map((m) => `${m.provider}/${m.model}`);
						}
						sendJson(res, 200, {
							provider: cfg.provider,
							modelPattern: cfg.modelPattern ?? null,
							reasoningEffort: cfg.reasoningEffort,
							upstream: UPSTREAM,
							cache: cacheStatus(),
							languages: describeLanguages(),
							defaultLanguages: defaultLanguages.length > 0 ? defaultLanguages : [...LANGUAGE_IDS],
							reference: {
								builtAt: bank.built_at,
								models: bank.models.map((m) => ({
									id: m.id,
									displayName: m.display_name,
									family: m.family,
									familyName: m.family_name,
									responseCount: m.response_count
								}))
							},
							defaults,
							...catalog
						});
					} catch (error) {
						sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
					}
				}
			}),
		`fingerprint-probe: ${ROUTE_PREFIX}/models`
	);

	ctx.logger?.info(
		"fingerprint-probe: ready (provider=%s, languages=%s, reference bank %s, upstream %s@%s)",
		cfg.provider.length > 0 ? cfg.provider : "(every configured provider)",
		cfg.languages.length > 0 ? cfg.languages.join("/") : "(all)",
		loadBankMeta().built_at,
		UPSTREAM.repo,
		UPSTREAM.commit.slice(0, 12)
	);
}

export {
	DEFAULTS,
	MAX_CONCURRENCY,
	ROUTE_PREFIX,
	UPSTREAM,
	apply,
	cacheStatus,
	concurrencyWidth,
	configuredProviders,
	describeLanguages,
	elicit,
	generateChallenges,
	inject,
	languagesFrom,
	listCandidates,
	loadReference,
	minimumNumbers,
	name,
	parseSelection,
	probeModel,
	readRequest,
	readSelection,
	resolveLanguages,
	resolveTargets,
	runDetection,
	runPool,
	selectionFrom
};
