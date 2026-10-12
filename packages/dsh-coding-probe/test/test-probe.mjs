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
import { COMPLEX_BRIEF, DEFAULTS, PROBES, apply, execute, extractCode, inject, instrument, lastJson, measureRender, score } from "../index.js";

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
test("strips a markdown fence", () => {
	assert.equal(extractCode("```js\nconsole.log(1)\n```"), "console.log(1)");
});
test("strips a fence with no language tag", () => {
	assert.equal(extractCode("```\nlet x = 1;\n```"), "let x = 1;");
});
test("recovers HTML from a prose preamble", () => {
	assert.ok(extractCode("Sure! Here is the file:\n<!doctype html><html></html>").startsWith("<!doctype html>"));
});
test("passes bare code through unchanged", () => {
	assert.equal(extractCode("const a = 1;"), "const a = 1;");
});
test("an empty reply extracts to an empty string", () => {
	assert.equal(extractCode(""), "");
});

console.log("stdout parsing");
test("takes the last JSON object, not the first", () => {
	assert.deepEqual(lastJson('noise\n{"a":1}\n{"b":2}'), { b: 2 });
});
test("returns undefined when there is no JSON", () => {
	assert.equal(lastJson("just text"), undefined);
});
test("tolerates a trailing newline", () => {
	assert.deepEqual(lastJson('{"optimum":15125}\n'), { optimum: 15125 });
});

console.log("scoring");
test("all probes passing is healthy", () => {
	const rows = [{ tier: "control", ok: true }, { tier: "target", ok: true, attempts: 3, renderedCount: 3, generatedCount: 3 }];
	assert.equal(score(rows).verdict, "healthy");
});
test("a control failure is a general capability regression", () => {
	const rows = [{ tier: "control", ok: false }, { tier: "target", ok: true, attempts: 3, renderedCount: 3, generatedCount: 3 }];
	assert.equal(score(rows).verdict, "degraded");
});
test("control passing but the complex target never rendering is broken-code", () => {
	// The signature actually observed: simple probes pass, the complex
	// generation completes, and the scene does not render.
	const rows = [{ tier: "control", ok: true }, { tier: "target", ok: false, attempts: 3, renderedCount: 0, generatedCount: 2 }];
	assert.equal(score(rows).verdict, "broken-code");
});
test("control passing and every complex attempt timing out is timeout-bound", () => {
	// Same surface result as broken-code, different cause and different fix.
	const rows = [{ tier: "control", ok: true }, { tier: "target", ok: false, attempts: 3, renderedCount: 0, generatedCount: 0 }];
	assert.equal(score(rows).verdict, "timeout-bound");
});
test("some complex attempts rendering is unstable, not healthy", () => {
	const rows = [{ tier: "control", ok: true }, { tier: "target", ok: false, attempts: 3, renderedCount: 1, generatedCount: 3 }];
	assert.equal(score(rows).verdict, "unstable");
});
test("every probe erroring is unreachable, not degraded", () => {
	const rows = [{ tier: "control", ok: false, error: "boom" }, { tier: "target", ok: false, error: "boom" }];
	assert.equal(score(rows).verdict, "unreachable");
});
test("tier counts are reported separately", () => {
	const s = score([{ tier: "control", ok: true }, { tier: "target", ok: false, attempts: 3, renderedCount: 2, generatedCount: 3 }]);
	assert.deepEqual(s.control, { total: 1, passed: 1 });
	assert.deepEqual(s.target, { total: 3, passed: 2, generated: 3 });
});
test("an empty result set does not divide by zero", () => {
	assert.equal(score([]).passed, 0);
});

