/**
 * Tests for the fingerprint panel's picker half.
 *
 * The client bundle is hand-written and loaded through the app's own module
 * loader, so there is no build step to type-check it and no browser in this
 * suite. These tests load the real bundle under a stub loader and walk the
 * element tree the components produce.
 *
 * The `models` regression is the reason this file exists at all: the panel
 * referenced a bare `models` that only existed inside `ModelPicker`'s scope, so
 * rendering it with nothing ticked threw a ReferenceError and took the whole
 * panel down. A tree test catches that class of defect; reading the source did
 * not.
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

/** A `React.createElement` stub: enough to build and walk a tree without React. */
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
	{ id: "zh", label: "中文" },
	{ id: "en", label: "English" },
	{ id: "ja", label: "日本語" },
	{ id: "ko", label: "한국어" },
	{ id: "fr", label: "Français" }
];

/**
 * Render the language picker and collect what it produced.
 *
 * @param selected - language ids to render as ticked.
 * @param onToggle - optional toggle spy.
 * @returns `{checkboxes, tree}`.
 */
function renderPicker(selected, onToggle = () => {}) {
	const tree = client.LanguagePicker({
		languages: MENU,
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

console.log("挑战语言选择器");

await test("the bundle registers a language picker", () => {
	assert.equal(typeof client.LanguagePicker, "function");
});

await test("every language in the menu gets a tickable box", () => {
	const { checkboxes } = renderPicker(MENU.map((l) => l.id));
	assert.equal(checkboxes.length, MENU.length);
	for (const box of checkboxes) assert.equal(box.props.type, "checkbox");
});

await test("the rendered ticks follow the caller's selection", () => {
	const { checkboxes } = renderPicker(["ja"]);
	const ticked = checkboxes.filter((b) => b.props.checked);
	assert.equal(ticked.length, 1);
	assert.equal(ticked[0].props.checked, true);
});

await test("each box toggles its own language, in menu order", () => {
	const toggled = [];
	const { checkboxes } = renderPicker([], (id) => toggled.push(id));
	for (const box of checkboxes) box.props.onChange();
	assert.deepEqual(toggled, MENU.map((l) => l.id));
});

await test("the header counts the selection against the whole menu", () => {
	const { tree } = renderPicker(["zh", "en"]);
	assert.match(texts(tree), /已选 2 \/ 5/);
});

await test("every language label is rendered", () => {
	const { tree } = renderPicker([]);
	const text = texts(tree);
	for (const language of MENU) {
		assert.ok(text.includes(language.label), `missing label: ${language.label}`);
	}
});

await test("the picker states that prompts are not paraphrased", () => {
	// Narrowing the pool removes templates; it must never reword the ones that
	// remain, because the bank was collected with this exact wording.
	const { tree } = renderPicker([]);
	assert.match(texts(tree), /不做改写/);
});

await test("an empty menu renders without inventing items", () => {
	const tree = client.LanguagePicker({
		languages: [], selected: new Set(), onToggle: () => {},
		onSelectAll: () => {}, onSelectNone: () => {}, loading: false
	});
	assert.equal(walk(tree).filter((n) => n.type === "input").length, 0);
});

await test("a menu that has not loaded yet renders as loading, not as empty", () => {
	const tree = client.LanguagePicker({
		languages: undefined, selected: new Set(), onToggle: () => {},
		onSelectAll: () => {}, onSelectNone: () => {}, loading: true
	});
	assert.match(texts(tree), /正在读取语言列表/);
});

console.log("单条挑战的呈现");

await test("an attempt row reports which language actually ran", () => {
	// The language is a user choice now, so the row has to say which one was
	// drawn — otherwise a run that ignored the selection looks identical to one
	// that honoured it.
	const tree = client.AttemptRow({
		attempt: {
			challengeId: "probe-1", language: "ja", expected: 300, minimum: 165,
			accepted: true, numbers: 300, outputTokens: 900, ms: 12000, error: null, preview: ""
		}
	});
	assert.match(texts(tree), /ja/);
});

await test("an attempt row still renders without a language field", () => {
	// Records from a run started before this change carry no language.
	const tree = client.AttemptRow({
		attempt: {
			challengeId: "probe-1", expected: 300, minimum: 165,
			accepted: false, numbers: 3, outputTokens: 20, ms: 1000, error: null, preview: "1 2 3"
		}
	});
	assert.match(texts(tree), /要求 300/);
});

console.log("");
if (failed > 0) {
	console.log(`✗ ${failed} 项失败，${passed} 项通过`);
	process.exit(1);
}
console.log(`✓ 全部 ${passed} 项断言通过`);
