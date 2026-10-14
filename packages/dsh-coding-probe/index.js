/**
 * coding-probe — executable probes for high-complexity code generation.
 *
 * ## Why this exists instead of a chat probe
 *
 * A chat probe cannot see this failure. Measured on the `a1` route: the models
 * answered 8/8 hard arithmetic and combinatorics problems correctly, and still
 * shipped 3D scenes that rendered black. Their reasoning was intact; what
 * degraded was the ability to *hold a large multi-part program together* — in
 * the captured failure, calling WebGL 2 entry points (`createVertexArray`) on a
 * WebGL 1 context, which throws and leaves the canvas at its default 300x150.
 *
 * Three properties of the failure, each measured, shaped this design:
 *
 * 1. **It is complexity-dependent.** A 64x64 triangle probe passes on a route
 *    that cannot produce a working 40 KB scene. A probe that is too small
 *    reports "healthy" for a degraded route.
 * 2. **It is intermittent.** Repeating the same complex brief, only 1 of 3
 *    generations completed; the rest died at the gateway. A single trial cannot
 *    measure a rate.
 * 3. **It has two distinct shapes.** Either the generation never completes
 *    (HTTP 524 at ~120 s), or it completes and the code does not run. Those
 *    need different responses, so they are counted separately.
 *
 * ## How it grades
 *
 * Every probe asks for a program, executes it, and grades the program's
 * observable behaviour — never its source text. For rendering probes the page
 * is loaded in headless Chrome and the framebuffer is read back *late* (the
 * scene must have finished initialising), then a render counts as real only if
 * the canvas is non-black **and** contains a plausible number of distinct
 * colours. "No exception was thrown" is deliberately NOT sufficient: the
 * captured 40 KB failure threw nothing and painted nothing.
 *
 * ## The control/target split
 *
 * A `control` tier that a degraded route still passes is the point, not a
 * formality: "simple passes, complex fails" is the signature. Without the
 * control, a total outage and a complexity-specific collapse look identical.
 *
 * @module dsh-coding-probe
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const name = "coding-probe";

/** Route prefix owned by this plugin. Served outside `/api` behind an origin gate. */
const ROUTE_PREFIX = "/coding-probe";

/**
 * Services this plugin requires.
 *
 * `webServer` hosts the probe route; `llm` supplies the model routes, so probes
 * exercise the real configured route (including any prompt injection, reasoning
 * cap, or throttling) rather than a hand-rolled HTTP call that would bypass it.
 */
const inject = ["webServer", "llm"];

/**
 * Headless Chrome flags.
 *
 * `--disable-gpu` plus SwiftShader still provides a real WebGL implementation,
 * which is what the render probes need; a GPU would make results machine-
 * dependent. `--user-data-dir` is per-run so concurrent probes cannot collide.
 */
const CHROME_FLAGS = [
	"--headless=new",
	"--disable-gpu",
	"--no-sandbox",
	"--no-proxy-server",
	"--no-first-run",
	"--disable-extensions",
	"--hide-scrollbars"
];

/**
 * The complex brief.
 *
 * This is the task that actually triggered the captured degradation, kept
 * verbatim rather than paraphrased. It is long on purpose: it requires a
 * hand-written matrix stack, a shader pipeline, a multi-object 3D scene, Chinese
 * brand copy, UI chrome, responsive breakpoints, accessibility labels, and
 * pointer interaction. A route that has lost the ability to hold that together
 * fails here and passes every smaller probe.
 */
const COMPLEX_BRIEF = [
	"创建一个单文件 HTML 页面，主题是“鹈鹕星际速递”，要做出完整的产品级体验：",
	"",
	"1. 用纯手写 WebGL（不要用 Three.js 或任何外部库）：自己写着色器、自己实现 perspective / lookAt / mat4 矩阵乘法，渲染一个完整的 3D 场景——一只鹈鹕驾驶小飞机，穿越星空，下方有一个漂浮的星球，星球上有道路、树木、旗子，还有一个外星人角色。",
	"2. 页面要有完整的中文品牌文案与排版：主标题、副标题、订单编号、目的地坐标。",
	"3. 要有 UI 组件：任务进度步骤条、倒计时、暂停/旋转按钮、CTA 按钮。",
	"4. 要有响应式断点，适配宽屏/平板/手机。",
	"5. 要有无障碍标签。",
	"6. 要支持鼠标拖拽旋转视角、滚轮缩放、空格暂停。",
	"",
	"只输出 HTML，不要任何解释。"
].join("\n");

/**
 * The probe battery.
 *
 * `control` probes are cheap and should pass even on a degraded route; `target`
 * probes are the actual test. Each `check` is a function of executed evidence,
 * never of source text.
 */
