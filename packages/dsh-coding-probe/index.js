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
	/** Provider route to probe. */
	provider: "a1",
	/** Substring filter selecting which of that provider's models to probe. */
	modelPattern: "gpt-6",
	/** Explicit `provider/model` list; overrides provider + modelPattern when set. */
	models: [],
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
			if (canvases.length === 0) { payload.error = payload.error || 'no canvas element'; }
			else {
				const c = canvases[0];
				const w = c.width, h = c.height;
				payload.canvasW = w; payload.canvasH = h;
				const tmp = document.createElement('canvas');
				tmp.width = w; tmp.height = h;
				const g = tmp.getContext('2d');
				g.drawImage(c, 0, 0);
				const data = g.getImageData(0, 0, w, h).data;
				let green = 0, blue = 0, nonblack = 0, total = 0;
				const seen = new Set();
				for (let i = 0; i < w * h; i++) {
					const r = data[i*4], gg = data[i*4+1], b = data[i*4+2];
					total++;
					if (gg > 128 && r < 128 && b < 128) green++;
					if (b > 128 && r < 128 && gg < 128) blue++;
					if (r > 12 || gg > 12 || b > 12) nonblack++;
					seen.add((r >> 4) + ',' + (gg >> 4) + ',' + (b >> 4));
				}
				payload.greenRatio = total ? green / total : 0;
				payload.blueRatio = total ? blue / total : 0;
				payload.nonblackRatio = total ? nonblack / total : 0;
				payload.distinctColors = seen.size;
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
setTimeout(() => {
	try {
		${body}
	} catch (e) { payload = { error: String(e) }; }
	if (payload === null) payload = { error: window.__probeError };
	document.title = 'PROBE_RESULT:' + JSON.stringify(payload);
}, ${Math.max(0, Number(delayMs) || 0)});
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
		return {
			id: probe.id,
			label: probe.label,
			tier: probe.tier,
			kind: probe.kind,
			about: probe.about,
			ok: false,
			detail: "生成失败",
			error: generated.error ?? "空回复",
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
			trials.push({ attempt: i, generated: false, error: generated.error ?? "空回复", ms: generated.ms });
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
		detail: `${attempts} 次尝试：生成成功 ${generatedCount} 次，其中渲染成功 ${renderedCount} 次，超时/失败 ${timedOut} 次`,
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

	let verdict;
	if (allErrored) verdict = "unreachable";
	else if (control.length > 0 && countOk(control) < control.length) verdict = "degraded";
	else if (targetAttempts > 0 && targetRendered === 0) verdict = targetGenerated > 0 ? "broken-code" : "timeout-bound";
	else if (targetAttempts > 0 && targetRendered < targetAttempts) verdict = "unstable";
	else verdict = "healthy";

	return {
		total: results.length,
		passed: countOk(results),
		control: { total: control.length, passed: countOk(control) },
		target: { total: targetAttempts, passed: targetRendered, generated: targetGenerated },
		verdict
	};
}

/**
 * Run the battery over a list of targets, bounded and paced.
 *
 * @param ctx - the plugin context.
 * @param targets - the routes to probe.
 * @param config - the resolved plugin config.
 * @returns a promise of model reports.
 */
async function runBattery(ctx, targets, config) {
	const reports = [];
	const queue = [...targets];
	const worker = async () => {
		for (;;) {
			const target = queue.shift();
			if (target === undefined) return;
			const results = [];
			for (const probe of PROBES) {
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
			const manifest = {
				provider: cfg.provider,
				modelPattern: cfg.modelPattern,
				reasoningEffort: cfg.reasoningEffort,
				complexTrials: cfg.complexTrials,
				timeoutMs: cfg.timeoutMs,
				probes: PROBES.map((p) => ({ id: p.id, label: p.label, tier: p.tier, kind: p.kind, about: p.about })),
				targets: targets.map((t) => `${t.provider}/${t.model}`)
			};
			// GET is the inspection endpoint: it reports what WOULD run and
			// returns immediately. Running the battery here would make a plain
			// curl hang for many minutes and look like a broken route.
			if (req.method === "GET") {
				sendJson(res, 200, manifest);
				return;
			}
			const report = { startedAt: new Date().toISOString(), ...manifest, models: [] };
			try {
				report.models = await runBattery(ctx, targets, cfg);
			} catch (error) {
				sendJson(res, 500, { error: error instanceof Error ? error.message : String(error), ...report });
				return;
			}
			report.finishedAt = new Date().toISOString();
			sendJson(res, 200, report);
		}
	}), `coding-probe: ${ROUTE_PREFIX}/run`);

	ctx.logger?.info(
		"coding-probe: %d probes ready (%d control, %d target, %d complex trials), provider=%s pattern=%s",
		PROBES.length,
		PROBES.filter((p) => p.tier === "control").length,
		PROBES.filter((p) => p.tier === "target").length,
		cfg.complexTrials,
		cfg.provider,
		cfg.modelPattern
	);
}

export {
	COMPLEX_BRIEF,
	DEFAULTS,
	PROBES,
	ROUTE_PREFIX,
	apply,
	execute,
	extractCode,
	generate,
	inject,
	instrument,
	lastJson,
	measureRender,
	name,
	runNode,
	score
};
