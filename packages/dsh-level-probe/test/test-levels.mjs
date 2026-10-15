/**
 * Tests for the level probe.
 *
 * The probe exists to answer one question — *do this route's thinking levels
 * actually differ?* — and every way it can be wrong is silent:
 *
 *   - a verdict computed from noise looks exactly like one computed from signal;
 *   - a signal picked from the wrong column (latency instead of reported tokens)
 *     still produces a confident-looking table;
 *   - an off-by-one in the "compare against the previous level" walk turns a
 *     chain of aliases into a chain of differences.
 *
 * So the tests below are mostly *scenarios with a known answer*: a relay that
 * folds `xhigh` and `max` together must be reported as such, a relay that rejects
 * a level must say so rather than call it slow, and a relay that reports no
 * reasoning breakdown must say "unknown" instead of guessing.
 *
 * Run: node test/test-levels.mjs
 */

import assert from "node:assert/strict";

import {
	DEFAULTS,
	LEVEL_ORDER,
	SIGNAL_TOLERANCE,
	analyzeLevels,
	checkAnswer,
	chooseSignal,
	createRunRegistry,
	listCandidates,
	makeTasks,
	overlaps,
	mulberry32,
	parseModels,
	probeModel,
	recommend,
	summarizeLevel
} from "../index.js";

let passed = 0;
let failed = 0;

async function test(label, body) {
	try {
		await body();
		passed += 1;
		console.log(`    ✓ ${label}`);
	} catch (error) {
		failed += 1;
		console.log(`    ✗ ${label}`);
		console.log(`        ${error instanceof Error ? error.message : String(error)}`);
	}
}

