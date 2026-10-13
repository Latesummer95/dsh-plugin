/**
 * Tests for the fingerprint probe.
 *
 * Three kinds of check matter here, and only the third proves anything:
 *
 * 1. **Unit checks** on the pure helpers (parsing, thresholds, selection
 *    parsing, route wiring) — fast, no network.
 * 2. **Decoder checks** that the frozen binary decodes to the shapes the ranker
 *    indexes into. A decode error surfaces as `undefined` arithmetic, which
 *    would otherwise look like a plausible score.
 * 3. **Calibration checks** that re-score *real reference answers* and assert
 *    each lands on its own model. This is the one that matters: a porting error
 *    in the feature maths does not throw, it just ranks everyone wrongly. Without
 *    this check a completely broken detector looks like a working one.
 *
 * The calibration check needs the upstream reference data (16 MB), which is not
 * vendored. It is skipped with an explicit message when absent, and the suite
 * still passes — so a missing download cannot be mistaken for a green run.
 *
 * Run: node test/test-detector.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	DEFAULTS,
	ROUTE_PREFIX,
	UPSTREAM,
	apply,
	inject,
	minimumNumbers,
	parseSelection,
	probeModel,
	readSelection
} from "../index.js";
import { generateChallenges } from "../lib/challenge.js";
import {
	REQUIRED_OUTPUTS,
	analyzeOutputs,
	calibrateRanking,
	decodeDetector,
	supportsDetector
} from "../lib/detector.js";
import { countNumbers, parseNumbers, hellingerFeature, orderedBlockFeature } from "../lib/fingerprint-core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = join(HERE, "..");
const BANK_META = join(PACKAGE, "data", "bank-meta.json");

/**
 * The shipped bank metadata.
 *
 * Read once at the top because the activation checks need it too: `apply` logs
 * the bank's build stamp, and asserting that is what proves the plugin found its
 * own data files rather than merely loading.
 */
const bank = JSON.parse(readFileSync(BANK_META, "utf8"));

/** Detector cache location, mirroring `lib/data.js`. */
function detectorFile() {
	const home = process.env.DSH_HOME ?? join(process.env.HOME ?? "", ".dsh");
	return join(home, "cache", "fingerprint-probe", `shared_detector-${UPSTREAM.commit.slice(0, 12)}.bin`);
}

/** Upstream reference answers, used only by the calibration check. */
function referenceFile() {
	return process.env.FPD_REFERENCE ?? join(PACKAGE, "test", "fixtures", "unified_reference.jsonl");
}

let passed = 0;
let failed = 0;
let skipped = 0;

/**
 * Run one named check.
 *
 * @param label - the check description.
 * @param fn - the assertion body.
 */
function test(label, fn) {
	try {
		fn();
		passed += 1;
		console.log(`  ✓ ${label}`);
	} catch (error) {
		failed += 1;
		console.log(`  ✗ ${label}`);
		console.log(`      ${error.message}`);
	}
}

/** Mark a check as skipped, with the reason visible in the output. */
function skip(label, reason) {
	skipped += 1;
	console.log(`  – ${label} (跳过：${reason})`);
}

// ---------------------------------------------------------------- parsing

console.log("整数解析");

test("only letters split a run, so blank lines and separators do not", () => {
	// Whitespace and punctuation are transparent: a model that wraps its output
	// across lines, or separates with commas, still yields one run. Only a
	// letter ends the current run, which is what keeps surrounding prose out.
	assert.deepEqual(parseNumbers("1 2 3\n\n50 60 70 80 90 100"), [1, 2, 3, 50, 60, 70, 80, 90, 100]);
});

test("takes the longest run when prose splits the reply", () => {
	const text = "Sure, here is a first attempt:\n1 2 3\n\nActually, let me redo that:\n" + Array.from({ length: 20 }, (_, i) => i + 100).join(" ");
	assert.equal(parseNumbers(text).length, 20);
	assert.equal(parseNumbers(text)[0], 100);
});

