/**
 * Tests for the coding probe.
 *
 * Two kinds of check matter here, and they are different:
 *
 * 1. **Unit checks** on the pure helpers (answer derivation, code extraction,
 *    scoring, route wiring) — fast, no browser, no model.
 * 2. **Calibration checks** that feed known-good and known-bad programs through
 *    the real judge. These are the ones that prove the battery can actually
 *    tell a working program from a broken one. Without them a judge that passes
 *    everything would look like a healthy result.
 *
 * The browser cases need headless Chrome and are skipped when it is absent, so
 * the suite still runs on a machine without it.
 *
 * Run: node test/test-probe.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { COMPLEX_BRIEF, DEFAULTS, PROBES, apply, execute, extractCode, inject, instrument, lastJson, listCandidates, measureRender, parseSelection, readSelection, resolveTargets, score } from "../index.js";

let passed = 0;
let failed = 0;
let skipped = 0;

/**
 * Run one named check, awaiting async bodies.
 *
 * The `await` is load-bearing: without it an `async` body's assertions never
 * run, the check is counted as a pass the moment the promise is created, and a
 * later rejection escapes the counter entirely — the suite prints a green
 * summary and then dies on an unhandled rejection. Fifteen checks were
 * vacuous before this was fixed, including every route-level one.
 *
 * @param label - the check description.
 * @param fn - the assertion body, sync or async.
 */
async function test(label, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`  ✓ ${label}`);
	} catch (error) {
		failed += 1;
		console.log(`  ✗ ${label}`);
		console.log(`      ${error.message}`);
	}
}

/** Whether headless Chrome is available for the render probes. */
function hasChrome() {
	try {
		return spawnSync(DEFAULTS.chromePath, ["--version"], { timeout: 15000, encoding: "utf8" }).status === 0;
	} catch {
		return false;
	}
}

/** Probe lookup by id. */
const byId = Object.fromEntries(PROBES.map((p) => [p.id, p]));

/** Execution config with generous budgets for a test machine. */
const CFG = { ...DEFAULTS, execTimeoutMs: 20000, renderTimeoutMs: 90000 };

console.log("code extraction");
await test("strips a markdown fence", () => {
	assert.equal(extractCode("```js\nconsole.log(1)\n```"), "console.log(1)");
});
await test("strips a fence with no language tag", () => {
	assert.equal(extractCode("```\nlet x = 1;\n```"), "let x = 1;");
});
await test("recovers HTML from a prose preamble", () => {
	assert.ok(extractCode("Sure! Here is the file:\n<!doctype html><html></html>").startsWith("<!doctype html>"));
});
await test("passes bare code through unchanged", () => {
	assert.equal(extractCode("const a = 1;"), "const a = 1;");
});
await test("an empty reply extracts to an empty string", () => {
	assert.equal(extractCode(""), "");
});

console.log("stdout parsing");
await test("takes the last JSON object, not the first", () => {
	assert.deepEqual(lastJson('noise\n{"a":1}\n{"b":2}'), { b: 2 });
});
await test("returns undefined when there is no JSON", () => {
	assert.equal(lastJson("just text"), undefined);
});
await test("tolerates a trailing newline", () => {
	assert.deepEqual(lastJson('{"optimum":15125}\n'), { optimum: 15125 });
});