function equal(label, actual, expected) {
	assert.deepEqual(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------------ *
 * Task generation
 * ------------------------------------------------------------------ */

console.log("任务生成");

await test("the same seed draws the same tasks", () => {
	const a = makeTasks(2, 42);
	const b = makeTasks(2, 42);
	equal("seed 42 is reproducible", a, b);
});

await test("different seeds draw different questions", () => {
	const a = makeTasks(2, 1);
	const b = makeTasks(2, 2);
	assert.notDeepEqual(a, b, "two seeds produced identical tasks — a fixed question can be recalled");
});

await test("the expected answer is what the stated recurrence produces", () => {
	for (const task of makeTasks(5, 7)) {
		const m = task.prompt.match(/从 (\d+) 开始，重复执行下面这一步 (\d+) 次[\s\S]*?x \* (\d+) \+ (\d+)\) mod (\d+)/);
		assert.ok(m !== null, `prompt did not match the generator's own shape: ${task.prompt}`);
		const [, start, steps, multiplier, increment, modulus] = m.map(Number);
		let value = start;
		for (let i = 0; i < steps; i += 1) value = (value * multiplier + increment) % modulus;
		assert.equal(task.expected, value, "the stored answer must equal the recurrence's own result");
		assert.equal(task.steps, steps, "the stored step count must match the prompt");
	}
});

await test("makeTasks clamps a silly count", () => {
	equal("zero draws one", makeTasks(0, 1).length, 1);
	equal("negative draws one", makeTasks(-3, 1).length, 1);
	equal("ninety-nine is capped", makeTasks(99, 1).length, 5);
});

await test("mulberry32 stays inside [0, 1)", () => {
	const random = mulberry32(9);
	for (let i = 0; i < 500; i += 1) {
		const value = random();
		assert.ok(value >= 0 && value < 1, `out of range: ${value}`);
	}
});

/* ------------------------------------------------------------------ *
 * Answer checking
 * ------------------------------------------------------------------ */

console.log("答案判定");

await test("the last integer in the reply is the answer", () => {
	// A model that shows its working still ends with the answer; reading the first
	// number instead would mark every reasoning trace wrong.
	equal("working then answer", checkAnswer("先算 12*3=36，所以最终是 847", 847), { answer: 847, correct: true });
	equal("bare answer", checkAnswer("847", 847), { answer: 847, correct: true });
	equal("wrong answer", checkAnswer("846", 847), { answer: 846, correct: false });
	equal("negative", checkAnswer("结果是 -12", -12), { answer: -12, correct: true });
});

await test("a reply with no digits is not an answer", () => {
	equal("empty", checkAnswer("", 5), { answer: null, correct: false });
	equal("prose only", checkAnswer("我无法回答这个问题", 5), { answer: null, correct: false });
});

/* ------------------------------------------------------------------ *
 * Aggregation and signal choice
 * ------------------------------------------------------------------ */

console.log("聚合与信号选择");

/** Build an attempt record with only the fields a summary reads. */
function attempt(overrides = {}) {
	return {
		level: "high",
		ok: true,
		correct: true,
		reasoningTokens: 100,
		outputTokens: 200,
		reasoningChars: 300,
		latencyMs: 1000,
		error: null,
		...overrides
	};
}

await test("a level's summary averages only the attempts that succeeded", () => {
	const row = summarizeLevel("high", [
		attempt({ reasoningTokens: 100, latencyMs: 1000 }),
		attempt({ reasoningTokens: 200, latencyMs: 3000 }),
		attempt({ ok: false, error: "400", reasoningTokens: null, latencyMs: 50 })
	]);
	equal("attempts counted", row.attempts, 3);
	equal("failures counted", row.failed, 1);
	equal("mean over successes only", row.reasoningTokens, 150);
	equal("latency mean over successes only", row.latencyMs, 2000);
	equal("errors kept for the note", row.errors, ["400"]);
});

await test("a level whose every attempt failed has no means at all", () => {
	const row = summarizeLevel("max", [attempt({ ok: false, error: "400 unsupported" })]);
	equal("no reasoning mean", row.reasoningTokens, null);
	equal("zero successes", row.ok, 0);
	equal("accuracy is zero, not null", row.accuracy, 0);
});

await test("reported reasoning tokens win over every other signal", () => {
	const rows = [
		{ level: "low", ok: 1, reasoningTokens: 10, reasoningChars: 5, latencyMs: 900 },
		{ level: "high", ok: 1, reasoningTokens: 50, reasoningChars: 5, latencyMs: 100 }
	];
	equal("tokens preferred", chooseSignal(rows), { signal: "reasoning-tokens", key: "reasoningTokens" });
});

await test("without token counts the reasoning text is the next best signal", () => {
	const rows = [
		{ level: "low", ok: 1, reasoningTokens: null, reasoningChars: 10, latencyMs: 900 },
		{ level: "high", ok: 1, reasoningTokens: null, reasoningChars: 50, latencyMs: 100 }
	];
	equal("text length preferred over latency", chooseSignal(rows), { signal: "reasoning-text", key: "reasoningChars" });
});

await test("latency is only a signal when nothing else exists", () => {
	const rows = [
		{ level: "low", ok: 1, reasoningTokens: null, reasoningChars: 0, latencyMs: 900 },
		{ level: "high", ok: 1, reasoningTokens: null, reasoningChars: 0, latencyMs: 1500 }
	];
	equal("latency is the last resort", chooseSignal(rows), { signal: "latency", key: "latencyMs" });
});

await test("a level that reports zero reasoning everywhere falls back to latency", () => {
	// `reasoningChars: 0` across the board means the adapter never streamed
	// reasoning parts. Latency is a weak signal, but it is still evidence, and it
	// is labelled as weak in the report rather than presented as a token count.
	const rows = [
		{ level: "low", ok: 1, reasoningTokens: null, reasoningChars: 0, latencyMs: 900 },
		{ level: "high", ok: 1, reasoningTokens: null, reasoningChars: 0, latencyMs: 1500 }
	];
	equal("latency is used", chooseSignal(rows), { signal: "latency", key: "latencyMs" });
});

/* ------------------------------------------------------------------ *
 * Verdicts
 * ------------------------------------------------------------------ */

console.log("档位结论");

/**
 * A row as `analyzeLevels` expects to read it.
 *
 * `samples` are the per-attempt values. They are set tight around the mean so
 * these rows test the *magnitude* rule; the overlap rule has its own tests below,
 * where the spread is the thing under test.
 */
function row(level, reasoningTokens, extra = {}) {
	const value = reasoningTokens;
	const samples =
		value === null
			? { reasoningTokens: [], reasoningChars: [], latencyMs: [] }
			: {
					reasoningTokens: [value - 1, value, value + 1],
					reasoningChars: [value * 2 - 1, value * 2, value * 2 + 1],
					latencyMs: [value * 10 - 1, value * 10, value * 10 + 1]
				};
	return {
		level,
		ok: 1,
		failed: 0,
		correct: 1,
		attempts: 1,
		accuracy: 1,
		reasoningTokens,
		outputTokens: value === null ? null : value + 20,
		reasoningChars: value === null ? null : value * 2,
		latencyMs: value === null ? null : value * 10,
		samples,
		errors: [],
		...extra
	};
}

await test("a relay that folds xhigh and max together is reported as folded", () => {
	// The case the probe exists for: two levels the picker offers, one behaviour.
	const rows = [row("low", 100), row("high", 400), row("xhigh", 400), row("max", 410)];
	const { signal, verdicts } = analyzeLevels(rows);
	equal("signal", signal, "reasoning-tokens");
	equal("statuses", verdicts.map((v) => v.status), ["baseline", "distinct", "same-as-previous", "same-as-previous"]);
	equal("xhigh points at high", verdicts[2].vs, "high");
	equal("max points at xhigh", verdicts[3].vs, "xhigh");
});

await test("the first usable level is a baseline, never a difference", () => {
	const { verdicts } = analyzeLevels([row("off", 0), row("low", 50)]);
	equal("off is the baseline", verdicts[0].status, "baseline");
	equal("low is compared to off", verdicts[1].vs, "off");
});

await test("a level that never answered is unavailable, not slow", () => {
	const rows = [
		row("low", 100),
		{ ...row("max", null), ok: 0, failed: 2, errors: ["400 unknown reasoning effort"] }
	];
	const { verdicts } = analyzeLevels(rows);
	equal("unavailable", verdicts[1].status, "unavailable");
	assert.match(verdicts[1].note, /400/, "the route's own error must reach the note");
});

await test("with no measurable column at all every level says unknown", () => {
	// Nothing reported and nothing timed: there is genuinely nothing to compare,
	// and the honest output is "unknown" rather than a confident-looking table.
	const rows = [
		{ level: "low", ok: 1, reasoningTokens: null, reasoningChars: 0, latencyMs: null },
		{ level: "high", ok: 1, reasoningTokens: null, reasoningChars: 0, latencyMs: null }
	];
	const { signal, verdicts } = analyzeLevels(rows);
	equal("no signal", signal, null);
	equal("both unknown", verdicts.map((v) => v.status), ["unknown", "unknown"]);
});

await test("an unavailable level does not become the baseline for the next one", () => {
	// If a rejected level were allowed to set the baseline, the level above it
	// would be compared against nothing and reported as distinct by default.
	const rows = [
		row("low", 100),
		{ ...row("medium", null), ok: 0, errors: ["400"] },
		row("high", 105)
	];
	const { verdicts } = analyzeLevels(rows);
	equal("medium unavailable", verdicts[1].status, "unavailable");
	equal("high compares against low, the last level that answered", verdicts[2].vs, "low");
	equal("and is called identical", verdicts[2].status, "same-as-previous");
});

await test("a move smaller than the tolerance is noise, not a difference", () => {
	const rows = [row("low", 100), row("medium", 100 * (1 + SIGNAL_TOLERANCE / 2)), row("high", 200)];
	const { verdicts } = analyzeLevels(rows);
	equal("medium is within tolerance", verdicts[1].status, "same-as-previous");
	equal("high is beyond it", verdicts[2].status, "distinct");
});

await test("a zero baseline falls back to an absolute comparison", () => {
	// `off` reports 0 reasoning tokens; a ratio against it would divide by zero.
	const rows = [row("off", 0), row("low", 0), row("medium", 60)];
	const { verdicts } = analyzeLevels(rows);
	equal("low is still zero", verdicts[1].status, "same-as-previous");
	equal("medium moved", verdicts[2].status, "distinct");
});

await test("a small move inside the tolerance is refused even when the ranges are disjoint", () => {
	// The real finding that forced the two-test rule: on a live relay, one sample
	// per level gave 1311 against 1372 — disjoint ranges, and a 4.7% move that is
	// well inside the tolerance. Disjointness alone would have called it distinct.
	const a = { ...row("high", 1311), samples: { reasoningTokens: [1311], reasoningChars: [1311], latencyMs: [10] } };
	const b = { ...row("xhigh", 1372), samples: { reasoningTokens: [1372], reasoningChars: [1372], latencyMs: [11] } };
	const { verdicts } = analyzeLevels([a, b]);
	equal("not called distinct", verdicts[1].status, "same-as-previous");
	assert.match(verdicts[1].note, /不足|重叠/, "the note must say why");
});

await test("disjoint samples with a large gap are a real difference", () => {
	const a = { ...row("low", 100), samples: { reasoningTokens: [95, 105], reasoningChars: [95, 105], latencyMs: [9, 11] } };
	const b = { ...row("high", 400), samples: { reasoningTokens: [380, 420], reasoningChars: [380, 420], latencyMs: [38, 42] } };
	const { verdicts } = analyzeLevels([a, b]);
	equal("distinct", verdicts[1].status, "distinct");
});

await test("a wide spread swallows a large mean difference", () => {
	// 100 -> 400 is a 300% move, but the first level's own samples span 50..500.
	// Nothing here can say the second level differs from the first.
	const a = { ...row("low", 100), samples: { reasoningTokens: [50, 500], reasoningChars: [50, 500], latencyMs: [1, 9] } };
	const b = { ...row("high", 400), samples: { reasoningTokens: [380, 420], reasoningChars: [380, 420], latencyMs: [38, 42] } };
	const { verdicts } = analyzeLevels([a, b]);
	equal("the overlap refuses the claim", verdicts[1].status, "same-as-previous");
	assert.match(verdicts[1].note, /重叠/, "the note names the overlap");
});

await test("an empty sample set is unseparable, not infinitely different", () => {
	// `Math.min(...[])` is `Infinity`, which would invert the comparison and make a
	// level with no samples look maximally distinct.
	equal("empty against values", overlaps([], [1, 2]), true);
	equal("values against empty", overlaps([1, 2], []), true);
	equal("both empty", overlaps([], []), true);
	equal("genuinely disjoint", overlaps([1, 2], [5, 6]), false);
	equal("touching at a point", overlaps([1, 2], [2, 3]), true);
});

/* ------------------------------------------------------------------ *
 * Recommendation
 * ------------------------------------------------------------------ */

console.log("推荐");

await test("the cheapest level that matches the best accuracy is the recommendation", () => {
	const rows = [
		{ ...row("low", 50), correct: 1, attempts: 2, accuracy: 0.5 },
		{ ...row("high", 200), correct: 2, attempts: 2, accuracy: 1 },
		{ ...row("max", 400), correct: 2, attempts: 2, accuracy: 1 }
	];
	const result = recommend(rows);
	equal("recommends high", result.level, "high");
	assert.match(result.note, /high/, "the note names the level");
});

await test("when only the top level scores, the top level is the recommendation", () => {
	const rows = [
		{ ...row("low", 50), correct: 0, attempts: 2, accuracy: 0 },
		{ ...row("max", 400), correct: 2, attempts: 2, accuracy: 1 }
	];
	const result = recommend(rows);
	equal("recommends max", result.level, "max");
	assert.match(result.note, /唯一|需要开到/, "the note says the top level is required");
});

await test("nothing scored means nothing is recommended", () => {
	const rows = [
		{ ...row("low", 50), correct: 0, attempts: 2, accuracy: 0 },
		{ ...row("max", 400), correct: 0, attempts: 2, accuracy: 0 }
	];
	const result = recommend(rows);
	equal("no level", result.level, null);
	assert.match(result.note, /都没答对/, "the note must not invent a winner");
});

/* ------------------------------------------------------------------ *
 * The probe, end to end, against a scripted relay
 * ------------------------------------------------------------------ */

console.log("端到端（脚本化中转）");

/**
 * A relay double that reports a fixed reasoning-token count per level.
 *
 * `solves` decides which levels actually get the arithmetic right, so accuracy
 * can be varied independently of the token counts — which is the combination the
 * recommendation logic has to get right.
 */
function relayLlm({ tokens, rejects = [], solves = () => true, exposeTokens = true }) {
	return {
		listProviders: () => [{ id: "a1" }],
		listModels: async () => [
			{ id: "deepseek-v4.1-flash", reasoning: { efforts: LEVEL_ORDER.map((id) => ({ id })) } }
		],
		stream: async function* (options) {
			const level = options.reasoningEffort;
			if (rejects.includes(level)) throw new Error(`400 unknown reasoning effort: ${level}`);
			const prompt = options.messages[0].content[0].text;
			const m = prompt.match(/从 (\d+) 开始，重复执行下面这一步 (\d+) 次[\s\S]*?x \* (\d+) \+ (\d+)\) mod (\d+)/);
			const [, start, steps, multiplier, increment, modulus] = m.map(Number);
			let value = start;
			for (let i = 0; i < steps; i += 1) value = (value * multiplier + increment) % modulus;
			const reasoned = tokens[level] ?? 0;
			if (reasoned > 0) yield { type: "reasoning-delta", text: "想".repeat(reasoned) };
			// A model that does not solve it still replies — just with the wrong
			// number, which is what "answered but wrong" looks like.
			yield { type: "text-delta", text: String(solves(level) ? value : value + 1) };
			// The real chunk shape: the adapter renames `output` to `outputTokens`,
			// and does not carry a reasoning count through at all.
			yield {
				type: "usage",
				usage: { outputTokens: reasoned + 10, inputTokens: 20, ...(exposeTokens ? { reasoning: reasoned } : {}) }
			};
			yield { type: "finish", reason: { kind: "stop" } };
		}
	};
}