test("drops out-of-range values but keeps the run", () => {
	// 356 and 0 are outside 1..355; the run continues across them.
	assert.deepEqual(parseNumbers("5 356 7 0 9"), [5, 7, 9]);
});

test("a letter splits runs, so prose does not extend the sequence", () => {
	const numbers = parseNumbers("Here are 3 values: 10 20 30");
	// "3" is in range and precedes a letter, so the longest run is 10 20 30.
	assert.deepEqual(numbers, [10, 20, 30]);
});

test("markdown fences and headings do not merge into the sequence", () => {
	assert.deepEqual(parseNumbers("```\n11 22 33\n```"), [11, 22, 33]);
});

test("a reply with no in-range numbers parses to empty", () => {
	assert.deepEqual(parseNumbers("I cannot help with that."), []);
	assert.deepEqual(parseNumbers(""), []);
});

test("comma-separated values parse as one run", () => {
	assert.deepEqual(parseNumbers("7, 8, 9, 10"), [7, 8, 9, 10]);
});

// ---------------------------------------------------------------- features

console.log("特征构造");

test("counts index from VALUE_MIN", () => {
	const counts = countNumbers([1, 1, 355]);
	assert.equal(counts.length, 355);
	assert.equal(counts[0], 2);
	assert.equal(counts[354], 1);
});

test("the Hellinger feature is unit-plausible and smoothed", () => {
	const feature = hellingerFeature(countNumbers([1, 2, 3]));
	assert.equal(feature.length, 355);
	// Smoothing means an unobserved value still gets a positive mass, so the
	// log-likelihood of a gap is finite.
	assert.ok(feature.every((v) => v > 0), "every bin must carry smoothing mass");
	assert.ok(feature.every(Number.isFinite));
});

test("the ordered-block feature has 4x16 plus 10 last-digit bins", () => {
	const feature = orderedBlockFeature(Array.from({ length: 300 }, (_, i) => (i % 355) + 1));
	assert.equal(feature.length, 4 * 16 + 10);
	assert.ok(feature.every(Number.isFinite));
});

test("within the challenge range the feature tracks composition, not length", () => {
	// Smoothing (alpha=0.5 over 355 bins) adds a fixed 177.5 pseudo-count, so at
	// tiny N the embedding is length-dominated. Real answers are 292-332 long,
	// where the smoothing is negligible: the same proportions at the two ends of
	// the range must land in nearly the same place, or the bank's 36 references
	// (collected at various counts) could not be pooled at all.
	const shape = (n) => hellingerFeature(countNumbers(Array.from({ length: n }, (_, i) => (i % 10) + 1)));
	const low = shape(292);
	const high = shape(332);
	const drift = Math.max(...low.map((v, i) => Math.abs(v - high[i])));
	assert.ok(drift < 0.02, `proportional inputs drifted by ${drift}`);

	// Composition, by contrast, must move it a lot — otherwise every input would
	// score the same and the ranker would be noise.
	const skewed = hellingerFeature(countNumbers(Array.from({ length: 292 }, (_, i) => (i < 200 ? 1 : 300))));
	const composition = Math.max(...low.map((v, i) => Math.abs(v - skewed[i])));
	assert.ok(composition > 0.05, `different compositions differed by only ${composition}`);
});

// ---------------------------------------------------------------- thresholds

console.log("判据阈值");

test("the minimum mirrors the detector rule", () => {
	// max(80, ceil(0.55 * expected)) — the floor dominates below 146.
	assert.equal(minimumNumbers(300), 165);
	assert.equal(minimumNumbers(292), 161);
	assert.equal(minimumNumbers(100), 80);
	assert.equal(minimumNumbers(0), 80);
	assert.equal(minimumNumbers(undefined), 80);
});

test("three answers are required for a calibrated verdict", () => {
	assert.equal(REQUIRED_OUTPUTS, 3);
});

// ---------------------------------------------------------------- selection

console.log("模型选择解析");

test("a bare model id takes the fallback provider", () => {
	assert.deepEqual(parseSelection(["gpt-6-astra"], "a1"), [{ provider: "a1", model: "gpt-6-astra" }]);
});

