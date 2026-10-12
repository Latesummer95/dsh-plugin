/**
 * degradation-probe — a sidebar panel that measures whether a model route has
 * been silently weakened ("降智").
 *
 * Why this exists: a gateway can swap a strong model for a weak one, cap its
 * reasoning budget, or degrade it only on hard tasks while easy prompts still
 * look fine. Single chat probes cannot see that, because the degradation is
 * task-dependent. The signal that does work is a small set of problems whose
 * answers can be verified independently, split into tiers — because the two
 * failure shapes are different:
 *
 *   - a route that fails even the easy tier has been swapped for a weaker model;
 *   - a route that passes easy but misses hard items has had its reasoning
 *     budget capped while its surface behaviour still looks normal.
 *
 * This module is the Node half. It owns the battery and scores the results, so
 * the verdict is never computed in the browser and cannot be flattered by the
 * panel. The browser half only renders what this returns.
 *
 * @module dsh-degradation-probe
 */

const name = "degradation-probe";

/**
 * Services this plugin requires.
 *
 * Both must be declared: Cordis throws on reading an undeclared service
 * (`cannot get property "webServer" without inject`), so the route would fail
 * to mount and the panel would 404 with no obvious cause.
 *
 * - `webServer` — hosts the probe route.
 * - `llm` — the configured model routes, so probes exercise the real route
 *   (including any prompt injection, reasoning cap, or throttling it applies)
 *   rather than a hand-rolled HTTP call that would bypass them.
 */
const inject = ["webServer", "llm"];

/** Route prefix owned by this plugin. Served outside `/api` behind an origin gate. */
const ROUTE_PREFIX = "/degradation-probe";

/**
 * The probe battery.
 *
 * Every answer was computed independently (Python) and is reproducible. Tiers
 * are the point: `easy` items fail when a route is swapped for a small model,
 * `hard` items fail when a capable model is denied the reasoning it needs.
 */
const PROBES = [
	{
		id: "arith",
		tier: "easy",
		label: "两位数乘法",
		prompt: "What is 847 * 6593? Reply with only the number.",
		answer: "5584271"
	},
	{
		id: "char",
		tier: "easy",
		label: "字符计数",
		prompt: "How many times does the letter r appear in the word strawrrberry? Reply with only the number.",
		answer: "5"
	},
	{
		id: "rev",
		tier: "easy",
		label: "字符串反转",
		kind: "word",
		prompt: "Reverse the string abcdefghij. Reply with only the reversed string.",
		answer: "jihgfedcba"
	},
	{
		id: "batball",
		tier: "medium",
		label: "球拍与球",
		prompt: "A bat and a ball cost 1.10 in total. The bat costs 1.00 more than the ball. How much does the ball cost, in cents? Reply with only the number.",
		answer: "5"
	},
	{
		id: "idempotent",
		tier: "hard",
		label: "同余方程计数",
		prompt: "How many integers n with 0 < n < 1000 satisfy n^2 congruent to n modulo 1000? Reply with only the number.",
		answer: "3"
	},
	{
		id: "trailing",
		tier: "hard",
		label: "12 进制末尾零",
		prompt: "How many trailing zeros does 100 factorial have when written in base 12? Reply with only the number.",
		answer: "48"
	},
	{
		id: "digitsum",
		tier: "hard",
		label: "2^1000 数字和",
		prompt: "What is the sum of the decimal digits of 2 to the power 1000? Reply with only the number.",
		answer: "1366"
	},
	{
		id: "stirling",
		tier: "hard",
		label: "球入盒计数",
		prompt: "In how many ways can 10 distinct balls be placed into 3 identical boxes so that no box is empty? Reply with only the number.",
		answer: "9330"
	}
];

/** Conservative defaults; every field is overridable from the profile patch. */
const DEFAULTS = {
	/** Provider route to probe. */
	provider: "a1",
	/** Substring filter selecting which of that provider's models to probe. */
	modelPattern: "gpt-6",
	/** Explicit `provider/model` list; overrides provider + modelPattern when set. */
	models: [],
	/** Reasoning effort forwarded to the route; `null` omits the field entirely. */
	reasoningEffort: "high",
	/** Max output tokens per probe. */
	maxTokens: 8000,
	/** Per-probe wall clock budget in milliseconds. */
	timeoutMs: 120000,
	/** Probes to run concurrently. Keep low: some gateways throttle aggressively. */
	concurrency: 2,
	/** Pause between probes in milliseconds. */
	spacingMs: 1500
};