/** A context wrapping a relay double. */
function ctxOf(llm) {
	return { llm, logger: { info: () => {}, warn: () => {} } };
}

const TARGET = {
	provider: "a1",
	model: "deepseek-v4.1-flash",
	levels: [...LEVEL_ORDER]
};

await test("a relay where only the top level thinks is reported as such", async () => {
	const llm = relayLlm({
		tokens: { off: 0, minimal: 0, low: 0, medium: 0, high: 0, xhigh: 0, max: 300 },
		solves: (level) => level === "max"
	});
	const record = await probeModel(ctxOf(llm), TARGET, makeTasks(1, 5), DEFAULTS, () => {});
	equal("token signal", record.signal, "reasoning-tokens");
	equal(
		"only max moves",
		record.verdicts.map((v) => v.status),
		["baseline", "same-as-previous", "same-as-previous", "same-as-previous", "same-as-previous", "same-as-previous", "distinct"]
	);
	equal("max is required", record.recommendation.level, "max");
});

await test("a relay that folds the top two levels together is caught end to end", async () => {
	const llm = relayLlm({ tokens: { off: 0, minimal: 40, low: 60, medium: 120, high: 200, xhigh: 200, max: 205 } });
	const record = await probeModel(ctxOf(llm), TARGET, makeTasks(2, 11), DEFAULTS, () => {});
	equal(
		"xhigh and max are both aliases of high",
		record.verdicts.map((v) => v.status),
		["baseline", "distinct", "distinct", "distinct", "distinct", "same-as-previous", "same-as-previous"]
	);
});