test("provider/model splits on the first slash only", () => {
	assert.deepEqual(parseSelection(["openrouter/anthropic/claude-5"], "a1"), [
		{ provider: "openrouter", model: "anthropic/claude-5" }
	]);
});

test("a selection body is read from `models`", async () => {
	const req = (async function* () {
		yield Buffer.from(JSON.stringify({ models: ["a1/gpt-6-astra", "  a1/grok-4.6  "] }));
	})();
	assert.deepEqual(await readSelection(req), ["a1/gpt-6-astra", "a1/grok-4.6"]);
});

test("a body with no model list falls back to config", async () => {
	const req = (async function* () {
		yield Buffer.from(JSON.stringify({ other: 1 }));
	})();
	assert.equal(await readSelection(req), undefined);
});

test("malformed JSON does not throw", async () => {
	const req = (async function* () {
		yield Buffer.from("{not json");
	})();
	assert.equal(await readSelection(req), undefined);
});

test("an oversized body is refused rather than buffered", async () => {
	const req = (async function* () {
		yield Buffer.alloc(2 * 1024 * 1024);
	})();
	assert.equal(await readSelection(req), undefined);
});

// ---------------------------------------------------------------- wiring

console.log("插件接线");

test("the route prefix is plugin-owned and outside /api", () => {
	assert.equal(ROUTE_PREFIX, "/fingerprint-probe");
	assert.ok(!ROUTE_PREFIX.startsWith("/api"));
});

test("the plugin requires the web server and the llm service", () => {
	assert.deepEqual([...inject].sort(), ["llm", "webServer"]);
});

test("reasoning effort defaults to omitted, not a guessed level", () => {
	// Sending an effort the route does not accept would fail every challenge and
	// look like an unreachable model. Omission is the safe default.
	assert.equal(DEFAULTS.reasoningEffort, null);
});

/**
 * Drive `apply` against a fake context and return the captured routes.
 *
 * This is the check that catches a plugin that composes fine but throws on
 * activation — a missing import or a typo in `apply` is invisible to every
 * check above and shows up in production as "the panel is simply not there".
 *
 * @param overrides - context members to override.
 * @returns `{routes, logs}`.
 */
function mountRoutes(overrides = {}) {
	const routes = new Map();
	const logs = [];
	const ctx = {
		effect: (fn) => fn(),
		get: () => undefined,
		logger: {
			info: (...args) => logs.push(args.join(" ")),
			warn: (...args) => logs.push(args.join(" "))
		},
		llm: {
			listProviders: () => [{ id: "a1" }],
			listModels: async () => [{ id: "gpt-6-astra" }, { id: "gpt-6-sol" }],
			stream: async function* () {
				yield { type: "text-delta", text: "1 2 3" };
				yield { type: "finish", reason: { kind: "stop" } };
			}
		},
		webServer: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } },
		...overrides
	};
	apply(ctx);
	return { routes, logs };
}

test("apply activates and registers both routes", () => {
	const { routes, logs } = mountRoutes();
	assert.deepEqual([...routes.keys()].sort(), [`${ROUTE_PREFIX}/models`, `${ROUTE_PREFIX}/run`]);
	// The activation log is the only startup evidence an operator gets; if it
	// does not name the reference build, a bank mismatch is undiagnosable.
	assert.ok(logs.some((line) => line.includes(bank.built_at)), `activation log missing build stamp: ${logs.join(" | ")}`);
});

test("apply registers exact routes, so no other path is shadowed", () => {
	const { routes } = mountRoutes();
	for (const route of routes.values()) assert.equal(route.kind, "exact");
});

/** Minimal response double that records what a handler wrote. */
function fakeResponse() {
	const record = { statusCode: 0, headers: {}, body: "" };
	return {
		record,
		setHeader: (name, value) => { record.headers[name] = value; },
		end: (body) => { record.body = body ?? ""; },
		get statusCode() { return record.statusCode; },
		set statusCode(value) { record.statusCode = value; }
	};
}