const PROBES = [
	{
		id: "scheduler",
		tier: "control",
		kind: "node",
		label: "事件循环时序",
		about: "microtask/macrotask 语义，快速探底：连这个都错说明能力整体塌了",
		prompt: [
			"Write a Node.js script with these statements in this exact order:",
			"1. push 'A' to an array called log",
			"2. setTimeout(() => log.push('D'), 0)",
			"3. Promise.resolve().then(() => log.push('C'))",
			"4. push 'B' to log",
			"After a 10ms timer, print ONLY a JSON object: {\"order\": \"<log joined>\"}.",
			"No explanation, no markdown fences."
		].join("\n"),
		check: (evidence) => {
			const got = lastJson(evidence.stdout)?.order;
			return { ok: got === "ABCD", detail: `order=${got} expected=ABCD` };
		}
	},
	{
		id: "simple_gl",
		tier: "control",
		kind: "render",
		label: "WebGL 小三角形",
		about: "最基础的 WebGL 管线。退化路由通常仍能通过——这正是对照组的意义",
		prompt: [
			"Write a single self-contained HTML file that draws a solid green",
			"(RGB 0,255,0) triangle covering the whole canvas, using raw WebGL.",
			"The canvas must be 64x64. Use plain JavaScript only - no libraries,",
			"no CDN, no Three.js. The triangle must fill the entire canvas.",
			"Output ONLY the HTML, no explanation, no markdown fences."
		].join("\n"),
		check: (evidence) => {
			const ok = evidence.error === null && evidence.greenRatio >= 0.95;
			return { ok, detail: `greenRatio=${round(evidence.greenRatio)} error=${evidence.error ?? "none"}` };
		}
	},
	{
		// The "pelican" test, popularized by Simon Willison in 2024 and now the
		// de-facto open coding-capability benchmark: one prompt, one small SVG, and
		// a pass/fail a human can check at a glance. It is here as a *target*-tier
		// probe rather than a control because the interesting property is not "can
		// you draw" — a degenerate route still emits a plausible rectangle — but
		// "can you hold a multi-part spatial composition in one pass".
		id: "pelican",
		tier: "target",
		kind: "render",
		label: "鹈鹕骑自行车（SVG）",
		about: "2024 年在网络上传开的经典测智商题：一段 SVG，同时画出一只鹈鹕、一辆自行车和一片海。结构简单但要素多，是判断模型是否真的在画而不是在套模板的试金石",
		prompt: [
			"Draw a pelican riding a bicycle as a single self-contained SVG.",
			"The picture must contain ALL of these elements, clearly visible:",
			"1. A pelican (a bird with a large beak and pouch),",
			"2. A bicycle with two spoked wheels, a frame, handlebars and a seat,",
			"3. Water or a shoreline in the background.",
			"Output ONLY the raw SVG markup, starting with <svg. No HTML wrapper,",
			"no markdown fences, no explanation, no CSS, no JavaScript.",
			`Size it around ${800} by ${500}.`
		].join("\n"),
		check: (evidence) => {
			// Graded on what actually painted, not on what the markup claims:
			//
			//   - something must have rendered at a usable size;
			//   - it must not be blank or a single flat fill;
			//   - it must carry enough distinct colours to be a drawing with parts
			//     rather than one shape (a blank SVG scores 1-2, a real scene 20+).
			//
			// A blank but error-free page is the failure this battery exists to catch,
			// so `error === null` alone is deliberately not enough.
			const ok =
				evidence.error === null &&
				evidence.nonblackRatio >= 0.01 &&
				evidence.distinctColors >= 8;
			return {
				ok,
				detail: `nonblack=${round(evidence.nonblackRatio)} colors=${evidence.distinctColors} ` +
					`size=${evidence.canvasW}x${evidence.canvasH} error=${evidence.error ?? "none"}`
			};
		}
	},
	{
		id: "complex_scene",
		tier: "target",
		kind: "complex",
		label: "复杂 3D 场景（真实 brief）",
		about: "手写矩阵栈 + 着色器 + 多物体场景 + 中文排版 + UI + 响应式 + 无障碍 + 交互",
		prompt: COMPLEX_BRIEF,
		/**
		 * Grade one completed generation.
		 *
		 * A render counts only when the canvas is actually non-black and has a
		 * plausible spread of colours. Requiring "no exception" alone would pass
		 * the captured failure, which threw nothing and painted nothing.
		 *
		 * @param evidence - measurement from {@link measureRender}.
		 * @returns `{ok, detail}`.
		 */
		check: (evidence) => {
			if (evidence.error !== null) return { ok: false, detail: `运行时报错：${evidence.error}` };
			const rendered = evidence.nonblackRatio > 0.01 && evidence.distinctColors >= 8;
			if (!rendered) {
				return {
					ok: false,
					detail: `未渲染出内容（非黑像素 ${round(evidence.nonblackRatio * 100)}%，颜色数 ${evidence.distinctColors}，画布 ${evidence.canvasW}x${evidence.canvasH}）`
				};
			}
			return {
				ok: true,
				detail: `已渲染（非黑像素 ${round(evidence.nonblackRatio * 100)}%，颜色数 ${evidence.distinctColors}，画布 ${evidence.canvasW}x${evidence.canvasH}）`
			};
		}
	}
];