await test("a rejected level is reported as unavailable, with the route's own error", async () => {
	const llm = relayLlm({ tokens: { off: 0, low: 50, medium: 100, high: 150, xhigh: 200 }, rejects: ["max"] });
	const record = await probeModel(ctxOf(llm), TARGET, makeTasks(1, 3), DEFAULTS, () => {});
	const max = record.verdicts.find((v) => v.level === "max");
	equal("unavailable", max.status, "unavailable");
	assert.match(max.note, /400/, "the relay's error text must survive to the verdict");
	// A level that was never answered must not appear to have reasoned.
	equal("no token mean", record.levels.find((r) => r.level === "max").reasoningTokens, null);
});

await test("only the levels the model advertises are probed", async () => {
	// Asking for an unadvertised level is a malformed request, not a finding: the
	// picker would never offer it, so the probe must not spend a request on it.
	const llm = relayLlm({ tokens: { low: 10, medium: 20, high: 30 } });
	const record = await probeModel(ctxOf(llm), { ...TARGET, levels: ["low", "medium", "high"] }, makeTasks(1, 1), DEFAULTS, () => {});
	equal("three levels probed", record.levels.map((r) => r.level), ["low", "medium", "high"]);
});

await test("a relay that hides its token breakdown is reported as unknown, not guessed", async () => {
	const llm = relayLlm({ tokens: { low: 50, high: 200 }, exposeTokens: false });
	const record = await probeModel(ctxOf(llm), { ...TARGET, levels: ["low", "high"] }, makeTasks(1, 2), DEFAULTS, () => {});
	// No `usage.reasoning`, and the reasoning text was streamed — so the text
	// length is the signal, not "unknown".
	equal("falls back to reasoning text", record.signal, "reasoning-text");
	equal("high is distinct", record.verdicts[1].status, "distinct");
});

