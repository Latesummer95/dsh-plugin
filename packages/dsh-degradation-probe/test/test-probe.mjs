/**
 * Tests for the degradation-probe scoring and answer extraction.
 *
 * The scoring decides whether a route is reported as degraded, so it is the part
 * that must not be wrong. These cases pin the tier logic: the whole value of the
 * battery is that "easy fails" and "hard fails" mean different things.
 *
 * Run: node test/test-probe.mjs
 */

import assert from "node:assert/strict";
import { DEFAULTS, PROBES, apply, extractNumber, extractWord, grade, inject, score } from "../index.js";

let passed = 0;
let failed = 0;

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

/** Build a synthetic probe result. */
function row(id, tier, ok, error) {
	return { id, tier, ok, ...(error === undefined ? {} : { error }) };
}

/** Build a result list with the given pass pattern per tier. */
function rows({ easy = 3, easyPass = 3, medium = 1, mediumPass = 1, hard = 4, hardPass = 4 }) {
	const out = [];
	for (let i = 0; i < easy; i += 1) out.push(row(`e${i}`, "easy", i < easyPass));
	for (let i = 0; i < medium; i += 1) out.push(row(`m${i}`, "medium", i < mediumPass));
	for (let i = 0; i < hard; i += 1) out.push(row(`h${i}`, "hard", i < hardPass));
	return out;
}

console.log("extractNumber");
test("takes the last number in prose", () => {
	assert.equal(extractNumber("The answer is 3."), "3");
});
test("strips thousands separators", () => {
	assert.equal(extractNumber("5,584,271"), "5584271");
});
test("handles negative results", () => {
	assert.equal(extractNumber("result: -12"), "-12");
});
test("returns undefined when no number is present", () => {
	assert.equal(extractNumber("no digits here"), undefined);
});
test("ignores a leading explanatory number and keeps the final answer", () => {
	assert.equal(extractNumber("Step 1 gives 100.\n\nFinal: 48"), "48");
});

console.log("extractWord");
test("lowercases and strips quoting", () => {
	assert.equal(extractWord('  "JIHGFEDCBA". '), "jihgfedcba");
});
test("strips a trailing period", () => {
	assert.equal(extractWord("jihgfedcba."), "jihgfedcba");
});
test("handles an empty reply", () => {
	assert.equal(extractWord(undefined), "");
});

console.log("grade");
test("grades a numeric probe as correct", () => {
	assert.deepEqual(grade({ answer: "3" }, "The answer is 3"), { got: "3", ok: true });
});
test("grades a numeric probe as wrong", () => {
	assert.deepEqual(grade({ answer: "3" }, "80"), { got: "80", ok: false });
});
test("grades a word probe with the word extractor", () => {
	assert.deepEqual(grade({ answer: "jihgfedcba", kind: "word" }, "JIHGFEDCBA."), { got: "jihgfedcba", ok: true });
});
test("a missing answer is not a pass", () => {
	assert.deepEqual(grade({ answer: "3" }, "I cannot answer"), { got: null, ok: false });
});

console.log("score verdicts");
test("all probes passing is healthy", () => {
	assert.equal(score(rows({})).verdict, "healthy");
});
test("easy failures mean the route is degraded", () => {
	assert.equal(score(rows({ easyPass: 1 })).verdict, "degraded");
});
test("easy passes with hard failures means reasoning is capped", () => {
	assert.equal(score(rows({ hardPass: 1 })).verdict, "capped");
});
test("easy and hard passing but medium failing is weak", () => {
	assert.equal(score(rows({ mediumPass: 0 })).verdict, "weak");
});
test("every probe erroring is unreachable, not degraded", () => {
	const all = rows({}).map((r) => ({ ...r, ok: false, error: "boom" }));
	assert.equal(score(all).verdict, "unreachable");
});
test("a total outage is not mistaken for a stupid model", () => {
	const all = rows({}).map((r) => ({ ...r, ok: false, error: "boom" }));
	assert.equal(score(all).errored, all.length);
});