/** Minimal request double over a fixed body. */
function fakeRequest(method, body) {
	const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
	return {
		method,
		async *[Symbol.asyncIterator]() { yield* chunks; },
		resume() {}
	};
}

test("GET on the run route reports the plan without probing", async () => {
	const { routes } = mountRoutes();
	const res = fakeResponse();
	await routes.get(`${ROUTE_PREFIX}/run`).handler(fakeRequest("GET"), res);
	assert.equal(res.record.statusCode, 200);
	const payload = JSON.parse(res.record.body);
	assert.deepEqual(payload.targets, ["a1/gpt-6-astra", "a1/gpt-6-sol"]);
	assert.ok(payload.upstream.commit, "the plan must name the pinned upstream commit");
});

test("the models route lists the reference bank without downloading it", async () => {
	const { routes } = mountRoutes();
	const res = fakeResponse();
	await routes.get(`${ROUTE_PREFIX}/models`).handler(fakeRequest("GET"), res);
	assert.equal(res.record.statusCode, 200);
	const payload = JSON.parse(res.record.body);
	assert.equal(payload.reference.models.length, bank.models.length);
	assert.equal(payload.reference.builtAt, bank.built_at);
	// Listing must not touch the network: the detector is 4 MB and opening a
	// panel should never start that download.
	assert.ok("cache" in payload);
});

test("an unsupported method is refused rather than treated as a run", async () => {
	const { routes } = mountRoutes();
	const res = fakeResponse();
	await routes.get(`${ROUTE_PREFIX}/run`).handler(fakeRequest("DELETE"), res);
	assert.equal(res.record.statusCode, 405);
	assert.equal(res.record.headers.allow, "GET, POST");
});

test("a request the host gate rejects never reaches the probe", async () => {
	let listed = false;
	const { routes } = mountRoutes({
		get: () => ({ requestRejection: () => 401 }),
		llm: { listProviders: () => { listed = true; return []; }, listModels: async () => [] }
	});
	const res = fakeResponse();
	await routes.get(`${ROUTE_PREFIX}/models`).handler(fakeRequest("GET"), res);
	assert.equal(res.record.statusCode, 401);
	assert.equal(listed, false, "the gate must run before any work");
});

test("a provider whose catalog fails is reported, not fatal", async () => {
	const { routes } = mountRoutes({
		llm: {
			listProviders: () => [{ id: "a1" }, { id: "broken" }],
			listModels: async (provider) => {
				if (provider === "broken") throw new Error("route unreachable");
				return [{ id: "gpt-6-astra" }];
			}
		}
	});
	const res = fakeResponse();
	await routes.get(`${ROUTE_PREFIX}/models`).handler(fakeRequest("GET"), res);
	const payload = JSON.parse(res.record.body);
	assert.equal(payload.models.length, 1);
	assert.equal(payload.failed.length, 1);
	assert.match(payload.failed[0].error, /unreachable/);
});

// ---------------------------------------------------------------- detector binary

console.log("检测器二进制");

const DETECTOR = detectorFile();
const HAVE_DETECTOR = existsSync(DETECTOR);

/**
 * The decoded detector, or `null` when the cache is absent.
 *
 * Decoded once at the top because the retry checks below need a real artifact to
 * score against: a stub would let a broken scoring path pass.
 */
const DETECTOR_ARTIFACT = HAVE_DETECTOR ? decodeDetector(new Uint8Array(readFileSync(DETECTOR))) : null;