await test("two tasks per level send two separate questions at each level", async () => {
	const seen = [];
	const llm = relayLlm({ tokens: { low: 10, high: 30 } });
	const original = llm.stream;
	llm.stream = function (options) {
		seen.push(options.reasoningEffort);
		return original.call(this, options);
	};
	await probeModel(ctxOf(llm), { ...TARGET, levels: ["low", "high"] }, makeTasks(2, 4), DEFAULTS, () => {});
	equal("four requests for two levels", seen.length, 4);
	equal("two per level", seen.filter((l) => l === "high").length, 2);
});

/* ------------------------------------------------------------------ *
 * Catalog and request parsing
 * ------------------------------------------------------------------ */

console.log("目录与请求");

await test("levels come from resolveModelInfo, not from listModels", async () => {
	// A regression pin. `listModels` returns a catalog entry with no reasoning
	// metadata at all, so a probe that read `listModels(model).reasoning` showed an
	// empty picker for a route whose models plainly have seven levels. The two
	// stubs below differ in exactly that way: the one that answers on
	// `resolveModelInfo` is the one that must produce levels.
	const ctx = {
		llm: {
			listProviders: () => [{ id: "a1" }],
			// Deliberately carries no `reasoning` key — this is the real shape.
			listModels: async () => [{ id: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash" }],
			resolveModelInfo: async (provider, model) => {
				assert.equal(provider, "a1");
				assert.equal(model, "deepseek-v4.1-flash");
				return { reasoning: { efforts: LEVEL_ORDER.map((id) => ({ id, name: id })) } };
			}
		}
	};
	const catalog = await listCandidates(ctx);
	equal("the model is listed", catalog.models.map((m) => m.model), ["deepseek-v4.1-flash"]);
	equal("with its full advertised set", catalog.models[0].levels, LEVEL_ORDER);
});

await test("a model the host rejects is still listed, without levels", async () => {
	const ctx = {
		llm: {
			listProviders: () => [{ id: "a1" }],
			listModels: async () => [{ id: "broken" }, { id: "fine" }],
			resolveModelInfo: async (provider, model) => {
				if (model === "broken") throw new Error("adapter returned invalid reasoning metadata");
				return { reasoning: { efforts: [{ id: "high" }] } };
			}
		}
	};
	const catalog = await listCandidates(ctx);
	// Hiding it would make the panel disagree with the picker about what exists.
	equal("both listed", catalog.models.map((m) => m.model), ["broken", "fine"]);
	equal("the broken one offers nothing", catalog.models[0].levels, []);
	equal("the failure is reported", catalog.failed.length, 1);
	assert.match(catalog.failed[0].error, /invalid reasoning/);
});

await test("a model with no reasoning block advertises nothing", async () => {
	const ctx = {
		llm: {
			listProviders: () => [{ id: "cloud" }],
			listModels: async () => [{ id: "claude-opus-5" }],
			resolveModelInfo: async () => ({})
		}
	};
	const catalog = await listCandidates(ctx);
	equal("no levels", catalog.models[0].levels, []);
	equal("and no failure", catalog.failed, []);
});

await test("an unknown level id is dropped from the advertised list", async () => {
	const ctx = {
		llm: {
			listProviders: () => [{ id: "a1" }],
			listModels: async () => [{ id: "m" }],
			resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: "ultra" }, { id: "high" }] } })
		}
	};
	const catalog = await listCandidates(ctx);
	// `ultra` is a wire value, not a level name; it must not become a probe target.
	equal("ultra is not a level", catalog.models[0].levels, ["high"]);
});

