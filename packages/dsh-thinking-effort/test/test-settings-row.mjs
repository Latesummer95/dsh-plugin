/**
 * Render tests for the settings rows' client halves.
 *
 * ## Why this file exists
 *
 * A settings row that throws while rendering does not show an error — the slot
 * framework catches the throw and renders **nothing**. The plugin's switch simply
 * disappears from Settings, and unless the browser console happens to be open, the
 * only trace anywhere is one line in a log.
 *
 * That is exactly what happened: an edit to this row replaced the local `const error`
 * with a `status`-based check but left one `String(error)` reference behind. The row
 * vanished, and it was found only by screenshotting the settings page and noticing a
 * switch that used to be there was gone.
 *
 * So this renders each component for real, with hook stubs, and fails on a throw.
 * A missing identifier, a typo, or an attribute read off a null snapshot now fails
 * here instead of silently removing UI.
 *
 * Run with `node test/test-settings-row.mjs`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
 * A React stub good enough to run a hook-using component to completion.
 *
 * `useSyncExternalStore` returns the store's own snapshot, which is what the real
 * hook does on a store that has already settled — so the component sees the same
 * shape it would in the browser, not an empty object.
 */
function makeReact() {
	const React = {
		Fragment: Symbol("Fragment"),
		createElement: (type, props, ...children) => ({ type, props, children }),
		useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
		useReducer: (_reducer, initial) => [initial, () => {}],
		useEffect: () => {},
		useMemo: (fn) => fn(),
		useCallback: (fn) => fn(),
		useRef: (value) => ({ current: value }),
		useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot()
	};
	return React;
}

/**
 * A settings transport that reports the given status and value.
 *
 * @param status - one of `loading | ready | unavailable`.
 * @param value - the resolved config section.
 */
function makeSettings(status, value) {
	return {
		getSnapshot: () => ({ status, value, base: undefined, user: undefined }),
		subscribe: () => () => {},
		set: async () => {}
	};
}

/**
 * Load a settings-row client bundle and render its component once.
 *
 * @param pkg - the package directory name.
 * @returns the element tree the component produced.
 */
function renderRow(pkg) {
	const source = readFileSync(join(PACKAGES, pkg, "client.js"), "utf8");
	const React = makeReact();
	let rendered = null;
	const registrations = [];
	const primitives = new Proxy(
		{ Switch: () => null, Button: () => null, Input: () => null, Modal: () => null },
		{ get: (target, key) => target[key] ?? (() => null) }
	);
	const require = (id) => {
		if (id === "react") return React;
		if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
		throw new Error(`${pkg}: unexpected require of ${id}`);
	};
	const window = {
		__ModuleLoader__: {
			load: (mod) => {
				rendered = mod.factory(require);
			}
		}
	};
	// eslint-disable-next-line no-new-func
	new Function("window", `${source}`)(window);
	assert.ok(rendered !== null, `${pkg}: bundle 未注册`);
	rendered.apply({
		slots: {
			inject: (_name, fn) => fn(),
			register: (options, component) => registrations.push({ options, component })
		},
		configForms: { get: () => makeSettings("ready", { enabled: true }) },
		config: { get: () => makeSettings("ready", { enabled: true }) }
	});
	assert.ok(registrations.length >= 1, `${pkg}: 应至少注册一个槽位，实际 ${registrations.length}`);

	// Render every registered component, not just the first: a package may register
	// more than one slot, and the one that throws is precisely the one worth
	// catching. The slot framework spreads the inject factory's return into props,
	// and the row needs a working `t` and a settings transport to reach rendering.
	const props = {
		t: (key) => key,
		settings: makeSettings("ready", { enabled: true })
	};
	const trees = registrations.map(({ options, component }) =>
		component({ ...props, ...(typeof options.inject === "function" ? options.inject() : {}) })
	);
	return trees.find((tree) => tree !== null && tree !== undefined) ?? null;
}

console.log("设置行渲染");

await test("dsh-thinking-effort's settings row renders without throwing", () => {
	// The regression this pins: a leftover `String(error)` after `error` was removed
	// threw `ReferenceError: error is not defined`, and the switch silently vanished.
	const tree = renderRow("dsh-thinking-effort");
	assert.ok(tree !== null && tree !== undefined, "必须渲染出内容，而不是 null");
});

await test("dsh-thinking-effort's row survives an unavailable transport", () => {
	// `status: 'unavailable'` is the branch that was previously unreachable, so it is
	// the one most likely to be wrong.
	const source = readFileSync(join(PACKAGES, "dsh-thinking-effort", "client.js"), "utf8");
	const React = makeReact();
	let registered = null;
	const require = (id) =>
		id === "react"
			? React
			: new Proxy({}, { get: () => () => null });
	const window = { __ModuleLoader__: { load: (mod) => { registered = mod.factory(require); } } };
	// eslint-disable-next-line no-new-func
	new Function("window", `${source}`)(window);
	const collected = [];
	registered.apply({
		slots: { inject: (_n, fn) => fn(), register: (_o, c) => collected.push(c) },
		configForms: {}
	});
	const trees = collected.map((component) =>
		component({ t: (key) => key, settings: makeSettings("unavailable", undefined) })
	);
	assert.ok(
		trees.some((tree) => tree !== null && tree !== undefined),
		"unavailable 传输下仍须渲染出内容"
	);
});

await test("dsh-llm-loop-guard's settings row renders without throwing", () => {
	const tree = renderRow("dsh-llm-loop-guard");
	assert.ok(tree !== null && tree !== undefined, "必须渲染出内容，而不是 null");
});

await test("no settings row reads the non-existent snapshot.error field", () => {
	// `ConfigFormSnapshot` is `{status, value, base, ...}` — there is no `error`, so
	// reading it yields `undefined` and any `!== null` guard on it is dead code.
	// Both rows had that bug; this keeps it from coming back.
	for (const pkg of ["dsh-thinking-effort", "dsh-llm-loop-guard"]) {
		const source = readFileSync(join(PACKAGES, pkg, "client.js"), "utf8");
		assert.ok(
			!/\.error\b\s*\?\?/.test(source),
			`${pkg}: 不能读 snapshot.error（该字段不存在）`
		);
	}
});

console.log("");
if (failed > 0) {
	console.log(`✗ ${failed} 项失败，${passed} 项通过`);
	process.exit(1);
}
console.log(`✓ 全部 ${passed} 项断言通过`);