console.log("scoring");
await test("all probes passing is healthy", () => {
	const rows = [{ tier: "control", ok: true }, { tier: "target", ok: true, attempts: 3, renderedCount: 3, generatedCount: 3 }];
	assert.equal(score(rows).verdict, "healthy");
});
await test("a control failure is a general capability regression", () => {
	const rows = [{ tier: "control", ok: false }, { tier: "target", ok: true, attempts: 3, renderedCount: 3, generatedCount: 3 }];
	assert.equal(score(rows).verdict, "degraded");
});
await test("control passing but the complex target never rendering is broken-code", () => {
	// The signature actually observed: simple probes pass, the complex
	// generation completes, and the scene does not render.
	const rows = [{ tier: "control", ok: true }, { tier: "target", ok: false, attempts: 3, renderedCount: 0, generatedCount: 2 }];
	assert.equal(score(rows).verdict, "broken-code");
});
await test("control passing and every complex attempt timing out is timeout-bound", () => {
	// Same surface result as broken-code, different cause and different fix.
	const rows = [{ tier: "control", ok: true }, { tier: "target", ok: false, attempts: 3, renderedCount: 0, generatedCount: 0 }];
	assert.equal(score(rows).verdict, "timeout-bound");
});
await test("some complex attempts rendering is unstable, not healthy", () => {
	const rows = [{ tier: "control", ok: true }, { tier: "target", ok: false, attempts: 3, renderedCount: 1, generatedCount: 3 }];
	assert.equal(score(rows).verdict, "unstable");
});
await test("every probe erroring is unreachable, not degraded", () => {
	const rows = [{ tier: "control", ok: false, error: "boom" }, { tier: "target", ok: false, error: "boom" }];
	assert.equal(score(rows).verdict, "unreachable");
});
await test("tier counts are reported separately", () => {
	const s = score([{ tier: "control", ok: true }, { tier: "target", ok: false, attempts: 3, renderedCount: 2, generatedCount: 3 }]);
	assert.deepEqual(s.control, { total: 1, passed: 1 });
	assert.deepEqual(s.target, { total: 3, passed: 2, generated: 3 });
});
await test("an empty result set does not divide by zero", () => {
	assert.equal(score([]).passed, 0);
});