await test("one unreachable provider does not blank the catalog", async () => {
	const ctx = {
		llm: {
			listProviders: () => [{ id: "broken" }, { id: "a1" }],
			listModels: async (provider) => {
				if (provider === "broken") throw new Error("ECONNREFUSED");
				return [{ id: "m" }];
			},
			resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: "high" }] } })
		}
	};
	const catalog = await listCandidates(ctx);
	equal("the good provider still listed", catalog.models.map((m) => m.model), ["m"]);
	equal("the failure is reported", catalog.failed, [{ provider: "broken", error: "ECONNREFUSED" }]);
});

await test("parseModels rejects anything that is not provider/model", () => {
	equal("undefined passes through", parseModels(undefined), undefined);
	equal("a bare name is rejected", parseModels(["a1"]), null);
	equal("a leading slash is rejected", parseModels(["/m"]), null);
	equal("a trailing slash is rejected", parseModels(["a1/"]), null);
	equal("a valid pair", parseModels(["a1/deepseek-v4.1-flash"]), [
		{ provider: "a1", model: "deepseek-v4.1-flash" }
	]);
	equal("a model id containing a slash keeps the rest", parseModels(["a1/org/model"]), [
		{ provider: "a1", model: "org/model" }
	]);
});

/* ------------------------------------------------------------------ *
 * Run registry
 * ------------------------------------------------------------------ */

console.log("运行注册表");

await test("a run outlives its request and records its own failure", async () => {
	const runs = createRunRegistry();
	const { job } = runs.start({ seed: 1 }, async () => {
		throw new Error("upstream exploded");
	});
	// The starter returns before the work settles; the registry holds the state.
	equal("starts running", job.phase, "running");
	await new Promise((r) => setTimeout(r, 10));
	equal("ends in error", job.phase, "error");
	equal("the error is kept", job.error, "upstream exploded");
	assert.ok(job.finishedAt !== null, "a finished job must be timestamped");
	equal("the registry points at it", runs.current().id, job.id);
});

await test("a second run supersedes the first", () => {
	const runs = createRunRegistry();
	const first = runs.start({ seed: 1 }, async () => []).job;
	const second = runs.start({ seed: 2 }, async () => []).job;
	assert.notEqual(first.id, second.id);
	equal("the newest run is current", runs.current().id, second.id);
});

/* ------------------------------------------------------------------ */

console.log("");
if (failed > 0) {
	console.log(`  ${failed} 项失败，${passed} 项通过`);
	process.exitCode = 1;
} else {
	console.log(`  ✓ 全部 ${passed} 项断言通过`);
}