if (!HAVE_DETECTOR) {
	skip("detector decodes", `未缓存 ${DETECTOR}（先运行一次检测，或运行 npm run fetch-data）`);
} else {
	const bytes = new Uint8Array(readFileSync(DETECTOR));
	const detector = DETECTOR_ARTIFACT;

	test("the cached bytes match the pinned checksum", () => {
		const digest = createHash("sha256").update(bytes).digest("hex");
		assert.equal(digest, UPSTREAM.detectorSha256);
	});

	test("the header decodes into the ranker's expected shape", () => {
		assert.equal(detector.schema, "shared-detector-v2");
		assert.ok(Array.isArray(detector.model_ids) && detector.model_ids.length > 0);
		assert.equal(detector.model_ids.length, detector.ranker.lda_bias.length);
		assert.equal(detector.model_ids.length, detector.ranker.references.length);
		assert.equal(detector.model_ids.length, detector.ranker.positional.bias.length);
	});

	test("float arrays decode as arrays of finite numbers, not $f32 stubs", () => {
		// A missed substitution leaves `{$f32, n}` objects behind; arithmetic on
		// those yields NaN scores rather than an exception.
		const bias = detector.ranker.lda_bias;
		assert.ok(Array.isArray(bias));
		assert.ok(bias.every(Number.isFinite), "lda_bias must be finite numbers");
		assert.ok(detector.ranker.lda_weights[0].every(Number.isFinite));
		assert.ok(detector.ranker.positional.params[0].mean.every(Number.isFinite));
	});

	test("the detector binds to the shipped bank metadata", () => {
		assert.ok(
			supportsDetector(bank, detector),
			`bank ${bank.built_at} does not match detector ${detector.bank_built_at}`
		);
	});

	test("calibration is present and bound to this ranker", () => {
		assert.ok(detector.calibration, "the pinned release carries a calibration");
		assert.equal(detector.calibration.method, "ranking-temperature");
		assert.ok(Number.isFinite(detector.calibration.tau) && detector.calibration.tau > 0);
	});

	test("calibration rejects a foreign ranker instead of inventing confidence", () => {
		const foreign = { ...detector, base_sha256: "0".repeat(64) };
		assert.equal(calibrateRanking(new Array(detector.model_ids.length).fill(0), foreign), null);
	});

	test("calibration yields a normalised distribution over the bank", () => {
		const ranking = detector.model_ids.map((_, i) => (i === 3 ? 2 : 0));
		const probabilities = calibrateRanking(ranking, detector);
		assert.ok(probabilities, "calibration must apply");
		const total = probabilities.reduce((a, b) => a + b, 0);
		assert.ok(Math.abs(total - 1) < 1e-9, `probabilities summed to ${total}`);
		assert.ok(probabilities[3] > probabilities[0]);
	});

	// ------------------------------------------------------------ scoring paths

	console.log("评分路径");

	test("a valid three-answer round produces a calibrated verdict", () => {
		const answers = [0, 1, 2].map((i) => ({
			text: Array.from({ length: 300 }, (_, k) => ((k * 7 + i * 13) % 355) + 1).join(" "),
			expected_count: 300
		}));
		const result = analyzeOutputs(answers, bank, detector, { allowPartial: true });
		assert.equal(result.used_outputs, 3);
		assert.equal(result.decision, undefined, "three valid answers must be scorable");
		assert.ok(result.prediction.length > 0);
		assert.equal(result.probability_status, "reference_calibrated");
		assert.ok(result.results.length === detector.model_ids.length);
		assert.ok(result.results.every((r) => Number.isFinite(r.score)));
	});

	test("a short answer is rejected and reported, not silently scored", () => {
		const answers = [
			{ text: "1 2 3", expected_count: 300 },
			{ text: Array.from({ length: 300 }, (_, k) => ((k * 5) % 355) + 1).join(" "), expected_count: 300 },
			{ text: Array.from({ length: 300 }, (_, k) => ((k * 9) % 355) + 1).join(" "), expected_count: 300 }
		];
		const result = analyzeOutputs(answers, bank, detector, { allowPartial: true });
		assert.equal(result.used_outputs, 2);
		assert.equal(result.decision, "partial");
		assert.equal(result.probability, null, "a partial round must not carry confidence");
		assert.equal(result.diagnostics[0].accepted, false);
		assert.equal(result.diagnostics[0].parsed_numbers, 3);
		assert.equal(result.diagnostics[1].accepted, true);
	});

	test("fewer than three answers is unscorable rather than a confident guess", () => {
		const answers = [{ text: Array.from({ length: 300 }, (_, k) => (k % 355) + 1).join(" "), expected_count: 300 }];
		const result = analyzeOutputs(answers, bank, detector, {});
		assert.equal(result.decision, "unscorable");
		assert.equal(result.prediction_name, "暂不可评分");
		assert.equal(result.probability, null);
	});

	test("out-of-range integers are counted for diagnostics", () => {
		const answers = [
			{ text: "999 1000 5000", expected_count: 300 },
			{ text: Array.from({ length: 300 }, (_, k) => (k % 355) + 1).join(" "), expected_count: 300 },
			{ text: Array.from({ length: 300 }, (_, k) => (k % 355) + 1).join(" "), expected_count: 300 }
		];
		const result = analyzeOutputs(answers, bank, detector, { allowPartial: true });
		assert.equal(result.diagnostics[0].raw_out_of_range_count, 3);
		assert.equal(result.diagnostics[0].accepted, false);
	});

	test("a bank from another release is refused, not scored", () => {
		const foreign = { ...bank, built_at: "1999-01-01T00:00:00.000000+00:00" };
		assert.throws(() => analyzeOutputs([], foreign, detector, {}), /参考库与检测器不匹配/);
	});

	// ------------------------------------------------------------ calibration

	console.log("标定：真实参考样本自识别");

	const REFERENCE = referenceFile();
	if (!existsSync(REFERENCE)) {
		skip("reference answers identify their own model", `未找到 ${REFERENCE}`);
		console.log(`      下载：curl -sL -o "${REFERENCE}" https://raw.githubusercontent.com/${UPSTREAM.repo}/${UPSTREAM.commit}/data/unified_reference.jsonl`);
	} else {
		const byModel = new Map();
		for (const line of readFileSync(REFERENCE, "utf8").split("\n")) {
			if (!line.trim()) continue;
			const batch = JSON.parse(line);
			if (!byModel.has(batch.model.id)) byModel.set(batch.model.id, []);
			byModel.get(batch.model.id).push(...batch.samples);
		}

		test("the reference file covers the whole bank", () => {
			const missing = bank.models.filter((m) => !byModel.has(m.id)).map((m) => m.id);
			assert.equal(missing.length, 0, `reference data missing for: ${missing.join(", ")}`);
		});

		// The decisive check. Each model's own answers are fed back through the
		// ranker; a correct port puts the model first. A porting error in any
		// feature block shows up here as a wrong or scattered answer, while every
		// check above would still pass.
		const verdicts = [];
		for (const model of bank.models) {
			const samples = (byModel.get(model.id) ?? []).slice(0, REQUIRED_OUTPUTS);
			if (samples.length < REQUIRED_OUTPUTS) continue;
			const result = analyzeOutputs(
				samples.map((s) => ({ text: s.text, expected_count: s.expected_count })),
				bank,
				detector,
				{ allowPartial: true }
			);
			verdicts.push({ id: model.id, order: result.results.map((r) => r.model) });
		}

		test("every model's own answers rank it first", () => {
			const wrong = verdicts.filter((v) => v.order[0] !== v.id);
			assert.equal(
				wrong.length,
				0,
				`${wrong.length}/${verdicts.length} misidentified: ` +
					wrong
						.slice(0, 5)
						.map((w) => `${w.id}→${w.order[0]}`)
						.join(", ")
			);
		});

		test("every model's own answers rank it in the top three", () => {
			const wrong = verdicts.filter((v) => !v.order.slice(0, 3).includes(v.id));
			assert.equal(wrong.length, 0, `${wrong.length} outside top-3`);
		});

		test("the ranking separates the top candidate from the field", () => {
			// Self-identification is necessary but weak: a ranker that returns a
			// near-uniform vector could still put the right model first by luck.
			// Requiring a positive gap over the runner-up rules that out.
			const margins = [];
			for (const model of bank.models) {
				const samples = (byModel.get(model.id) ?? []).slice(0, REQUIRED_OUTPUTS);
				if (samples.length < REQUIRED_OUTPUTS) continue;
				const result = analyzeOutputs(
					samples.map((s) => ({ text: s.text, expected_count: s.expected_count })),
					bank,
					detector,
					{ allowPartial: true }
				);
				margins.push(result.results[0].score - result.results[1].score);
			}
			const positive = margins.filter((m) => m > 0).length;
			assert.equal(positive, margins.length, `${margins.length - positive} rounds had no margin over the runner-up`);
		});
	}
}

