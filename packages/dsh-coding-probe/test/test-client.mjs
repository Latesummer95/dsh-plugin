/**
 * Tests for the coding-probe panel's picker half.
 *
 * The client bundle is hand-written and loaded through the app's own module
 * loader, so there is no build step to type-check it and no browser in this
 * suite. These tests load the real bundle under a stub loader and walk the
 * element tree the picker produces, which is enough to pin the two properties
 * that carry meaning: probes are grouped by the question they answer, and the
 * ticked state is rendered from the caller's set rather than from internal
 * state.
 *
 * Run with `node test/test-client.mjs`.
 */

import assert from "node:assert/strict";

let passed = 0;
let failed = 0;

async function test(label, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`  ✓ ${label}`);
	} catch (error) {
		failed += 1;
		console.log(`  ✗ ${label}`);
		console.log(`      ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * A `React.createElement` stub: enough to build and walk a tree without React.
 *
 * Real components stay untouched — only the element factory is replaced, so a
 * test needs no renderer and no DOM.
 */
const ReactStub = {
	createElement(type, props, ...children) {
		return { type, props: props ?? {}, children: children.flat().filter((c) => c !== null && c !== undefined && c !== false) };
	}
};

/**
 * Load the real client bundle under a stub module loader.
 *
 * @returns the bundle's exports.
 */
async function loadClient() {
	let exported = null;
	globalThis.window = {
		__ModuleLoader__: {
			load({ factory }) {
				exported = factory((id) => {
					if (id === "react") return ReactStub;
					if (id === "@deepseek-ai/dsh-client-ui-primitives") return { Button: () => null };
					throw new Error(`unexpected require: ${id}`);
				});
			}
		}
	};
	await import("../client.js");
	assert.ok(exported !== null, "the bundle must register itself through the module loader");
	return exported;
}

/** Every element in a tree, depth-first. */
function walk(node, out = []) {
	if (node === null || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		for (const child of node) walk(child, out);
		return out;
	}
	out.push(node);
	for (const child of node.children ?? []) walk(child, out);
	return out;
}

/** The text of every string in a tree, concatenated. */
function texts(node) {
	const parts = [];
	const visit = (n) => {
		if (typeof n === "string") { parts.push(n); return; }
		if (Array.isArray(n)) { for (const c of n) visit(c); return; }
		if (n === null || typeof n !== "object") return;
		for (const c of n.children ?? []) visit(c);
	};
	visit(node);
	return parts.join(" · ");
}

const client = await loadClient();

const MENU = [
	{ id: "scheduler", label: "事件循环时序", tier: "control", kind: "node", about: "microtask/macrotask 语义" },
	{ id: "simple_gl", label: "WebGL 小三角形", tier: "control", kind: "render", about: "最基础的 WebGL 管线" },
	{ id: "pelican", label: "鹈鹕骑自行车（SVG）", tier: "target", kind: "render", about: "多要素空间构图" },
	{ id: "complex_scene", label: "复杂 3D 场景", tier: "target", kind: "complex", about: "完整 brief" }
];

/**
 * Render the picker and collect what it produced.
 *
 * @param selected - probe ids to render as ticked.
 * @param onToggle - optional toggle spy.
 * @returns `{checkboxes, tree}`.
 */
function renderPicker(selected, onToggle = () => {}) {
	const tree = client.ProbePicker({
		probes: MENU,
		selected: new Set(selected),
		onToggle,
		onSelectAll: () => {},
		onSelectNone: () => {},
		loading: false
	});
	return {
		tree,
		checkboxes: walk(tree).filter((n) => n.type === "input")
	};
}

console.log("检测内容选择器");

await test("the bundle registers a probe picker", () => {
	assert.equal(typeof client.ProbePicker, "function");
});

await test("every probe in the menu gets a tickable box", () => {
	const { checkboxes } = renderPicker(MENU.map((p) => p.id));
	assert.equal(checkboxes.length, MENU.length);
	for (const box of checkboxes) {
		assert.equal(box.props.type, "checkbox");
		assert.equal(typeof box.props.onChange, "function");
	}
});

await test("the rendered ticks follow the caller's selection", () => {
	// Selection lives in the module-scoped store precisely so a panel remount
	// does not lose it; the component must therefore never own it.
	const { checkboxes } = renderPicker(["scheduler"]);
	assert.equal(checkboxes.filter((b) => b.props.checked).length, 1);
});

await test("each box toggles its own probe, in menu order", () => {
	// The whole point of the picker: unticking 鹈鹕 must not take 复杂 3D 场景
	// with it, and the id reported must be the probe's, not its index.
	const toggled = [];
	const { checkboxes } = renderPicker([], (id) => toggled.push(id));
	for (const box of checkboxes) box.props.onChange();
	assert.deepEqual(toggled, MENU.map((p) => p.id));
});

await test("ticking nothing renders nothing ticked", () => {
	const { checkboxes } = renderPicker([]);
	assert.equal(checkboxes.filter((b) => b.props.checked).length, 0);
});

await test("probes are grouped by the question they answer", () => {
	const { tree } = renderPicker([]);
	const text = texts(tree);
	assert.match(text, /对照组/);
	assert.match(text, /复杂任务/);
});

await test("each probe shows its label and what it costs to run", () => {
	const { tree } = renderPicker([]);
	const text = texts(tree);
	for (const probe of MENU) {
		assert.ok(text.includes(probe.label), `missing label: ${probe.label}`);
	}
	// The kind tag is what tells the user a probe needs a browser, a Node run,
	// or minutes of repeated generation.
	assert.ok(text.includes("执行 JS"), "node probes must be labelled");
	assert.ok(text.includes("浏览器渲染"), "render probes must be labelled");
	assert.ok(text.includes("复杂任务×"), "the repeated probe must be labelled");
});

await test("the header counts the selection against the whole menu", () => {
	const { tree } = renderPicker(["scheduler", "pelican"]);
	assert.match(texts(tree), /已选 2 \/ 4/);
});

await test("the about text is exposed, so a probe is explained before it is run", () => {
	const { tree } = renderPicker([]);
	const labels = walk(tree).filter((n) => n.type === "label");
	const titles = labels.map((l) => l.props.title).filter((t) => typeof t === "string");
	assert.equal(titles.length, MENU.length);
	assert.ok(titles.some((t) => t.includes("microtask/macrotask")));
});

await test("an empty menu renders without inventing items", () => {
	const tree = client.ProbePicker({
		probes: [], selected: new Set(), onToggle: () => {},
		onSelectAll: () => {}, onSelectNone: () => {}, loading: false
	});
	assert.equal(walk(tree).filter((n) => n.type === "input").length, 0);
});

await test("a menu that has not loaded yet renders as loading, not as empty", () => {
	const tree = client.ProbePicker({
		probes: undefined, selected: new Set(), onToggle: () => {},
		onSelectAll: () => {}, onSelectNone: () => {}, loading: true
	});
	assert.match(texts(tree), /正在读取检测项/);
});

console.log("");
if (failed > 0) {
	console.log(`✗ ${failed} 项失败，${passed} 项通过`);
	process.exit(1);
}
console.log(`✓ 全部 ${passed} 项断言通过`);