/**
 * Extract the final numeric token from a reply.
 *
 * Probes ask for a bare number but a model may still wrap it in prose or a boxed
 * answer. Taking the last number in the text matches how these answers actually
 * appear and is the same rule the manual investigation used.
 *
 * @param text - the model's raw reply.
 * @returns the normalised answer, or `undefined` when no number is present.
 */
function extractNumber(text) {
	const matches = String(text ?? "").match(/-?\d[\d,]*/g);
	if (matches === null || matches.length === 0) return undefined;
	return matches[matches.length - 1].replace(/,/g, "");
}

/**
 * Normalise a free-form answer for the word probes.
 *
 * @param text - the model's raw reply.
 * @returns the lowercased reply with surrounding quoting and punctuation removed.
 */
function extractWord(text) {
	return String(text ?? "")
		.trim()
		.toLowerCase()
		.replace(/^[`"'\s]+/, "")
		.replace(/[`"'.\s]+$/, "");
}

/**
 * Grade one reply against one probe.
 *
 * @param probe - the probe definition.
 * @param text - the model's raw reply.
 * @returns the extracted answer and whether it matches.
 */
function grade(probe, text) {
	const got = probe.kind === "word" ? extractWord(text) : extractNumber(text);
	return { got: got === undefined ? null : got, ok: got === probe.answer };
}

/**
 * Consume one `llm.stream` iterable into text, usage, and terminal reason.
 *
 * Usage arrives as its own chunk type rather than riding on `finish`, and a
 * failed call terminates as a `finish` chunk whose reason is `{kind:'error'}`
 * rather than by throwing, so both shapes are handled here.
 *
 * @param stream - the async iterable returned by the llm service.
 * @returns the accumulated text, finish reason, and usage.
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
 * Enumerate the model routes to probe.
 *
 * @param ctx - the plugin context carrying the llm service.
 * @param config - the resolved plugin config.
 * @returns a promise of `{provider, model}` pairs.
 */
async function resolveTargets(ctx, config) {
	if (Array.isArray(config.models) && config.models.length > 0) {
		return config.models.map((entry) => {
			const at = String(entry).indexOf("/");
			if (at < 0) return { provider: config.provider, model: String(entry) };
			return { provider: String(entry).slice(0, at), model: String(entry).slice(at + 1) };
		});
	}
	const models = await ctx.llm.listModels(config.provider);
	const pattern = String(config.modelPattern ?? "");
	const filtered = pattern.length === 0 ? models : models.filter((m) => String(m.id).includes(pattern));
	return filtered.map((m) => ({ provider: config.provider, model: m.id }));
}

/**
 * Run one probe against one route.
 *
 * @param ctx - the plugin context.
 * @param target - the `{provider, model}` pair under test.
 * @param probe - one entry of {@link PROBES}.
 * @param config - the resolved plugin config.
 * @returns a structured result record.
 */
async function runProbe(ctx, target, probe, config) {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.timeoutMs);
	try {
		const options = {
			provider: target.provider,
			model: target.model,
			// `content` is a readonly array of content blocks, not a bare string:
			// adapters call `content.some(...)` on it, so a string fails with
			// "content.some is not a function" and every probe looks like a miss.
			messages: [{ role: "user", content: [{ type: "text", text: probe.prompt }] }],
			maxTokens: config.maxTokens,
			signal: controller.signal
		};
		if (config.reasoningEffort !== null && config.reasoningEffort !== undefined) {
			options.reasoningEffort = config.reasoningEffort;
		}
		const { text, reasoning, usage, reason } = await drainStream(ctx.llm.stream(options));
		const graded = grade(probe, text);
		return {
			id: probe.id,
			label: probe.label,
			tier: probe.tier,
			expected: probe.answer,
			got: graded.got,
			ok: graded.ok,
			ms: Date.now() - started,
			reasoningTokens: usage?.reasoningTokens ?? null,
			outputTokens: usage?.outputTokens ?? null,
			finish: reason?.kind ?? null,
			failure: reason?.failure === undefined ? null : String(reason.failure.message ?? reason.failure),
			reasoningChars: reasoning.length,
			reply: String(text ?? "").slice(0, 160)
		};
	} catch (error) {
		return {
			id: probe.id,
			label: probe.label,
			tier: probe.tier,
			expected: probe.answer,
			got: null,
			ok: false,
			ms: Date.now() - started,
			error: error instanceof Error ? error.message : String(error),
			reply: ""
		};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Score one route's probe results into a verdict.
 *
 * The tier breakdown drives the verdict, because that is what distinguishes a
 * swapped model from a capped one. `errorRate` is reported separately so a route
 * that is merely unreachable is not mistaken for a stupid one.
 *
 * @param results - the probe records for one route.
 * @returns the score, tier breakdown, and verdict.
 */
function score(results) {
	const total = results.length;
	const errored = results.filter((row) => row.error !== undefined).length;
	const passed = results.filter((row) => row.ok).length;
	const byTier = (tier) => {
		const rows = results.filter((row) => row.tier === tier);
		return { total: rows.length, passed: rows.filter((row) => row.ok).length };
	};
	const easy = byTier("easy");
	const medium = byTier("medium");
	const hard = byTier("hard");

	let verdict;
	if (errored === total && total > 0) verdict = "unreachable";
	else if (easy.total > 0 && easy.passed < easy.total) verdict = "degraded";
	else if (hard.total > 0 && hard.passed < hard.total) verdict = "capped";
	else if (medium.total > 0 && medium.passed < medium.total) verdict = "weak";
	else verdict = "healthy";

	return {
		total,
		passed,
		errored,
		ratio: total === 0 ? 0 : passed / total,
		easy,
		medium,
		hard,
		verdict
	};
}

/**
 * Run the battery over a list of targets, bounded and paced.
 *
 * @param ctx - the plugin context.
 * @param targets - the routes to probe.
 * @param config - the resolved plugin config.
 * @param onModel - called with each finished model report.
 * @returns a promise of model reports.
 */
async function runBattery(ctx, targets, config, onModel) {
	const reports = [];
	const queue = [...targets];
	const worker = async () => {
		for (;;) {
			const target = queue.shift();
			if (target === undefined) return;
			const results = [];
			for (const probe of PROBES) {
				results.push(await runProbe(ctx, target, probe, config));
				if (config.spacingMs > 0) await new Promise((r) => setTimeout(r, config.spacingMs));
			}
			const report = { provider: target.provider, model: target.model, score: score(results), results };
			reports.push(report);
			onModel?.(report);
		}
	};
	const width = Math.max(1, Math.min(Number(config.concurrency) || 1, 8));
	await Promise.all(Array.from({ length: width }, worker));
	return reports;
}

/**
 * Register the probe route and log the battery on load.
 *
 * @param ctx - the plugin context.
 * @param config - optional overrides for {@link DEFAULTS}.
 */
function apply(ctx, config = {}) {
	const cfg = { ...DEFAULTS, ...config };
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

	ctx.effect(() => ctx.webServer.register({
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
			let targets;
			try {
				targets = await resolveTargets(ctx, cfg);
			} catch (error) {
				sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
				return;
			}
			const report = {
				startedAt: new Date().toISOString(),
				provider: cfg.provider,
				modelPattern: cfg.modelPattern,
				reasoningEffort: cfg.reasoningEffort,
				probes: PROBES.map((p) => ({ id: p.id, label: p.label, tier: p.tier })),
				models: []
			};
			try {
				report.models = await runBattery(ctx, targets, cfg);
			} catch (error) {
				sendJson(res, 500, { error: error instanceof Error ? error.message : String(error), ...report });
				return;
			}
			report.finishedAt = new Date().toISOString();
			sendJson(res, 200, report);
		}
	}), `degradation-probe: ${ROUTE_PREFIX}/run`);

	ctx.logger?.info(
		"degradation-probe: %d probes ready (%d easy, %d medium, %d hard), provider=%s pattern=%s",
		PROBES.length,
		PROBES.filter((p) => p.tier === "easy").length,
		PROBES.filter((p) => p.tier === "medium").length,
		PROBES.filter((p) => p.tier === "hard").length,
		cfg.provider,
		cfg.modelPattern
	);
}

export { DEFAULTS, PROBES, ROUTE_PREFIX, apply, extractNumber, extractWord, grade, inject, name, score };