/** Conservative defaults; every field is overridable from the profile patch. */
const DEFAULTS = {
	/**
	 * Provider route to probe; empty means every provider the profile has
	 * configured.
	 *
	 * Deliberately *not* a vendor id baked into the source: this plugin is
	 * installed into any profile, and a hard-coded route either fails outright
	 * (`listModels` on an unknown provider) or silently preselects models the
	 * user never configured. Empty is the honest default — the profile is the
	 * source of truth — and a non-empty value narrows the selection.
	 */
	provider: "",
	/** Substring filter applied to the configured models; empty means no filter. */
	modelPattern: "",
	/** Explicit `provider/model` list; overrides provider + modelPattern when set. */
	models: [],
	/**
	 * Probe ids to run; empty means every probe in {@link PROBES}.
	 *
	 * A full battery is expensive (the complex brief runs
	 * {@link DEFAULTS.complexTrials} times per model), so the panel lets the
	 * user run only the part they care about instead of always paying for all
	 * of it.
	 */
	probes: [],
	/** Reasoning effort forwarded to the route; `null` omits the field entirely. */
	reasoningEffort: "high",
	/** Max output tokens per probe. The complex brief needs room. */
	maxTokens: 32000,
	/** Per-request wall clock budget in milliseconds. */
	timeoutMs: 200000,
	/** Execution budget for one generated Node program. */
	execTimeoutMs: 20000,
	/** Browser budget for one render measurement. */
	renderTimeoutMs: 90000,
	/**
	 * How long to wait before reading the framebuffer back.
	 *
	 * Sampling too early is a real false-negative: the captured good scene still
	 * reported a black canvas at 800 ms and rendered fully by 2500 ms.
	 */
	sampleDelayMs: 3000,
	/** Path to the headless browser. */
	chromePath: "google-chrome",
	/** How many times to repeat the complex target. One trial cannot show a rate. */
	complexTrials: 3,
	/** Probes to run concurrently. Kept at 1: gateways throttle hard. */
	concurrency: 1,
	/** Pause between probes in milliseconds. */
	spacingMs: 2000
};

