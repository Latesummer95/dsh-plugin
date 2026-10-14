/**
 * Tests for the merged dsh-probe host.
 *
 * The merge must be behaviour-neutral for the two halves: same routes, same
 * config, and a failing half that does not take the other one down. These tests
 * pin those three things, because "it still renders" is exactly the claim a merge
 * cannot make on its own.
 *
 * Run with `node test/test-merge.mjs`.
 */

import assert from "node:assert/strict";
import { HALVES, apply as mount, name } from "../index.js";

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

/** A context that records what each half was mounted with. */
function makeCtx() {
  const warnings = [];
  return {
    warnings,
    logger: { warn: (...args) => warnings.push(args.join(" ")) },
    on: () => {},
  };
}

/**
 * ESM namespace objects are frozen, so the halves cannot be monkey-patched.
 * `mount` is therefore invoked through a local copy of the HALVES shape rather
 * than through the exported, immutable one.
 */
function mountWith(ctx, config, halfImpl) {
  mount(ctx, config, halfImpl);
}

await test("the plugin mounts both halves", async () => {
  assert.equal(name, "probe");
  assert.equal(HALVES.length, 2);
  assert.deepEqual(HALVES.map((h) => h.id), ["coding", "fingerprint"]);
});

await test("apply mounts every half exactly once", () => {
  const ctx = makeCtx();
  const calls = [];
  mountWith(ctx, {}, [
    { id: "coding", module: { apply: () => calls.push("coding") } },
    { id: "fingerprint", module: { apply: () => calls.push("fingerprint") } },
  ]);
  assert.deepEqual(calls, ["coding", "fingerprint"]);
});

await test("a shared config reaches both halves", () => {
  const ctx = makeCtx();
  const seen = [];
  mountWith(ctx, { provider: "a1", complexTrials: 5 }, [
    { id: "coding", module: { apply: (_c, config) => seen.push(["coding", config]) } },
    { id: "fingerprint", module: { apply: (_c, config) => seen.push(["fingerprint", config]) } },
  ]);
  assert.equal(seen.length, 2);
  for (const [, config] of seen) {
    assert.equal(config.provider, "a1", "共享配置没有传下去");
    assert.equal(config.complexTrials, 5);
  }
});

await test("a per-half config overrides the shared one", () => {
  const ctx = makeCtx();
  const seen = [];
  mountWith(ctx, { provider: "a1", complexTrials: 5, coding: { complexTrials: 9 } }, [
    { id: "coding", module: { apply: (_c, config) => seen.push(["coding", config]) } },
    { id: "fingerprint", module: { apply: (_c, config) => seen.push(["fingerprint", config]) } },
  ]);
  const byId = Object.fromEntries(seen);
  assert.equal(byId.coding.complexTrials, 9, "半区配置没有覆盖共享值");
  assert.equal(byId.coding.provider, "a1", "未指定的字段应继承共享值");
  assert.equal(byId.fingerprint.complexTrials, 5, "另一个半区不应被影响");
});

await test("a half that throws does not take the other one down", () => {
  const ctx = makeCtx();
  const mounted = [];
  mountWith(ctx, {}, [
    { id: "coding", module: { apply: () => { throw new Error("reference bank missing"); } } },
    { id: "fingerprint", module: { apply: () => mounted.push("fingerprint") } },
  ]);
  assert.deepEqual(mounted, ["fingerprint"], "健康的半区没有挂上");
  assert.ok(
    ctx.warnings.some((line) => line.includes("reference bank missing")),
    `没有记录失败原因：${JSON.stringify(ctx.warnings)}`,
  );
});

await test("both halves keep their own route prefix", async () => {
  // A merged panel that repointed one half's routes would break an old client
  // bundle and any run started before the merge.
  const { ROUTE_PREFIX: codingRoute } = await import("dsh-coding-probe");
  const { ROUTE_PREFIX: fingerprintRoute } = await import("dsh-fingerprint-probe");
  assert.equal(codingRoute, "/coding-probe");
  assert.equal(fingerprintRoute, "/fingerprint-probe");
  assert.notEqual(codingRoute, fingerprintRoute);
});

console.log("");
if (fail > 0) {
  console.log(`✗ ${fail} 项失败，${passed} 项通过`);
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 项断言通过`);