// ---------------------------------------------------------------- retry

console.log("重试策略");

/** A model double that plays a scripted sequence of replies per call. */
function scriptedLlm(replies) {
	let call = 0;
	return {
		listProviders: () => [{ id: "a1" }],
		listModels: async () => [{ id: "gpt-6-astra" }],
		stream: async function* () {
			const reply = replies[Math.min(call, replies.length - 1)];
			call += 1;
			if (reply.throw) throw new Error(reply.throw);
			if (reply.text !== undefined) yield { type: "text-delta", text: reply.text };
			yield { type: "finish", reason: reply.reason ?? { kind: "stop" } };
		},
		calls: () => call
	};
}

/** A long, valid answer. */
const VALID = Array.from({ length: 300 }, (_, i) => ((i * 7) % 355) + 1).join(" ");

test("a dropped stream is re-asked, so one blip does not lose the round", async () => {
	// First challenge dies mid-stream with no text; the replacement succeeds.
	const llm = scriptedLlm([
		{ throw: "terminated" },
		{ text: VALID },
		{ text: VALID },
		{ text: VALID }
	]);
	const { detector: _d, ...rest } = {};
	const report = await probeModel(
		{ llm, logger: { info: () => {}, warn: () => {} } },
		{ provider: "a1", model: "gpt-6-astra" },
		{ bank, detector: DETECTOR_ARTIFACT },
		{ ...DEFAULTS, spacingMs: 0 },
		() => {}
	);
	assert.equal(report.accepted, 3, "the round must recover to three valid answers");
	assert.equal(llm.calls(), 4, "exactly one replacement should have been drawn");
});