/** Round to two decimals for readable evidence. */
function round(n) {
	return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Parse the last JSON object appearing in a program's stdout.
 *
 * Models often print progress lines before the answer, so the last object is the
 * answer by the prompts' own convention.
 *
 * @param stdout - captured standard output.
 * @returns the parsed object, or `undefined`.
 */
function lastJson(stdout) {
	const text = String(stdout ?? "");
	const matches = text.match(/\{[^{}]*\}/g);
	if (matches === null || matches.length === 0) return undefined;
	try {
		return JSON.parse(matches[matches.length - 1]);
	} catch {
		return undefined;
	}
}

/**
 * Strip markdown fences and prose from a model reply that should be raw code.
 *
 * Prompts ask for bare code, but a model may still wrap it. Recovering the code
 * is fair: the question is whether the program works, not whether it was wrapped.
 *
 * @param text - the model's raw reply.
 * @returns the extracted code.
 */
function extractCode(text) {
	const raw = String(text ?? "");
	const fenced = /```[a-zA-Z0-9]*\n([\s\S]*?)```/.exec(raw);
	if (fenced !== null) return fenced[1].trim();
	const html = /<(!doctype|html)[\s\S]*>/i.exec(raw);
	if (html !== null) return raw.slice(html.index).trim();
	return raw.trim();
}

/**
 * Run a generated Node.js program and capture its output.
 *
 * @param code - the program source.
 * @param config - the resolved plugin config.
 * @returns `{stdout, stderr, status, timedOut}`.
 */
function runNode(code, config) {
	const dir = mkdtempSync(join(tmpdir(), "coding-probe-"));
	try {
		const file = join(dir, "program.mjs");
		writeFileSync(file, code, "utf8");
		const result = spawnSync(process.execPath, [file], {
			cwd: dir,
			timeout: config.execTimeoutMs,
			encoding: "utf8",
			env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "" }
		});
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			status: result.status,
			timedOut: result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM"
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Wrap a model's HTML so its rendered output is machine-readable.
 *
 * Two details make the readback trustworthy, and both must be installed BEFORE
 * the model's own script runs:
 *
 * 1. `payload` is declared in the preamble, not inside the probe's `try` block,
 *    or the title assignment throws ReferenceError and no result is reported.
 * 2. `preserveDrawingBuffer` is forced on. A WebGL drawing buffer is cleared
 *    after compositing, so reading pixels from a later task returns an empty
 *    canvas and a perfectly good scene scores zero.
 *
 * The measurement runs on a delay so the scene has finished initialising, and
 * reports the canvas dimensions as well as the pixel statistics — the captured
 * failure never resized its canvas from the 300x150 default, which is itself
 * evidence that its setup code never completed.
 *
 * @param html - the model's HTML.
 * @param measure - whether to measure pixels (false for a console-only check).
 * @param delayMs - how long to wait before measuring.
 * @returns the instrumented HTML.
 */
function instrument(html, measure, delayMs = 3000) {
	const body = measure
		? `
		payload = { error: window.__probeError };
		try {
			const canvases = document.querySelectorAll('canvas');
			payload.canvases = canvases.length;
			if (canvases.length > 0) {
				const c = canvases[0];
				measureInto(c, c.width, c.height, false);
			} else {
				payload.__pendingSvg = true;
			}
		} catch (e) { payload.error = payload.error || String(e); }`
		: "payload = { error: window.__probeError };";

	return `<!doctype html><html><head><title>PENDING</title><script>
var payload = null;
window.__probeError = null;
window.addEventListener('error', (e) => { if (window.__probeError === null) window.__probeError = String(e.message || e.error); });
window.addEventListener('unhandledrejection', (e) => { if (window.__probeError === null) window.__probeError = 'unhandledrejection: ' + String(e.reason); });
(function () {
	var original = HTMLCanvasElement.prototype.getContext;
	HTMLCanvasElement.prototype.getContext = function (type, attrs) {
		if (String(type).indexOf('webgl') === 0) {
			return original.call(this, type, Object.assign({ preserveDrawingBuffer: true }, attrs || {}));
		}
		return original.call(this, type, attrs);
	};
})();
</script></head><body>
${html}
<script>
(function () {
	// Report once the pixel walk is done. The canvas path is synchronous; the
	// SVG path has to wait for an Image decode, so publishing is deferred until
	// the measurement it depends on has actually run.
	function publish() {
		if (payload === null) payload = { error: window.__probeError };
		document.title = 'PROBE_RESULT:' + JSON.stringify(payload);
	}
	// Walk the pixels of either a <canvas> or an inline <svg>.
	// An SVG page (the pelican test) draws nothing onto a canvas, so measuring
	// only <canvas> would score a perfect picture as 0x0. Rasterizing needs an
	// Image load, which is async, so the caller hands the finished <img> in.
	function measureInto(source, w, h, blankIsWhite) {
		payload.canvasW = w; payload.canvasH = h;
		const tmp = document.createElement('canvas');
		tmp.width = w; tmp.height = h;
		const g = tmp.getContext('2d');
		if (blankIsWhite) {
			g.fillStyle = '#ffffff';
			g.fillRect(0, 0, w, h);
		}
		g.drawImage(source, 0, 0, w, h);
		const data = g.getImageData(0, 0, w, h).data;
		let green = 0, blue = 0, nonblack = 0, total = 0;
		const seen = new Set();
		for (let i = 0; i < w * h; i++) {
			const r = data[i*4], gg = data[i*4+1], b = data[i*4+2];
			total++;
			if (gg > 128 && r < 128 && b < 128) green++;
			if (b > 128 && r < 128 && gg < 128) blue++;
			// On the SVG path the raster starts white, so near-white is the empty
			// page rather than ink; counting it would pass a blank drawing.
			if (blankIsWhite && r > 240 && gg > 240 && b > 240) { /* paper, not ink */ }
			else if (r > 12 || gg > 12 || b > 12) nonblack++;
			seen.add((r >> 4) + ',' + (gg >> 4) + ',' + (b >> 4));
		}
		payload.greenRatio = total ? green / total : 0;
		payload.blueRatio = total ? blue / total : 0;
		payload.nonblackRatio = total ? nonblack / total : 0;
		payload.distinctColors = seen.size;
	}
	function svgFallback() {
		try {
			const svgs = document.querySelectorAll('svg');
			payload.svgs = svgs.length;
			if (svgs.length === 0) {
				payload.error = payload.error || 'no canvas or svg element';
				publish();
				return;
			}
			const s = svgs[0];
			const box = s.getBoundingClientRect();
			const w = Math.round(box.width) || Number(s.getAttribute('width')) || 800;
			const h = Math.round(box.height) || Number(s.getAttribute('height')) || 600;
			// Cap the raster: a large viewBox would slow the pixel walk and the
			// verdict does not depend on resolution.
			const scale = Math.min(1, 1000 / Math.max(w, h));
			const rw = Math.max(1, Math.round(w * scale));
			const rh = Math.max(1, Math.round(h * scale));
			// Inline styles and external references do not survive serialization, so
			// the markup is wrapped as a standalone document before rasterizing.
			const markup = new XMLSerializer().serializeToString(s);
			const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
			const img = new Image();
			img.onload = () => { try { measureInto(img, rw, rh, true); } catch (e) { payload.error = payload.error || String(e); } publish(); };
			img.onerror = () => { payload.error = payload.error || 'svg could not be rasterized'; publish(); };
			img.src = url;
		} catch (e) { payload.error = payload.error || String(e); publish(); }
	}
	setTimeout(() => {
		try {
			${body}
		} catch (e) { payload = { error: String(e) }; publish(); return; }
		if (payload && payload.__pendingSvg) { delete payload.__pendingSvg; svgFallback(); return; }
		publish();
	}, ${Math.max(0, Number(delayMs) || 0)});
})();
</script>
</body></html>`;
}

/**
 * Load an HTML page in headless Chrome and measure what it rendered.
 *
 * @param html - the model's HTML.
 * @param config - the resolved plugin config.
 * @param measure - whether to measure pixels.
 * @returns the measurement, including any uncaught error and console failures.
 */
function measureRender(html, config, measure = true) {
	const dir = mkdtempSync(join(tmpdir(), "coding-probe-"));
	try {
		const file = join(dir, "page.html");
		writeFileSync(file, instrument(html, measure, config.sampleDelayMs), "utf8");
		const result = spawnSync(config.chromePath, [
			...CHROME_FLAGS,
			`--user-data-dir=${join(dir, "profile")}`,
			`--virtual-time-budget=${Math.max(4000, Number(config.sampleDelayMs) + 3000)}`,
			"--enable-logging=stderr",
			"--v=0",
			"--dump-dom",
			`file://${file}`
		], { timeout: config.renderTimeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		const dom = result.stdout ?? "";
		const stderr = result.stderr ?? "";
		// The title is HTML-escaped by --dump-dom, so unescape before parsing.
		const unescaped = dom.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'");
		const match = /PROBE_RESULT:(\{[\s\S]*?\})/.exec(unescaped);
		let payload = {};
		if (match !== null) {
			try {
				payload = JSON.parse(match[1]);
			} catch {
				payload = {};
			}
		}
		const consoleErrors = stderr
			.split("\n")
			.filter((line) => /Uncaught|Unhandled|SyntaxError|TypeError|ReferenceError/.test(line))
			.map((line) => line.trim().slice(0, 300));
		return {
			error: payload.error ?? null,
			greenRatio: payload.greenRatio ?? 0,
			blueRatio: payload.blueRatio ?? 0,
			nonblackRatio: payload.nonblackRatio ?? 0,
			distinctColors: payload.distinctColors ?? 0,
			canvasW: payload.canvasW ?? 0,
			canvasH: payload.canvasH ?? 0,
			canvases: payload.canvases ?? 0,
			svgs: payload.svgs ?? 0,
			consoleErrors,
			domLoaded: dom.length > 0,
			chromeStatus: result.status
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Grade one model reply for one probe by executing it.
 *
 * @param probe - the probe definition.
 * @param reply - the model's raw reply.
 * @param config - the resolved plugin config.
 * @returns the grading outcome plus raw evidence.
 */
function execute(probe, reply, config) {
	const code = extractCode(reply);
	if (code.length === 0) return { ok: false, detail: "空回复", evidence: {} };
	if (probe.kind === "node") {
		const evidence = runNode(code, config);
		let graded;
		try {
			graded = probe.check(evidence);
		} catch (error) {
			graded = { ok: false, detail: `check failed: ${error.message}` };
		}
		return {
			...graded,
			evidence: {
				status: evidence.status,
				timedOut: evidence.timedOut,
				stdout: String(evidence.stdout).slice(0, 400),
				stderr: String(evidence.stderr).slice(0, 300)
			}
		};
	}
	const evidence = measureRender(code, config, true);
	let graded;
	try {
		graded = probe.check(evidence);
	} catch (error) {
		graded = { ok: false, detail: `check failed: ${error.message}` };
	}
	return {
		...graded,
		evidence: {
			error: evidence.error,
			greenRatio: round(evidence.greenRatio),
			blueRatio: round(evidence.blueRatio),
			nonblackRatio: round(evidence.nonblackRatio),
			distinctColors: evidence.distinctColors,
			canvasW: evidence.canvasW,
			canvasH: evidence.canvasH,
			consoleErrors: evidence.consoleErrors.slice(0, 3)
		}
	};
}

/**
 * Consume one `llm.stream` iterable into text, usage, and terminal reason.
 *
 * Usage arrives as its own chunk type, and a failed call terminates as a
 * `finish` chunk whose reason is `{kind:'error'}` rather than by throwing.
 *
 * @param stream - the async iterable returned by the llm service.
 * @returns the accumulated text, reasoning, usage, and finish reason.
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
 * Precedence, highest first:
 *  1. `requested` — the models the user ticked in the panel (or posted to the
 *     route). This is the normal path: the panel always sends an explicit list,
 *     so the probe never silently grades a different set than the user chose.
 *  2. `config.models` — an explicit list pinned in the profile patch.
 *  3. The profile's own configured routes: `config.provider` when set, otherwise
 *     every provider `llm` reports, optionally narrowed by `config.modelPattern`.
 *
 * The third step is what keeps this plugin free of a baked-in vendor id. It
 * reads the same catalog `llm` already built from the profile, so the panel's
 * default selection is "what this machine is actually configured with" — which
 * is the only answer that is correct on every profile the plugin is installed
 * into.
 *
 * @param ctx - the plugin context.
 * @param config - the resolved plugin config.
 * @param requested - optional explicit selection from the request.
 * @returns the `{provider, model}` pairs to probe.
 */
async function resolveTargets(ctx, config, requested) {
	if (Array.isArray(requested) && requested.length > 0) {
		return parseSelection(requested, config.provider);
	}
	if (Array.isArray(config.models) && config.models.length > 0) {
		return parseSelection(config.models, config.provider);
	}
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
 * as configured, so the plugin never names a vendor that the profile may not
 * even define.
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
 * The probes a run should execute.
 *
 * An absent selection means the whole battery; an explicit selection is
 * filtered to known ids in {@link PROBES} order, so a stale client cannot make
 * a run report results for a probe that does not exist.
 *
 * @param ids - requested probe ids, or `undefined` for "all".
 * @returns the probes to run, in battery order.
 */
function resolveProbes(ids) {
	if (!Array.isArray(ids)) return [...PROBES];
	const wanted = new Set(ids.map((id) => String(id).trim()));
	return PROBES.filter((probe) => wanted.has(probe.id));
}

/**
 * Describe probes for the panel, without shipping their prompts or graders.
 *
 * @param probes - probes to describe.
 * @returns serialisable descriptors.
 */
function describeProbes(probes) {
	return probes.map((p) => ({ id: p.id, label: p.label, tier: p.tier, kind: p.kind, about: p.about }));
}

/**
 * List every provider/model the panel can offer, so the user picks instead of
 * relying on a hard-coded pattern.
 *
 * A provider whose catalog fails is reported with its error and skipped rather
 * than failing the whole listing: one unreachable route must not hide the
 * models that are reachable.
 *
 * @param ctx - the plugin context.
 * @returns `{providers, models}` where `models` is a flat `provider/model` list.
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
	models.sort((a, b) => (a.provider === b.provider
		? a.model.localeCompare(b.model)
		: a.provider.localeCompare(b.provider)));
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
			req.resume();
			return "";
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, size).toString("utf8");
}

/**
 * Read and parse a POST body once.
 *
 * The request stream can only be consumed a single time, so both the model and
 * the probe selection have to come out of this one read — reading the body
 * twice would silently lose whichever field came second.
 *
 * @param req - the incoming request.
 * @returns the parsed object, or `{}` when the body is absent, oversized, or
 *   not a JSON object.
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
 * Read the requested probe selection out of a parsed body.
 *
 * Absent means "the whole battery" (an older client, or a scripted run). A
 * present-but-empty selection is reported as an empty array rather than
 * silently upgraded to every probe: the route turns that into a 400, because
 * running the full battery when the user asked for none would be the expensive
 * version of ignoring them.
 *
 * @param body - the parsed POST body.
 * @returns the requested probe ids, or `undefined` when the field is absent.
 */
function probesFrom(body) {
	const raw = body?.probes;
	if (!Array.isArray(raw)) return undefined;
	const known = new Set(PROBES.map((p) => p.id));
	return raw.map((p) => String(p).trim()).filter((id) => known.has(id));
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
 * Ask one model for one program, once.
 *
 * Generation failure and generation success are distinguished, because the two
 * failure shapes need different responses: a gateway timeout means the work
 * never arrived, while a completed generation that does not run means the model
 * produced broken code.
 *
 * @param ctx - the plugin context.
 * @param target - the `{provider, model}` pair under test.
 * @param prompt - the probe prompt.
 * @param config - the resolved plugin config.
 * @returns `{ok, text, ms, error}`.
 */
async function generate(ctx, target, prompt, config) {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.timeoutMs);
	try {
		const options = {
			provider: target.provider,
			model: target.model,
			// `content` is a readonly array of content blocks, not a bare string:
			// adapters call `content.some(...)`, so a string fails with
			// "content.some is not a function" and every probe looks like a miss.
			messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
			maxTokens: config.maxTokens,
			signal: controller.signal
		};
		if (config.reasoningEffort !== null && config.reasoningEffort !== undefined) {
			options.reasoningEffort = config.reasoningEffort;
		}
		const { text, reasoning, usage, reason } = await drainStream(ctx.llm.stream(options));
		const failed = reason !== undefined && reason.kind !== "stop" && reason.kind !== "max-tokens";
		return {
			ok: !failed && String(text).length > 0,
			text,
			ms: Date.now() - started,
			reasoningChars: reasoning.length,
			outputTokens: usage?.outputTokens ?? null,
			finish: reason?.kind ?? null,
			error: failed ? String(reason?.failure?.message ?? reason?.kind) : null
		};
	} catch (error) {
		return { ok: false, text: "", ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Run one single-shot probe (control tier).
 *
 * @param ctx - the plugin context.
 * @param target - the `{provider, model}` pair under test.
 * @param probe - one entry of {@link PROBES}.
 * @param config - the resolved plugin config.
 * @returns a structured result record.
 */
async function runSingle(ctx, target, probe, config) {
	const generated = await generate(ctx, target, probe.prompt, config);
	if (!generated.ok) {
		const message = generated.error ?? "空回复";
		// `refused` marks a request the gateway rejected before the model saw it.
		// The control tier needs this as much as the target tier does: both of its
		// probes are single-shot, so two 429s would otherwise read as "基础能力
		// 退化" — a capability claim built entirely on the gateway's own refusals.
		const cause = classifyFailure(message);
		const refused = cause === "rate-limit" || cause === "transport" ? 1 : 0;
		return {
			id: probe.id,
			label: probe.label,
			tier: probe.tier,
			kind: probe.kind,
			about: probe.about,
			ok: false,
			refusedCount: refused,
			detail: refused > 0 ? "请求被网关拒绝，未到达模型" : "生成失败",
			error: message,
			ms: generated.ms
		};
	}
	const graded = execute(probe, generated.text, config);
	return {
		id: probe.id,
		label: probe.label,
		tier: probe.tier,
		kind: probe.kind,
		about: probe.about,
		ok: graded.ok,
		detail: graded.detail,
		evidence: graded.evidence,
		ms: generated.ms,
		outputTokens: generated.outputTokens,
		reasoningChars: generated.reasoningChars,
		codeChars: extractCode(generated.text).length,
		finish: generated.finish
	};
}

/**
 * Classify why a generation did not produce usable text.
 *
 * The distinction is load-bearing for accuracy. A request the gateway *refused*
 * (429 rate limit, 5xx, a dropped socket) is not evidence about the model's
 * coding ability at all — counting it as a failure makes a throttled run look
 * like a degraded model, which is the one mistake this battery must not make.
 *
 * @param error - the failure text from {@link generate}.
 * @returns `rate-limit` | `timeout` | `transport` | `generation`.
 */
function classifyFailure(error) {
	const text = String(error ?? "").toLowerCase();
	if (text.includes("429") || text.includes("rate limit") || text.includes("rate_limit")) return "rate-limit";
	if (text.includes("timeout") || text.includes("timed out") || text.includes("abort")) return "timeout";
	if (text.includes("502") || text.includes("503") || text.includes("504") || text.includes("econnreset") || text.includes("socket")) return "transport";
	return "generation";
}

/**
 * Run one repeated probe (target tier) and report a rate, not a single result.
 *
 * A single trial cannot distinguish an intermittently failing route from a
 * healthy one: measured on this gateway, the same complex brief completed 1 time
 * out of 3, and the completed attempt still produced a blank scene. Both counts
 * are reported so the failure shape is visible.
 *
 * @param ctx - the plugin context.
 * @param target - the `{provider, model}` pair under test.
 * @param probe - one entry of {@link PROBES}.
 * @param config - the resolved plugin config.
 * @returns a structured result record with per-trial detail.
 */
async function runRepeated(ctx, target, probe, config) {
	const trials = [];
	const attempts = Math.max(1, Number(config.complexTrials) || 1);
	for (let i = 1; i <= attempts; i += 1) {
		const generated = await generate(ctx, target, probe.prompt, config);
		if (!generated.ok) {
			const message = generated.error ?? "空回复";
			trials.push({ attempt: i, generated: false, error: message, cause: classifyFailure(message), ms: generated.ms });
		} else {
			const graded = execute(probe, generated.text, config);
			trials.push({
				attempt: i,
				generated: true,
				ok: graded.ok,
				detail: graded.detail,
				evidence: graded.evidence,
				ms: generated.ms,
				codeChars: extractCode(generated.text).length
			});
		}
		if (i < attempts && config.spacingMs > 0) await new Promise((r) => setTimeout(r, config.spacingMs));
	}
	const generatedCount = trials.filter((t) => t.generated).length;
	const renderedCount = trials.filter((t) => t.generated && t.ok).length;
	const timedOut = trials.length - generatedCount;
	// Trials the gateway refused never reached the model, so they are counted
	// separately and excluded from the capability verdict.
	const refusedCount = trials.filter((t) => t.cause === "rate-limit" || t.cause === "transport").length;
	return {
		id: probe.id,
		label: probe.label,
		tier: probe.tier,
		kind: probe.kind,
		about: probe.about,
		ok: renderedCount === attempts,
		attempts,
		generatedCount,
		renderedCount,
		timedOut,
		refusedCount,
		detail: `${attempts} 次尝试：生成成功 ${generatedCount} 次，其中渲染成功 ${renderedCount} 次，超时/失败 ${timedOut} 次${refusedCount > 0 ? `（其中 ${refusedCount} 次被网关拒绝，未到达模型）` : ""}`,
		trials
	};
}

/**
 * Score one route's probe results into a verdict.
 *
 * The verdict separates the failure shapes that need different responses, and
 * uses the control tier to tell a total outage apart from a complexity-specific
 * collapse. That distinction is the reason the battery is split at all.
 *
 * Trials the gateway refused (429/5xx) are excluded from the capability
 * judgement and reported as `inconclusive` when too little usable evidence is
 * left. Counting a rate limit as a failed generation would make a throttled run
 * indistinguishable from a degraded model, and that is precisely the wrong
 * conclusion for this tool to reach.
 *
 * @param results - the probe records for one route.
 * @returns the score, tier breakdown, and verdict.
 */
function score(results) {
	const byTier = (tier) => results.filter((row) => row.tier === tier);
	const countOk = (rows) => rows.filter((row) => row.ok).length;
	const control = byTier("control");
	const target = byTier("target");
	const allErrored = results.length > 0 && results.every((row) => row.error !== undefined);
	const targetRendered = target.reduce((sum, row) => sum + (row.renderedCount ?? (row.ok ? 1 : 0)), 0);
	const targetAttempts = target.reduce((sum, row) => sum + (row.attempts ?? 1), 0);
	const targetGenerated = target.reduce((sum, row) => sum + (row.generatedCount ?? (row.error === undefined ? 1 : 0)), 0);
	const targetRefused = target.reduce((sum, row) => sum + (row.refusedCount ?? 0), 0);
	const controlRefused = control.filter((row) => (row.refusedCount ?? 0) > 0).length;
	// Attempts that actually reached the model and produced code.
	const usableAttempts = Math.max(0, targetAttempts - targetRefused);
	// Control probes the gateway refused tell us nothing about basic ability, so
	// they are excluded from that judgement rather than counted as failures.
	const controlUsable = control.length - controlRefused;
	const controlPassed = countOk(control);

	let verdict;
	if (allErrored) verdict = "unreachable";
	// A control probe that really ran and failed is capability evidence, and it
	// outranks everything below.
	else if (controlUsable > 0 && controlPassed < controlUsable) verdict = "degraded";
	// No usable evidence at either tier: every request was refused upstream, so
	// no capability claim can be made in either direction.
	else if (controlUsable === 0 && usableAttempts === 0) verdict = "inconclusive";
	// The controls passed but every complex attempt was refused, so the question
	// the battery exists to answer was never actually put to the model.
	else if (targetAttempts > 0 && usableAttempts === 0) verdict = "inconclusive";
	else if (usableAttempts > 0 && targetRendered === 0) verdict = targetGenerated > 0 ? "broken-code" : "timeout-bound";
	else if (usableAttempts > 0 && targetRendered < usableAttempts) verdict = "unstable";
	// Only the control tier ran. Calling that "healthy" would overclaim: the
	// controls can show that basic ability is intact, never that complex
	// generation works — and the panel now lets the user run them alone.
	else if (targetAttempts === 0) verdict = controlPassed > 0 ? "control-only" : "inconclusive";
	// The controls were all refused, so the target result stands on its own.
	else if (controlUsable === 0) verdict = targetRendered > 0 ? "healthy" : "inconclusive";
	else verdict = "healthy";

	return {
		total: results.length,
		passed: countOk(results),
		control: { total: control.length, passed: controlPassed, refused: controlRefused, usable: controlUsable },
		target: { total: targetAttempts, passed: targetRendered, generated: targetGenerated, refused: targetRefused, usable: usableAttempts },
		verdict
	};
}

/**
 * Run the battery over a list of targets, bounded and paced.
 *
 * @param ctx - the plugin context.
 * @param targets - the routes to probe.
 * @param probes - the probes to run, in battery order.
 * @param config - the resolved plugin config.
 * @param report - optional live report; each finished model is pushed into it
 *   as it completes so a polling reader sees partial results.
 * @returns a promise of model reports.
 */
async function runBattery(ctx, targets, probes, config, report) {
	const reports = report?.models ?? [];
	const queue = [...targets];
	const worker = async () => {
		for (;;) {
			const target = queue.shift();
			if (target === undefined) return;
			const results = [];
			for (const probe of probes) {
				results.push(probe.kind === "complex"
					? await runRepeated(ctx, target, probe, config)
					: await runSingle(ctx, target, probe, config));
				if (config.spacingMs > 0) await new Promise((r) => setTimeout(r, config.spacingMs));
			}
			reports.push({ provider: target.provider, model: target.model, score: score(results), results });
		}
	};
	const width = Math.max(1, Math.min(Number(config.concurrency) || 1, 2));
	await Promise.all(Array.from({ length: width }, worker));
	return reports;
}

/**
 * Create the single-slot run registry.
 *
 * A battery takes minutes, and the panel that started it can be unmounted at
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
		 * @param work - the async battery.
		 * @returns `{job, done}`; `done` settles when the battery does.
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
			// The report is built up as the battery goes, not only at the end:
			// the panel polls GET, so a run that is re-opened halfway through
			// shows the models that have already finished instead of an empty
			// frame that looks like a fresh start.
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
 * Register the probe route and log the battery on load.
 *
 * @param ctx - the plugin context.
 * @param config - optional overrides for {@link DEFAULTS}.
 */
function apply(ctx, config = {}) {
	const cfg = { ...DEFAULTS, ...config };
	/** One run at a time: a second POST supersedes the first. */
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
			// POST may carry an explicit model and probe selection; GET never
			// does. The body is read exactly once — see {@link readRequest}.
			const body = req.method === "POST" ? await readRequest(req) : {};
			const requested = req.method === "POST" ? selectionFrom(body) : undefined;
			if (req.method === "POST" && Array.isArray(body.probes) && probesFrom(body).length === 0) {
				// An explicit empty selection is a client bug, not a request to
				// run the whole (expensive) battery.
				sendJson(res, 400, { error: "请至少选择一项检测内容" });
				return;
			}
			const probes = req.method === "POST" ? resolveProbes(probesFrom(body)) : [...PROBES];
			let targets;
			try {
				targets = await resolveTargets(ctx, cfg, requested);
			} catch (error) {
				sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
				return;
			}
			const manifest = {
				provider: cfg.provider,
				modelPattern: cfg.modelPattern,
				reasoningEffort: cfg.reasoningEffort,
				complexTrials: cfg.complexTrials,
				timeoutMs: cfg.timeoutMs,
				probes: describeProbes(probes),
				targets: targets.map((t) => `${t.provider}/${t.model}`)
			};
			// GET is the inspection endpoint: it reports the current job's state,
			// or what WOULD run when nothing has run yet, and always returns
			// immediately. Running the battery here would make a plain curl hang
			// for many minutes and look like a broken route.
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
			// POST starts the job and returns at once. The panel polls GET, so
			// navigating away mid-run no longer throws the work away.
			const { job, done } = runs.start(manifest, (live) => runBattery(ctx, targets, probes, cfg, live));
			// Keep the promise observed even though the response has already been
			// sent, so a rejected battery cannot surface as an unhandled rejection.
			done.catch(() => {});
			sendJson(res, 202, { phase: job.phase, id: job.id, startedAt: job.startedAt, ...manifest });
		}
	}), `coding-probe: ${ROUTE_PREFIX}/run`);

	// Model catalog for the panel's picker, plus the probe menu. Kept off the
	// run route so opening the panel never triggers a battery.
	ctx.effect(() => ctx.webServer.register({
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
				// What the profile would probe with no explicit selection. If
				// route discovery finds nothing, fall back to the catalog the
				// panel can already see rather than leaving the picker empty.
				let defaults = [];
				try {
					defaults = (await resolveTargets(ctx, cfg)).map((t) => `${t.provider}/${t.model}`);
				} catch {
					defaults = [];
				}
				if (defaults.length === 0) defaults = catalog.models.map((m) => `${m.provider}/${m.model}`);
				sendJson(res, 200, {
					provider: cfg.provider,
					modelPattern: cfg.modelPattern,
					defaults,
					// The probe menu needs no battery run and no model catalog,
					// so it ships with the same payload the picker already
					// fetches: one request populates both selectors.
					probes: describeProbes(PROBES),
					defaultProbes: PROBES.map((p) => p.id),
					...catalog
				});
			} catch (error) {
				sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
			}
		}
	}), `coding-probe: ${ROUTE_PREFIX}/models`);

	ctx.logger?.info(
		"coding-probe: %d probes ready (%d control, %d target, %d complex trials), provider=%s pattern=%s",
		PROBES.length,
		PROBES.filter((p) => p.tier === "control").length,
		PROBES.filter((p) => p.tier === "target").length,
		cfg.complexTrials,
		cfg.provider.length > 0 ? cfg.provider : "(every configured provider)",
		cfg.modelPattern.length > 0 ? cfg.modelPattern : "(no filter)"
	);
}

export {
	COMPLEX_BRIEF,
	DEFAULTS,
	PROBES,
	ROUTE_PREFIX,
	apply,
	classifyFailure,
	configuredProviders,
	describeProbes,
	execute,
	extractCode,
	generate,
	inject,
	instrument,
	lastJson,
	listCandidates,
	measureRender,
	name,
	parseSelection,
	probesFrom,
	readRequest,
	readSelection,
	resolveProbes,
	resolveTargets,
	runNode,
	score,
	selectionFrom
};