console.log("score accounting");
test("tier counts are reported separately", () => {
	const s = score(rows({ easyPass: 2, hardPass: 1 }));
	assert.deepEqual(s.easy, { total: 3, passed: 2 });
	assert.deepEqual(s.hard, { total: 4, passed: 1 });
});
test("ratio reflects overall passes", () => {
	const s = score(rows({ easyPass: 3, mediumPass: 1, hardPass: 4 }));
	assert.equal(s.passed, 8);
	assert.equal(s.total, 8);
	assert.equal(s.ratio, 1);
});
test("errored probes count as failures but are tracked", () => {
	const list = rows({});
	list[0].ok = false;
	list[0].error = "timeout";
	const s = score(list);
	assert.equal(s.errored, 1);
	assert.equal(s.passed, list.length - 1);
});
test("an empty result set does not divide by zero", () => {
	assert.equal(score([]).ratio, 0);
});

console.log("battery integrity");
test("every probe declares a tier and an answer", () => {
	for (const probe of PROBES) {
		assert.ok(["easy", "medium", "hard"].includes(probe.tier), `${probe.id} has a bad tier`);
		assert.ok(typeof probe.answer === "string" && probe.answer.length > 0, `${probe.id} has no answer`);
		assert.ok(typeof probe.prompt === "string" && probe.prompt.length > 0, `${probe.id} has no prompt`);
	}
});
test("probe ids are unique", () => {
	const ids = PROBES.map((p) => p.id);
	assert.equal(new Set(ids).size, ids.length);
});
test("the battery covers all three tiers", () => {
	for (const tier of ["easy", "medium", "hard"]) {
		assert.ok(PROBES.some((p) => p.tier === tier), `no probe in tier ${tier}`);
	}
});

console.log("battery answers are independently reproducible");
// These re-derive each expected answer from the problem statement rather than
// restating the constant. A typo in an answer would otherwise report a healthy
// route as degraded, which is the worst possible failure for this tool.
const byId = Object.fromEntries(PROBES.map((p) => [p.id, p]));

test("arith: 847 * 6593", () => {
	assert.equal(byId.arith.answer, String(847 * 6593));
});
test("char: count of r in strawrrberry", () => {
	const word = "strawrrberry";
	assert.equal(byId.char.answer, String([...word].filter((c) => c === "r").length));
});
test("rev: reverse of abcdefghij", () => {
	assert.equal(byId.rev.answer, [..."abcdefghij"].reverse().join(""));
});
test("batball: ball costs 5 cents", () => {
	// bat + ball = 110, bat - ball = 100 => ball = 5
	assert.equal(byId.batball.answer, String((110 - 100) / 2));
});
test("idempotent: n^2 = n mod 1000 for 0 < n < 1000", () => {
	let count = 0;
	for (let n = 1; n < 1000; n += 1) if ((n * n - n) % 1000 === 0) count += 1;
	assert.equal(byId.idempotent.answer, String(count));
});
test("trailing: zeros of 100! in base 12", () => {
	// Legendre: v_p(n!) = sum over floor(n / p^i). Divide first, then accumulate.
	const vp = (n, p) => {
		let c = 0;
		for (let m = Math.floor(n / p); m > 0; m = Math.floor(m / p)) c += m;
		return c;
	};
	assert.equal(vp(100, 2), 97);
	assert.equal(vp(100, 3), 48);
	assert.equal(byId.trailing.answer, String(Math.min(Math.floor(vp(100, 2) / 2), vp(100, 3))));
});
test("digitsum: decimal digit sum of 2^1000", () => {
	assert.equal(byId.digitsum.answer, String([...(2n ** 1000n).toString()].reduce((a, c) => a + Number(c), 0)));
});
test("stirling: S(10,3) surjections onto identical boxes", () => {
	const choose = (n, k) => {
		let r = 1;
		for (let i = 0; i < k; i += 1) r = (r * (n - i)) / (i + 1);
		return r;
	};
	const factorial = (n) => {
		let r = 1;
		for (let i = 2; i <= n; i += 1) r *= i;
		return r;
	};
	const stirling = (n, k) => {
		let total = 0;
		for (let i = 0; i <= k; i += 1) total += (-1) ** i * choose(k, i) * (k - i) ** n;
		return total / factorial(k);
	};
	assert.equal(byId.stirling.answer, String(stirling(10, 3)));
});