test("an answer that is merely too short is NOT re-asked", async () => {
	// The model answered; it just did not comply. Re-rolling would sample until
	// it happened to comply, which biases the distribution the ranker reads.
	const llm = scriptedLlm([{ text: "1 2 3" }, { text: VALID }, { text: VALID }]);
	const report = await probeModel(
		{ llm, logger: { info: () => {}, warn: () => {} } },
		{ provider: "a1", model: "gpt-6-astra" },
		{ bank, detector: DETECTOR_ARTIFACT },
		{ ...DEFAULTS, spacingMs: 0 },
		() => {}
	);
	assert.equal(llm.calls(), 3, "a non-compliant answer must be accepted as the answer");
	assert.equal(report.accepted, 2);
	assert.equal(report.analysis.decision, "partial");
});

test("replacements are bounded so an uncooperative model cannot spin", async () => {
	const llm = scriptedLlm([{ throw: "terminated" }]);
	const report = await probeModel(
		{ llm, logger: { info: () => {}, warn: () => {} } },
		{ provider: "a1", model: "gpt-6-astra" },
		{ bank, detector: DETECTOR_ARTIFACT },
		{ ...DEFAULTS, spacingMs: 0 },
		() => {}
	);
	// 3 slots x (1 attempt + 1 replacement) = 6 calls, then stop.
	assert.equal(llm.calls(), 6);
	assert.equal(report.accepted, 0);
});

test("replacement challenges keep distinct counts within a round", async () => {
	const seen = [];
	const llm = {
		listProviders: () => [{ id: "a1" }],
		listModels: async () => [{ id: "gpt-6-astra" }],
		stream: async function* (options) {
			const prompt = options.messages[0].content[0].text;
			seen.push(prompt);
			yield { type: "text-delta", text: "1 2 3" };
			yield { type: "finish", reason: { kind: "stop" } };
		}
	};
	await probeModel(
		{ llm, logger: { info: () => {}, warn: () => {} } },
		{ provider: "a1", model: "gpt-6-astra" },
		{ bank, detector: DETECTOR_ARTIFACT },
		{ ...DEFAULTS, spacingMs: 0 },
		() => {}
	);
	assert.equal(seen.length, 3);
	// Each prompt states its own count; three prompts must name three counts.
	const counts = seen.map((p) => {
		const match = p.match(/(\d{3})\s*(?:个|integers|個|개|entiers)/);
		return match ? Number(match[1]) : null;
	});
	assert.ok(counts.every((c) => c !== null), `could not read counts from prompts: ${counts}`);
	assert.equal(new Set(counts).size, 3, `counts repeated within a round: ${counts}`);
});