console.log("battery integrity");
await test("every probe declares a tier, kind, prompt, and check", () => {
	for (const probe of PROBES) {
		assert.ok(["control", "target"].includes(probe.tier), `${probe.id} has a bad tier`);
		assert.ok(["node", "render", "complex"].includes(probe.kind), `${probe.id} has a bad kind`);
		assert.ok(probe.prompt.length > 40, `${probe.id} prompt is too thin to be a real task`);
		assert.equal(typeof probe.check, "function", `${probe.id} has no check`);
	}
});
await test("probe ids are unique", () => {
	const ids = PROBES.map((p) => p.id);
	assert.equal(new Set(ids).size, ids.length);
});
await test("the battery covers both tiers", () => {
	for (const tier of ["control", "target"]) assert.ok(PROBES.some((p) => p.tier === tier), `no probe in tier ${tier}`);
});
await test("the battery exercises both node and browser execution", () => {
	assert.ok(PROBES.some((p) => p.kind === "node"), "no node probe");
	assert.ok(PROBES.some((p) => p.kind !== "node"), "no browser probe");
});
await test("defaults stay gentle on throttling gateways", () => {
	assert.ok(DEFAULTS.concurrency <= 2, "concurrency should stay low");
	assert.ok(DEFAULTS.spacingMs > 0, "probes should be paced");
});
await test("the instrumentation forces preserveDrawingBuffer", () => {
	// Regression: a WebGL drawing buffer is cleared after compositing, so a
	// later readback returns an empty canvas and a good scene scores zero.
	const out = instrument("<canvas></canvas>", "green");
	assert.ok(out.includes("preserveDrawingBuffer"), "preserveDrawingBuffer must be forced on");
});
await test("the instrumentation reports non-black ratio and colour spread", () => {
	// Regression: grading on "no exception was thrown" passed a 40 KB scene that
	// threw nothing and painted nothing. Rendering must be measured directly.
	const out = instrument("<canvas></canvas>", true, 3000);
	assert.ok(out.includes("nonblackRatio"), "nonblackRatio must be measured");
	assert.ok(out.includes("distinctColors"), "distinctColors must be measured");
	assert.ok(out.includes("canvasW"), "canvas size must be reported");
});
await test("the instrumentation waits before sampling", () => {
	// Regression: sampling at 800 ms reported a black canvas for a scene that
	// rendered fully by 2500 ms.
	const out = instrument("<canvas></canvas>", true, 3000);
	assert.ok(out.includes("}, 3000);"), "the sample delay must be applied");
});
await test("the instrumentation declares payload outside the try block", () => {
	// Regression: `let payload` inside the try is out of scope at the title
	// assignment, which throws ReferenceError and reports no result at all.
	const out = instrument("<canvas></canvas>", "green");
	assert.ok(out.includes("var payload = null;"), "payload must be declared in the preamble");
	assert.ok(!/try\s*\{\s*let payload/.test(out), "payload must not be scoped to the try block");
});

console.log("calibration: the judge must reject broken programs");
await test("a correct event-loop ordering passes", () => {
	const code = `const log=[];log.push('A');setTimeout(()=>log.push('D'),0);
Promise.resolve().then(()=>log.push('C'));log.push('B');
setTimeout(()=>console.log(JSON.stringify({order:log.join('')})),10);`;
	assert.equal(execute(byId.scheduler, code, CFG).ok, true);
});
await test("treating a microtask as a macrotask fails", () => {
	const code = `const log=[];log.push('A');setTimeout(()=>log.push('D'),0);
setTimeout(()=>log.push('C'),0);log.push('B');
setTimeout(()=>console.log(JSON.stringify({order:log.join('')})),10);`;
	assert.equal(execute(byId.scheduler, code, CFG).ok, false);
});
await test("a program that throws fails", () => {
	assert.equal(execute(byId.scheduler, "throw new Error('nope');", CFG).ok, false);
});
await test("an empty reply fails rather than passing vacuously", () => {
	assert.equal(execute(byId.scheduler, "", CFG).ok, false);
});

if (hasChrome()) {
	console.log("calibration: browser probes (real Chrome)");
	const GOOD_GL = `<!doctype html><html><body><canvas id="c" width="64" height="64"></canvas><script>
const gl=document.getElementById('c').getContext('webgl');
const vs=gl.createShader(gl.VERTEX_SHADER);
gl.shaderSource(vs,'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}');gl.compileShader(vs);
const fs=gl.createShader(gl.FRAGMENT_SHADER);
gl.shaderSource(fs,'precision mediump float;void main(){gl_FragColor=vec4(0.,1.,0.,1.);}');gl.compileShader(fs);
const pr=gl.createProgram();gl.attachShader(pr,vs);gl.attachShader(pr,fs);gl.linkProgram(pr);gl.useProgram(pr);
const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);
gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
const l=gl.getAttribLocation(pr,'p');gl.enableVertexAttribArray(l);
gl.vertexAttribPointer(l,2,gl.FLOAT,false,0,0);
gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,3);
</script></body></html>`;
	// The exact degradation captured on this gateway: WebGL 2 entry points on a
	// WebGL 1 context. Syntactically perfect, throws at runtime.
	const BAD_GL = GOOD_GL.replace("const b=gl.createBuffer();", "const vao=gl.createVertexArray();gl.bindVertexArray(vao);const b=gl.createBuffer();");
	// The subtler and more dangerous failure: no exception at all, nothing
	// painted. This is what a naive "did it throw?" check waves through.
	const SILENT_BLANK = `<!doctype html><html><body><canvas id="c" width="64" height="64"></canvas><script>
const gl=document.getElementById('c').getContext('webgl');
gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
</script></body></html>`;

	await test("a correct hand-written WebGL triangle renders green", () => {
		const r = execute(byId.simple_gl, GOOD_GL, CFG);
		assert.equal(r.ok, true, `expected pass, got ${r.detail}`);
	});
	await test("WebGL2 calls on a WebGL1 context are caught", () => {
		const r = execute(byId.simple_gl, BAD_GL, CFG);
		assert.equal(r.ok, false, "the degraded program must not pass");
		assert.match(r.detail, /createVertexArray/);
	});
	await test("a blank canvas with no exception is still a failure", () => {
		// The critical case: silent success. Grading on "no exception" alone
		// would report this as healthy.
		const r = execute(byId.complex_scene, SILENT_BLANK, CFG);
		assert.equal(r.ok, false, "a silent blank render must not pass");
		assert.match(r.detail, /未渲染|非黑/);
	});
	await test("a scene that renders with colour spread passes the render check", () => {
		// A multi-colour scene, closer to the real brief than a flat fill.
		const code = `<!doctype html><html><body><canvas id="c" width="200" height="200"></canvas><script>
const gl=document.getElementById('c').getContext('webgl');
const vs=gl.createShader(gl.VERTEX_SHADER);
gl.shaderSource(vs,'attribute vec2 p;varying vec2 v;void main(){v=p;gl_Position=vec4(p,0.,1.);}');gl.compileShader(vs);
const fs=gl.createShader(gl.FRAGMENT_SHADER);
gl.shaderSource(fs,'precision mediump float;varying vec2 v;void main(){gl_FragColor=vec4(v*0.5+0.5,0.0,1.0);}');gl.compileShader(fs);
const pr=gl.createProgram();gl.attachShader(pr,vs);gl.attachShader(pr,fs);gl.linkProgram(pr);gl.useProgram(pr);
const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);
gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
const l=gl.getAttribLocation(pr,'p');gl.enableVertexAttribArray(l);
gl.vertexAttribPointer(l,2,gl.FLOAT,false,0,0);
gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,3);
</script></body></html>`;
		const r = execute(byId.complex_scene, code, CFG);
		assert.equal(r.ok, true, `expected pass, got ${r.detail}`);
		assert.ok(r.evidence.distinctColors >= 8, `expected colour spread, got ${r.evidence.distinctColors}`);
	});
	await test("an un-resized default canvas is reported as evidence", () => {
		// The captured failure never resized its canvas from the 300x150
		// default, which is itself proof that its setup code never ran.
		// The canvas must therefore be declared WITHOUT width/height here.
		const code = `<!doctype html><html><body><canvas></canvas><script>
const gl=document.querySelector('canvas').getContext('webgl');
gl.createVertexArray();
</script></body></html>`;
		const r = execute(byId.complex_scene, code, CFG);
		assert.equal(r.ok, false);
		assert.equal(r.evidence.canvasW, 300);
		assert.equal(r.evidence.canvasH, 150);
	});
} else {
	skipped += 6;
	console.log("calibration: browser probes SKIPPED (no headless Chrome)");
}

console.log("route wiring");

/**
 * Drive `apply` against a fake context and return the captured routes.
 *
 * @param overrides - context members to override.
 * @param config - plugin config; defaults to a pattern that matches nothing so
 *   a test that cares about targets must say so explicitly.
 * @returns `{routes, byPath}` where `byPath` is keyed by registered path.
 */
function mountRoutes(overrides = {}, config = { provider: "a1", modelPattern: "none" }) {
	const routes = [];
	const ctx = {
		effect: (fn) => fn(),
		get: () => undefined,
		logger: { info: () => {}, warn: () => {} },
		webServer: { register: (r) => { routes.push(r); return () => {}; } },
		llm: {
			listProviders: () => [{ id: "a1", name: "A1" }],
			listModels: async () => [],
			stream: () => { throw new Error("unused"); }
		},
		...overrides
	};
	apply(ctx, config);
	const byPath = {};
	for (const r of routes) byPath[r.path] = r;
	return { routes, byPath };
}

/**
 * A minimal request that satisfies the body reader.
 *
 * The route reads POST bodies with `for await`, so a bare `{method}` object
 * throws "req is not async iterable" — a failure that only became visible once
 * the suite started awaiting its async checks.
 *
 * @param method - the HTTP method.
 * @param body - optional JSON body.
 * @returns the fake request.
 */
function fakeRequest(method, body) {
	const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
	return {
		method,
		async *[Symbol.asyncIterator]() { yield* chunks; },
		resume() {}
	};
}

/** Back-compat helper: just the run route. */
function mountRoute(overrides = {}, config) {
	return mountRoutes(overrides, config).byPath["/coding-probe/run"];
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

await test("the run route is registered at the documented path", () => {
	const route = mountRoute();
	assert.equal(route.kind, "exact");
	assert.equal(route.path, "/coding-probe/run");
});
await test("the model catalog route is registered separately from the run route", () => {
	const { byPath } = mountRoutes();
	assert.equal(byPath["/coding-probe/models"].kind, "exact");
});
await test("the plugin declares the services it reads", () => {
	// Regression: reading an undeclared service throws at apply time, failing
	// the whole entry rather than the one request.
	assert.deepEqual(inject, ["webServer", "llm"]);
});
await test("the host gate is called bound to the connection service", async () => {
	// Regression: requestRejection reads this.trustedHosts/this.browserAuth.
	// Calling it detached throws, and the webserver turns that into an opaque
	// 400 for every request.
	let sawThis;
	const connection = {
		requestRejection() {
			sawThis = this;
			return undefined;
		}
	};
	const route = mountRoute({ get: () => connection });
	await route.handler(fakeRequest("POST"), fakeRes());
	assert.equal(sawThis, connection);
});
await test("a gate rejection is honoured with its own status", async () => {
	const route = mountRoute({ get: () => ({ requestRejection: () => 401 }) });
	const res = fakeRes();
	await route.handler(fakeRequest("POST"), res);
	assert.equal(res.statusCode, 401);
});
await test("an unsupported method is refused", async () => {
	const route = mountRoute();
	const res = fakeRes();
	await route.handler(fakeRequest("DELETE"), res);
	assert.equal(res.statusCode, 405);
});
await test("a GET returns the manifest without running the battery", async () => {
	// Regression: GET used to fall through to runBattery, so inspecting the
	// route with curl hung for minutes and looked like a broken route.
	let streamed = false;
	const route = mountRoute(
		{ llm: { listModels: async () => [{ id: "probe-model" }], stream: () => { streamed = true; throw new Error("must not stream"); } } },
		{ provider: "a1", modelPattern: "" }
	);
	const res = fakeRes();
	await route.handler(fakeRequest("GET"), res);
	const payload = JSON.parse(res.body);
	assert.equal(res.statusCode, 200);
	assert.equal(payload.probes.length, PROBES.length);
	assert.equal(payload.models, undefined, "GET must not run models");
	assert.deepEqual(payload.targets, ["a1/probe-model"]);
	assert.equal(streamed, false, "GET must not call the model route");
});

console.log("background run");

await test("a POST acknowledges the start without waiting for the battery", async () => {
	// The regression this guards: POST used to run the whole battery inline and
	// only reply when it finished, so the run belonged to an HTTP request whose
	// reader is gone the moment the panel unmounts. A conversation switch then
	// discarded minutes of work and the panel came back looking idle.
	let released;
	const held = new Promise((resolve) => { released = resolve; });
	const route = mountRoute(
		{
			llm: {
				listProviders: () => [{ id: "a1" }],
				listModels: async () => [{ id: "m" }],
				// Never settles until the test releases it: if the handler awaited
				// the battery, this await would hang and the test would time out.
				stream: async function* () { await held; yield { type: "finish", reason: "stop" }; }
			}
		},
		{ provider: "a1", modelPattern: "" }
	);
	const res = fakeRes();
	await route.handler(fakeRequest("POST", { models: ["a1/m"] }), res);
	const payload = JSON.parse(res.body);
	assert.equal(res.statusCode, 202, "a started job is accepted, not completed");
	assert.equal(payload.phase, "running");
	assert.ok(typeof payload.id === "string" && payload.id.length > 0, "the job must be identifiable");
	released();
});

await test("GET reports the running job so a remounted panel can rejoin it", async () => {
	// This is the whole fix for "switching conversations asks me to start over":
	// the job lives on the host, so a panel that mounts mid-run reads it back.
	let released;
	const held = new Promise((resolve) => { released = resolve; });
	const route = mountRoute(
		{
			llm: {
				listProviders: () => [{ id: "a1" }],
				listModels: async () => [{ id: "m" }],
				stream: async function* () { await held; yield { type: "finish", reason: "stop" }; }
			}
		},
		{ provider: "a1", modelPattern: "", spacingMs: 0, complexTrials: 1 }
	);
	await route.handler(fakeRequest("POST", { models: ["a1/m"] }), fakeRes());

	const res = fakeRes();
	await route.handler(fakeRequest("GET"), res);
	const payload = JSON.parse(res.body);
	assert.equal(payload.phase, "running", "GET must report the in-flight job, not idle");
	assert.deepEqual(payload.targets, ["a1/m"], "the manifest must describe the running job");
	released();
});

await test("a GET with no run reports idle rather than inventing a report", async () => {
	const route = mountRoute();
	const res = fakeRes();
	await route.handler(fakeRequest("GET"), res);
	const payload = JSON.parse(res.body);
	assert.equal(res.statusCode, 200);
	assert.equal(payload.phase, "idle");
	assert.equal(payload.models, undefined, "idle must not fabricate results");
});

await test("a second POST supersedes the first job", async () => {
	let released;
	const held = new Promise((resolve) => { released = resolve; });
	const route = mountRoute(
		{
			llm: {
				listProviders: () => [{ id: "a1" }],
				listModels: async () => [{ id: "m" }],
				stream: async function* () { await held; yield { type: "finish", reason: "stop" }; }
			}
		},
		{ provider: "a1", modelPattern: "" }
	);
	const first = fakeRes();
	await route.handler(fakeRequest("POST", { models: ["a1/first"] }), first);
	const firstId = JSON.parse(first.body).id;
	const second = fakeRes();
	await route.handler(fakeRequest("POST", { models: ["a1/second"] }), second);
	const secondId = JSON.parse(second.body).id;
	assert.notEqual(firstId, secondId, "each run gets its own id");
	const res = fakeRes();
	await route.handler(fakeRequest("GET"), res);
	assert.deepEqual(JSON.parse(res.body).targets, ["a1/second"], "GET follows the newest job");
	released();
});

console.log("model selection");

await test("an explicit request selection wins over the configured pattern", async () => {
	// This is the whole point of the picker: the panel's ticked boxes must be
	// what runs, not a pattern baked into the profile patch.
	const targets = await resolveTargets(
		{ llm: { listModels: async () => [{ id: "pattern-match" }] } },
		{ provider: "a1", modelPattern: "pattern-match" },
		["a1/chosen-one", "a1/chosen-two"]
	);
	assert.deepEqual(targets, [
		{ provider: "a1", model: "chosen-one" },
		{ provider: "a1", model: "chosen-two" }
	]);
});
await test("an explicit configured list beats the pattern when no request selection exists", async () => {
	const targets = await resolveTargets(
		{ llm: { listModels: async () => [{ id: "pattern-match" }] } },
		{ provider: "a1", modelPattern: "pattern-match", models: ["a1/pinned"] },
		undefined
	);
	assert.deepEqual(targets, [{ provider: "a1", model: "pinned" }]);
});
await test("the pattern is still the fallback for headless use", async () => {
	const targets = await resolveTargets(
		{ llm: { listModels: async () => [{ id: "gpt-6-sol" }, { id: "other" }] } },
		{ provider: "a1", modelPattern: "gpt-6", models: [] },
		undefined
	);
	assert.deepEqual(targets, [{ provider: "a1", model: "gpt-6-sol" }]);
});
await test("an empty request selection falls back rather than probing nothing", async () => {
	const targets = await resolveTargets(
		{ llm: { listModels: async () => [{ id: "fallback" }] } },
		{ provider: "a1", modelPattern: "fall", models: [] },
		[]
	);
	assert.deepEqual(targets, [{ provider: "a1", model: "fallback" }]);
});
await test("a bare model id uses the configured provider", () => {
	assert.deepEqual(parseSelection(["solo"], "a1"), [{ provider: "a1", model: "solo" }]);
	assert.deepEqual(parseSelection(["p/m"], "a1"), [{ provider: "p", model: "m" }]);
});
await test("a POST body selects models", async () => {
	const chunks = [Buffer.from('{"models":["a1/x","a1/y"]}')];
	const req = { async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
	assert.deepEqual(await readSelection(req), ["a1/x", "a1/y"]);
});
await test("an empty or malformed POST body falls back to the configured targets", async () => {
	const empty = { async *[Symbol.asyncIterator]() {} };
	assert.equal(await readSelection(empty), undefined);
	const bad = { async *[Symbol.asyncIterator]() { yield Buffer.from("not json"); } };
	assert.equal(await readSelection(bad), undefined);
	const wrong = { async *[Symbol.asyncIterator]() { yield Buffer.from('{"models":[]}'); } };
	assert.equal(await readSelection(wrong), undefined);
});
await test("a POST body selection reaches the run route", async () => {
	const route = mountRoute({
		llm: { listModels: async () => [{ id: "ignored-by-pattern" }], stream: () => { throw new Error("must not stream"); } }
	});
	const req = {
		method: "POST",
		async *[Symbol.asyncIterator]() { yield Buffer.from('{"models":["a1/picked"]}'); }
	};
	const res = fakeRes();
	// The battery will run and fail (no stream), but the manifest must show the
	// picked target — that is what proves the selection was honoured.
	await route.handler(req, res);
	const payload = JSON.parse(res.body);
	assert.deepEqual(payload.targets, ["a1/picked"]);
});
await test("the catalog lists every provider's models", async () => {
	const catalog = await listCandidates({
		llm: {
			listProviders: () => [{ id: "a1" }, { id: "b2" }],
			listModels: async (p) => (p === "a1" ? [{ id: "m1" }, { id: "m2" }] : [{ id: "m3" }])
		}
	});
	assert.deepEqual(catalog.providers, ["a1", "b2"]);
	assert.deepEqual(catalog.models.map((m) => `${m.provider}/${m.model}`), ["a1/m1", "a1/m2", "b2/m3"]);
	assert.deepEqual(catalog.failed, []);
});
await test("one failing provider does not hide the others", async () => {
	// A single unreachable route must not blank the whole picker.
	const catalog = await listCandidates({
		llm: {
			listProviders: () => [{ id: "bad" }, { id: "good" }],
			listModels: async (p) => {
				if (p === "bad") throw new Error("route down");
				return [{ id: "ok" }];
			}
		}
	});
	assert.deepEqual(catalog.models.map((m) => `${m.provider}/${m.model}`), ["good/ok"]);
	assert.equal(catalog.failed.length, 1);
	assert.equal(catalog.failed[0].provider, "bad");
});
await test("the catalog route returns the picker payload", async () => {
	const { byPath } = mountRoutes(
		{
			llm: {
				listProviders: () => [{ id: "a1" }],
				listModels: async () => [{ id: "gpt-6-sol" }, { id: "gpt-6-astra" }],
				stream: () => { throw new Error("unused"); }
			}
		},
		// The catalog lists every model; `defaults` is what the pattern selects.
		// With the pattern matching nothing the defaults are empty by design.
		{ provider: "a1", modelPattern: "gpt-6" }
	);
	const res = fakeRes();
	await byPath["/coding-probe/models"].handler(fakeRequest("GET"), res);
	const payload = JSON.parse(res.body);
	assert.equal(res.statusCode, 200);
	assert.deepEqual(payload.models.map((m) => `${m.provider}/${m.model}`), ["a1/gpt-6-astra", "a1/gpt-6-sol"]);
	// `defaults` keeps the provider's own listing order; only the picker's
	// `models` list is sorted. Asserting the sorted order here would be wrong.
	assert.deepEqual(payload.defaults, ["a1/gpt-6-sol", "a1/gpt-6-astra"]);
});
await test("the catalog route refuses non-GET", async () => {
	const { byPath } = mountRoutes();
	const res = fakeRes();
	await byPath["/coding-probe/models"].handler(fakeRequest("POST"), res);
	assert.equal(res.statusCode, 405);
});

const total = passed + failed + skipped;
console.log(`\n${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ""} (of ${total})`);
process.exit(failed === 0 ? 0 : 1);