test("defaults are conservative about throttling", () => {
	assert.ok(DEFAULTS.concurrency <= 4, "concurrency should stay low for throttling gateways");
	assert.ok(DEFAULTS.spacingMs > 0, "probes should be paced");
});

console.log("route wiring");

/**
 * Drive `apply` against a fake context and return the captured route.
 *
 * @param overrides - context members to override.
 * @returns the captured route plus the fake context.
 */
function mountRoute(overrides = {}) {
	let route;
	const ctx = {
		effect: (fn) => fn(),
		get: () => undefined,
		logger: { info: () => {}, warn: () => {} },
		webServer: { register: (r) => { route = r; return () => {}; } },
		llm: { listModels: async () => [], stream: () => { throw new Error("unused"); } },
		...overrides
	};
	apply(ctx, { provider: "a1", modelPattern: "none" });
	return { route, ctx };
}

/** A minimal response recorder. */
function fakeRes() {
	return {
		statusCode: 0,
		headers: {},
		body: undefined,
		setHeader(k, v) {
			this.headers[k] = v;
		},
		end(b) {
			this.body = b;
		}
	};
}

test("the route is registered at the documented path", () => {
	const { route } = mountRoute();
	assert.equal(route.kind, "exact");
	assert.equal(route.path, "/degradation-probe/run");
});

test("the host gate is called bound to the connection service", async () => {
	// Regression: `requestRejection` reads `this.trustedHosts` and
	// `this.browserAuth`. Extracting it and calling it detached throws, and the
	// webserver turns that throw into an opaque 400 for every request.
	let sawThis;
	const connection = {
		trustedHosts: ["127.0.0.1"],
		browserAuth: { isAuthenticated: () => true },
		requestRejection() {
			sawThis = this;
			return undefined;
		}
	};
	const { route } = mountRoute({ get: (name) => (name === "connection" ? connection : undefined) });
	const res = fakeRes();
	await route.handler({ method: "POST" }, res);
	assert.equal(sawThis, connection, "gate must be invoked with the connection as `this`");
});

test("a gate rejection is honoured with its own status", async () => {
	const connection = { requestRejection: () => 401 };
	const { route } = mountRoute({ get: () => connection });
	const res = fakeRes();
	await route.handler({ method: "POST" }, res);
	assert.equal(res.statusCode, 401);
});

test("a missing connection service does not block the route", async () => {
	const { route } = mountRoute({ get: () => undefined });
	const res = fakeRes();
	await route.handler({ method: "POST" }, res);
	assert.equal(res.statusCode, 200);
});

test("a GET is accepted so the route can be checked by hand", async () => {
	const { route } = mountRoute();
	const res = fakeRes();
	await route.handler({ method: "GET" }, res);
	assert.equal(res.statusCode, 200);
});

test("an unsupported method is refused", async () => {
	const { route } = mountRoute();
	const res = fakeRes();
	await route.handler({ method: "DELETE" }, res);
	assert.equal(res.statusCode, 405);
});

test("the route reports the configured targets, not an empty list", async () => {
	let route;
	const ctx = {
		effect: (fn) => fn(),
		get: () => undefined,
		logger: { info: () => {}, warn: () => {} },
		webServer: { register: (r) => { route = r; return () => {}; } },
		llm: { listModels: async () => [{ id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }], stream: () => { throw new Error("unused"); } }
	};
	apply(ctx, { provider: "a1", modelPattern: "gpt-6" });
	const res = fakeRes();
	await route.handler({ method: "GET" }, res);
	const payload = JSON.parse(res.body);
	assert.deepEqual(payload.models.map((m) => m.model), ["gpt-6.1-sol", "gpt-6-astra"]);
});