console.log("battery integrity");
test("every probe declares a tier, kind, prompt, and check", () => {
	for (const probe of PROBES) {
		assert.ok(["control", "target"].includes(probe.tier), `${probe.id} has a bad tier`);
		assert.ok(["node", "render", "complex"].includes(probe.kind), `${probe.id} has a bad kind`);
		assert.ok(probe.prompt.length > 40, `${probe.id} prompt is too thin to be a real task`);
		assert.equal(typeof probe.check, "function", `${probe.id} has no check`);
	}
});
test("probe ids are unique", () => {
	const ids = PROBES.map((p) => p.id);
	assert.equal(new Set(ids).size, ids.length);
});
test("the battery covers both tiers", () => {
	for (const tier of ["control", "target"]) assert.ok(PROBES.some((p) => p.tier === tier), `no probe in tier ${tier}`);
});
test("the battery exercises both node and browser execution", () => {
	assert.ok(PROBES.some((p) => p.kind === "node"), "no node probe");
	assert.ok(PROBES.some((p) => p.kind !== "node"), "no browser probe");
});
test("defaults stay gentle on throttling gateways", () => {
	assert.ok(DEFAULTS.concurrency <= 2, "concurrency should stay low");
	assert.ok(DEFAULTS.spacingMs > 0, "probes should be paced");
});
test("the instrumentation forces preserveDrawingBuffer", () => {
	// Regression: a WebGL drawing buffer is cleared after compositing, so a
	// later readback returns an empty canvas and a good scene scores zero.
	const out = instrument("<canvas></canvas>", "green");
	assert.ok(out.includes("preserveDrawingBuffer"), "preserveDrawingBuffer must be forced on");
});
test("the instrumentation reports non-black ratio and colour spread", () => {
	// Regression: grading on "no exception was thrown" passed a 40 KB scene that
	// threw nothing and painted nothing. Rendering must be measured directly.
	const out = instrument("<canvas></canvas>", true, 3000);
	assert.ok(out.includes("nonblackRatio"), "nonblackRatio must be measured");
	assert.ok(out.includes("distinctColors"), "distinctColors must be measured");
	assert.ok(out.includes("canvasW"), "canvas size must be reported");
});
test("the instrumentation waits before sampling", () => {
	// Regression: sampling at 800 ms reported a black canvas for a scene that
	// rendered fully by 2500 ms.
	const out = instrument("<canvas></canvas>", true, 3000);
	assert.ok(out.includes("}, 3000);"), "the sample delay must be applied");
});
test("the instrumentation declares payload outside the try block", () => {
	// Regression: `let payload` inside the try is out of scope at the title
	// assignment, which throws ReferenceError and reports no result at all.
	const out = instrument("<canvas></canvas>", "green");
	assert.ok(out.includes("var payload = null;"), "payload must be declared in the preamble");
	assert.ok(!/try\s*\{\s*let payload/.test(out), "payload must not be scoped to the try block");
});

console.log("calibration: the judge must reject broken programs");
test("a correct event-loop ordering passes", () => {
	const code = `const log=[];log.push('A');setTimeout(()=>log.push('D'),0);
Promise.resolve().then(()=>log.push('C'));log.push('B');
setTimeout(()=>console.log(JSON.stringify({order:log.join('')})),10);`;
	assert.equal(execute(byId.scheduler, code, CFG).ok, true);
});
test("treating a microtask as a macrotask fails", () => {
	const code = `const log=[];log.push('A');setTimeout(()=>log.push('D'),0);
setTimeout(()=>log.push('C'),0);log.push('B');
setTimeout(()=>console.log(JSON.stringify({order:log.join('')})),10);`;
	assert.equal(execute(byId.scheduler, code, CFG).ok, false);
});
test("a program that throws fails", () => {
	assert.equal(execute(byId.scheduler, "throw new Error('nope');", CFG).ok, false);
});
test("an empty reply fails rather than passing vacuously", () => {
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

	test("a correct hand-written WebGL triangle renders green", () => {
		const r = execute(byId.simple_gl, GOOD_GL, CFG);
		assert.equal(r.ok, true, `expected pass, got ${r.detail}`);
	});
	test("WebGL2 calls on a WebGL1 context are caught", () => {
		const r = execute(byId.simple_gl, BAD_GL, CFG);
		assert.equal(r.ok, false, "the degraded program must not pass");
		assert.match(r.detail, /createVertexArray/);
	});
	test("a blank canvas with no exception is still a failure", () => {
		// The critical case: silent success. Grading on "no exception" alone
		// would report this as healthy.
		const r = execute(byId.complex_scene, SILENT_BLANK, CFG);
		assert.equal(r.ok, false, "a silent blank render must not pass");
		assert.match(r.detail, /未渲染|非黑/);
	});
	test("a scene that renders with colour spread passes the render check", () => {
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
	test("an un-resized default canvas is reported as evidence", () => {
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
 * Drive `apply` against a fake context and return the captured route.
 *
 * @param overrides - context members to override.
 * @returns the captured route.
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
	return route;
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
	const route = mountRoute();
	assert.equal(route.kind, "exact");
	assert.equal(route.path, "/coding-probe/run");
});
test("the plugin declares the services it reads", () => {
	// Regression: reading an undeclared service throws at apply time, failing
	// the whole entry rather than the one request.
	assert.deepEqual(inject, ["webServer", "llm"]);
});
test("the host gate is called bound to the connection service", async () => {
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
	await route.handler({ method: "POST" }, fakeRes());
	assert.equal(sawThis, connection);
});
test("a gate rejection is honoured with its own status", async () => {
	const route = mountRoute({ get: () => ({ requestRejection: () => 401 }) });
	const res = fakeRes();
	await route.handler({ method: "POST" }, res);
	assert.equal(res.statusCode, 401);
});
test("an unsupported method is refused", async () => {
	const route = mountRoute();
	const res = fakeRes();
	await route.handler({ method: "DELETE" }, res);
	assert.equal(res.statusCode, 405);
});
test("a GET returns the manifest without running the battery", async () => {
	// Regression: GET used to fall through to runBattery, so inspecting the
	// route with curl hung for minutes and looked like a broken route.
	let streamed = false;
	const route = mountRoute({
		llm: { listModels: async () => [{ id: "probe-model" }], stream: () => { streamed = true; throw new Error("must not stream"); } }
	});
	const res = fakeRes();
	await route.handler({ method: "GET" }, res);
	const payload = JSON.parse(res.body);
	assert.equal(res.statusCode, 200);
	assert.equal(payload.probes.length, PROBES.length);
	assert.equal(payload.models, undefined, "GET must not run models");
	assert.deepEqual(payload.targets, ["a1/probe-model"]);
	assert.equal(streamed, false, "GET must not call the model route");
});

const total = passed + failed + skipped;
console.log(`\n${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ""} (of ${total})`);
process.exit(failed === 0 ? 0 : 1);