// ---------------------------------------------------------------- challenges

console.log("挑战生成");

test("a round draws three challenges with distinct counts", () => {
	const challenges = generateChallenges(3);
	assert.equal(challenges.length, 3);
	const counts = challenges.map((c) => c.expected_count);
	assert.equal(new Set(counts).size, 3, "counts must be distinct within a round");
	assert.ok(counts.every((c) => c >= 292 && c <= 332), `counts out of range: ${counts}`);
});

test("used lengths are not drawn again", () => {
	const first = generateChallenges(3);
	const second = generateChallenges(3, first.map((c) => c.expected_count));
	const overlap = second.filter((c) => first.some((f) => f.expected_count === c.expected_count));
	assert.equal(overlap.length, 0);
});

test("challenge ids are unique", () => {
	const ids = new Set(generateChallenges(3).map((c) => c.id));
	assert.equal(ids.size, 3);
});

test("every prompt forbids tools and states the range", () => {
	for (const challenge of generateChallenges(5)) {
		assert.ok(challenge.prompt.includes("355"), "prompt must state the range");
		// The tool ban is what keeps a code-executing agent from answering with a
		// PRNG, which would fingerprint the PRNG instead of the model.
		const banned = /工具|tools|ツール|도구|outil/i.test(challenge.prompt);
		assert.ok(banned, `prompt must forbid tools: ${challenge.prompt.slice(0, 80)}`);
		assert.ok(challenge.prompt.includes(String(challenge.expected_count)));
	}
});

test("prompts vary across languages", () => {
	const seen = new Set();
	for (let i = 0; i < 60; i++) {
		const prompt = generateChallenges(1)[0].prompt;
		if (/[\u3040-\u30ff]/.test(prompt)) seen.add("ja");
		else if (/[\uac00-\ud7af]/.test(prompt)) seen.add("ko");
		else if (/[\u4e00-\u9fff]/.test(prompt)) seen.add("zh");
		else if (/\bentiers\b/.test(prompt)) seen.add("fr");
		else seen.add("en");
	}
	// One language per challenge, drawn independently; over 60 draws seeing at
	// least three distinct languages is overwhelmingly likely (5^60 outcomes).
	assert.ok(seen.size >= 3, `expected several languages, saw ${[...seen].join(",")}`);
});

// ---------------------------------------------------------------- bank metadata

console.log("参考库元数据");

test("the shipped metadata pins a build stamp", () => {
	assert.equal(bank.schema, "robust-number-fingerprint-bank");
	assert.ok(typeof bank.built_at === "string" && bank.built_at.length > 0);
});

test("every reference model carries the fields the panel renders", () => {
	assert.ok(bank.models.length > 0);
	for (const model of bank.models) {
		assert.ok(typeof model.id === "string" && model.id.length > 0, "id");
		assert.ok(typeof model.family === "string" && model.family.length > 0, `family for ${model.id}`);
		assert.ok(typeof model.family_name === "string" && model.family_name.length > 0, `family_name for ${model.id}`);
		assert.ok(Number.isInteger(model.response_count) && model.response_count > 0, `response_count for ${model.id}`);
	}
});

test("model ids are unique", () => {
	const ids = bank.models.map((m) => m.id);
	assert.equal(new Set(ids).size, ids.length);
});

// ---------------------------------------------------------------- summary

console.log(`\n${passed} 通过, ${failed} 失败, ${skipped} 跳过`);
if (failed > 0) process.exitCode = 1;