test("the plugin declares the services it reads", () => {
	// Regression: reading an undeclared service throws at apply time
	// (`cannot get property "webServer" without inject`), which fails the whole
	// entry rather than the one request.
	assert.deepEqual(inject, ["webServer", "llm"]);
});

test("probes send content as blocks, not a bare string", async () => {
	// Regression: adapters call `content.some(...)`. Passing a string makes
	// every probe fail with "content.some is not a function" — which the report
	// then shows as 0/8, i.e. it looks exactly like a degraded model.
	let seen;
	const ctx = {
		effect: (fn) => fn(),
		get: () => undefined,
		logger: { info: () => {}, warn: () => {} },
		webServer: { register: () => () => {} },
		llm: {
			listModels: async () => [{ id: "m" }],
			stream: (options) => {
				seen = options;
				return (async function* () {
					yield { type: "text-delta", text: "5" };
					yield { type: "finish", reason: { kind: "stop" } };
				})();
			}
		}
	};
	apply(ctx, { provider: "a1", modelPattern: "m" });
	// Drive one probe through the real code path by invoking apply's route.
	const res = fakeRes();
	// Locate the registered handler by re-mounting, since the fake above discards it.
	let route;
	ctx.webServer.register = (r) => { route = r; return () => {}; };
	apply(ctx, { provider: "a1", modelPattern: "m" });
	await route.handler({ method: "GET" }, res);
	const message = seen.messages[0];
	assert.ok(Array.isArray(message.content), "content must be an array of blocks");
	assert.deepEqual(message.content[0], { type: "text", text: seen.messages[0].content[0].text });
	assert.equal(typeof message.content[0].text, "string");
	assert.ok(message.content[0].text.length > 0);
});

test("a working route scores as healthy end to end", async () => {
	// The full path: route handler -> llm.stream -> grading -> verdict.
	const answers = { arith: "5584271", char: "5", rev: "jihgfedcba", batball: "5", idempotent: "3", trailing: "48", digitsum: "1366", stirling: "9330" };
	let call = 0;
	let route;
	const ctx = {
		effect: (fn) => fn(),
		get: () => undefined,
		logger: { info: () => {}, warn: () => {} },
		webServer: { register: (r) => { route = r; return () => {}; } },
		llm: {
			listModels: async () => [{ id: "m" }],
			stream: () => {
				const id = PROBES[call++].id;
				return (async function* () {
					yield { type: "text-delta", text: answers[id] };
					yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 42 } };
					yield { type: "finish", reason: { kind: "stop" } };
				})();
			}
		}
	};
	apply(ctx, { provider: "a1", modelPattern: "m", spacingMs: 0 });
	const res = fakeRes();
	await route.handler({ method: "POST" }, res);
	const payload = JSON.parse(res.body);
	assert.equal(payload.models[0].score.verdict, "healthy");
	assert.equal(payload.models[0].score.passed, PROBES.length);
	assert.equal(payload.models[0].results[0].reasoningTokens, 42);
});

test("a capped route is reported as capped, not degraded", async () => {
	// Easy tier answers correctly, hard tier misses: the signature of a route
	// whose reasoning budget was cut while its surface behaviour looks normal.
	const easy = { arith: "5584271", char: "5", rev: "jihgfedcba", batball: "5" };
	let call = 0;
	let route;
	const ctx = {
		effect: (fn) => fn(),
		get: () => undefined,
		logger: { info: () => {}, warn: () => {} },
		webServer: { register: (r) => { route = r; return () => {}; } },
		llm: {
			listModels: async () => [{ id: "m" }],
			stream: () => {
				const probe = PROBES[call++];
				const text = easy[probe.id] ?? "0";
				return (async function* () {
					yield { type: "text-delta", text };
					yield { type: "finish", reason: { kind: "stop" } };
				})();
			}
		}
	};
	apply(ctx, { provider: "a1", modelPattern: "m", spacingMs: 0 });
	const res = fakeRes();
	await route.handler({ method: "POST" }, res);
	assert.equal(JSON.parse(res.body).models[0].score.verdict, "capped");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
