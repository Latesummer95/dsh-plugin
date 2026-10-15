/**
 * Tests for the merged dsh-probe host.
 *
 * The merge is a *client-side* arrangement: the panel renders the tabs, and the
 * halves keep their own routes, their own client bundles and their own config.
 * That split is what these tests pin, because the failure mode it guards against
 * was completely silent.
 *
 * An earlier version had the panel mount the halves on the host as well, to apply
 * per-half config slices. Every route the halves had already registered through
 * their own loader rows got registered a second time, the host rejected the
 * duplicate, and the per-half `try` swallowed the throw — so the only symptom was
 * that the config in the patch never took effect. These tests therefore assert the
 * *absence* of host-side mounting, which is the fix.
 *
 * Run with `node test/test-merge.mjs`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HALVES, apply as mount, inject, name } from "../index.js";

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

/** A context that records every service the panel touches. */
function makeCtx() {
  const calls = [];
  return {
    calls,
    logger: { warn: (...args) => calls.push(["warn", args.join(" ")]) },
    on: (...args) => calls.push(["on", ...args]),
    llm: { listProviders: () => calls.push(["llm.listProviders"]) },
    webServer: { register: (...args) => calls.push(["webServer.register", ...args]) },
  };
}

await test("the panel declares the three probes in tab order", async () => {
  assert.equal(name, "probe");
  assert.deepEqual(HALVES.map((h) => h.id), ["coding", "fingerprint", "levels"]);
  assert.deepEqual(HALVES.map((h) => h.label), ["编码能力", "模型指纹", "档位探测"]);
});

await test("the panel injects no services", async () => {
  // It owns no routes and no state; a declared injection would only gate the
  // client bundle behind a service it never uses.
  assert.deepEqual(inject, []);
});

await test("apply mounts nothing on the host", () => {
  // The regression pin. Mounting a half here re-registers its routes, the host
  // rejects the duplicate, and the throw is swallowed — leaving the halves running
  // on their built-in defaults while the patch's config silently does nothing.
  const ctx = makeCtx();
  mount(ctx);
  assert.deepEqual(ctx.calls, [], `面板不应触碰任何服务：${JSON.stringify(ctx.calls)}`);
});

await test("apply survives a context with no logger at all", () => {
  // A loader may hand `apply` a bare context; nothing here may assume otherwise.
  assert.doesNotThrow(() => mount({}));
});

await test("the panel does not import the halves", () => {
  // Importing them is how the double-mount started: it made `half.module.apply`
  // reachable from this module, and a reachable mount point is one that gets used.
  // The client bundle requires them by name instead, which is a browser-side
  // import that cannot run host code.
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import\s.*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(imports, [], `面板不应 import 任何半区：${JSON.stringify(imports)}`);
});

await test("each half keeps its own route prefix", async () => {
  // A merged panel that repointed one half's routes would break an old client
  // bundle and any run started before the merge.
  const { ROUTE_PREFIX: codingRoute } = await import("dsh-coding-probe");
  const { ROUTE_PREFIX: fingerprintRoute } = await import("dsh-fingerprint-probe");
  const { ROUTE_PREFIX: levelRoute } = await import("dsh-level-probe");
  assert.equal(codingRoute, "/coding-probe");
  assert.equal(fingerprintRoute, "/fingerprint-probe");
  assert.equal(levelRoute, "/level-probe");
  assert.equal(new Set([codingRoute, fingerprintRoute, levelRoute]).size, 3);
});

await test("the patch gives each probe its own row and its own config", () => {
  // A config on the panel row does not reach the probes, so each probe's settings
  // must live on the probe's own row. Reading the shipped patch is the only way to
  // catch a well-meaning edit that moves them back.
  const patch = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
  for (const [id, key] of [
    ["coding-probe", "complexTrials"],
    ["fingerprint-probe", "spacingMs"],
    ["level-probe", "tasksPerLevel"],
  ]) {
    const row = patch.split(/\n\s*- id: /).find((block) => block.startsWith(id));
    assert.ok(row !== undefined, `patch 里缺少 ${id} 行`);
    assert.ok(row.includes(`${key}:`), `${id} 行没有自己的 ${key} 配置`);
  }
});

await test("the panel's own row carries no config", () => {
  // Anything written there would be silently ignored, which is the trap this whole
  // file exists to prevent someone from walking back into.
  const patch = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
  const row = patch.split(/\n\s*- id: /).find((block) => block.startsWith("probe"));
  assert.ok(row !== undefined, "patch 里缺少 probe 行");
  assert.ok(!/^\s+config:/m.test(row), "面板行不应有 config（它不会生效）");
});

console.log("");
if (fail > 0) {
  console.log(`✗ ${fail} 项失败，${passed} 项通过`);
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 项断言通过`);
