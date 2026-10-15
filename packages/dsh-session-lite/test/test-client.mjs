/**
 * Contract tests for the session-lite client bundle.
 *
 * The client half is not imported by Node — it is a bundle the browser evaluates —
 * so these tests load it the same way the browser does: by defining
 * `window.__ModuleLoader__.load` and capturing what the bundle registers. That
 * catches the class of defect that is invisible from the host side, where a busted
 * bundle simply never appears.
 *
 * Run with `node test/test-client.mjs`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let fail = 0;

async function test(label, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`  ✓ ${label}`);
	} catch (error) {
		fail += 1;
		console.log(`  ✗ ${label}`);
		console.log(`      ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Evaluate the client bundle in a fake browser and return what it registered.
 *
 * @returns the captured module, the registrations, and the injected services.
 */
function loadClient() {
	const source = readFileSync(join(HERE, "..", "client.js"), "utf8");
	const registrations = [];
	const injected = [];
	const captured = {};
	const require = (id) => {
		if (id === "react") return { createElement: () => null, useMemo: (f) => f(), useState: (v) => [v, () => {}], useEffect: () => {}, Fragment: {} };
		if (id === "@deepseek-ai/dsh-client-ui-primitives") return new Proxy({}, { get: () => () => null });
		throw new Error(`unexpected require: ${id}`);
	};
	const sandbox = {
		window: {
			__ModuleLoader__: {
				load: (mod) => {
					captured.id = mod.id;
					captured.exports = mod.factory(require);
				}
			}
		}
	};
	// eslint-disable-next-line no-new-func
	new Function("window", `${source}`)(sandbox.window);
	return { captured, registrations, injected };
}

/** Capture the slot registrations a bundle's `apply` performs. */
function mountClient() {
	const source = readFileSync(join(HERE, "..", "client.js"), "utf8");
	const registrations = [];
	const captured = {};
	const require = (id) => {
		if (id === "react") return { createElement: () => null };
		if (id === "@deepseek-ai/dsh-client-ui-primitives") return new Proxy({}, { get: () => () => null });
		throw new Error(`unexpected require: ${id}`);
	};
	const window = {
		__ModuleLoader__: {
			load: (mod) => {
				captured.exports = mod.factory(require);
			}
		}
	};
	// eslint-disable-next-line no-new-func
	new Function("window", "fetch", `${source}`)(window, () => Promise.resolve({ ok: true, json: async () => ({}) }));
	const ctx = {
		slots: {
			inject: (name, fn) => registrations.push(["inject", name]) && fn(),
			register: (options, component) => registrations.push(["register", options, component])
		},
		uiWorkspace: {
			openSession: () => {},
			archiveSession: () => {},
			unarchiveSession: () => {}
		}
	};
	captured.exports.apply(ctx);
	return { exports: captured.exports, registrations };
}

const bundle = readFileSync(join(HERE, "..", "client.js"), "utf8");

console.log("bundle 契约");

await test("the bundle registers under the plugin's own id", () => {
	const { captured } = loadClient();
	assert.equal(captured.id, "dsh-session-lite");
	assert.ok(captured.exports !== undefined, "factory 必须返回 exports");
});

await test("the bundle declares a local `module` before assigning to it", () => {
	// A bundle that assigns `module.exports` without declaring `module` throws
	// `module is not defined` in the browser, and the plugin silently never loads.
	assert.match(bundle, /var module = \{ exports: \{\} \}/, "必须自带 module 壳");
	assert.ok(bundle.indexOf("var module") < bundle.indexOf("module.exports"), "先声明后赋值");
});

await test("the bundle exports the handlers a host can introspect", () => {
	const { captured } = loadClient();
	for (const key of ["apply", "inject", "FooterAction", "Panel", "PANEL_ID"]) {
		assert.ok(key in captured.exports, `缺少导出 ${key}`);
	}
	assert.deepEqual(captured.exports.inject, ["slots", "sessions", "workspaces", "uiWorkspace"]);
});

console.log("槽位注册");

await test("registers exactly one slot, and it is the sidebar footer", () => {
	// This is the whole point of the lite rewrite: the full manager also mounted
	// into `conversation.session.header.actions`, which put its controls on top of
	// the conversation title. Nothing here may touch that slot.
	const { registrations } = mountClient();
	const registers = registrations.filter(([kind]) => kind === "register");
	assert.equal(registers.length, 1, `只应注册一个槽位，实际 ${registers.length} 个`);
	assert.equal(registers[0][1].name, "sidebar.footer.action");
	assert.equal(registers[0][1].id, "session-lite-footer");
});

await test("never registers into the conversation title bar", () => {
	// The doc comment names that slot when explaining what the rewrite dropped, so
	// this asserts on the registrations themselves rather than on the source text —
	// grepping the bundle would fail on its own explanation.
	const { registrations } = mountClient();
	const names = registrations.map((entry) =>
		entry[0] === "inject" ? entry[1] : entry[1].name
	);
	assert.deepEqual(
		[...new Set(names)],
		["sidebar.footer.action"],
		`只允许注册侧栏底部槽位，实际 ${JSON.stringify(names)}`
	);
	assert.ok(
		!names.includes("conversation.session.header.actions"),
		"不能注册顶部工作空间槽位"
	);
});

await test("the registered component is a function, not null", () => {
	// `ctx.slots.register(name, null)` crashes the rail with React error #130,
	// taking the whole sidebar down rather than just the plugin.
	const { registrations } = mountClient();
	const register = registrations.find(([kind]) => kind === "register");
	assert.equal(typeof register[2], "function");
});

await test("the inject factory supplies the three navigation callbacks", () => {
	const { registrations } = mountClient();
	const register = registrations.find(([kind]) => kind === "register");
	const provided = register[1].inject();
	assert.deepEqual(Object.keys(provided).sort(), ["onArchive", "onOpen", "onUnarchive"]);
	for (const key of Object.keys(provided)) {
		assert.equal(typeof provided[key], "function", `${key} 必须是函数`);
	}
});

await test("navigation delegates to the injected uiWorkspace service", () => {
	// Not reimplemented: these are DSH features, and calling the shipped service is
	// what keeps this plugin free of private-API dependencies.
	assert.match(bundle, /uiWorkspace\?\.openSession\?\./);
	assert.match(bundle, /uiWorkspace\?\.archiveSession\?\./);
	assert.match(bundle, /uiWorkspace\?\.unarchiveSession\?\./);
});

console.log("数据形状");

await test("reads the sessions store as a normalised map, not an array", () => {
	// The store is `{byId, ids}`. Reading it as an array is silent — the list just
	// renders empty, which looks like data loss rather than a shape mistake.
	assert.match(bundle, /snapshot\.byId/, "必须读 byId");
	assert.match(bundle, /snapshot\.ids/, "必须读 ids");
});

await test("tolerates a missing store instead of throwing", () => {
	assert.match(bundle, /Array\.isArray\(snapshot\)/, "缺少 store 时不能崩");
});

await test("only calls the host route for the one operation DSH lacks", () => {
	// Delete is the sole reason a host half exists. If a future edit routes archive
	// or open through the host too, that is a regression in scope, not a tweak.
	const fetches = bundle.match(/fetch\(([A-Z_]+)/g) ?? [];
	assert.deepEqual(fetches, ["fetch(DELETE_ROUTE"], `只有删除应走宿主，实际 ${fetches.join(", ")}`);
});

console.log("");
if (fail > 0) {
	console.log(`✗ ${fail} 项失败，${passed} 项通过`);
	process.exit(1);
}
console.log(`✓ 全部 ${passed} 项断言通过`);
