/**
 * Tests for dsh-thinking-effort.
 *
 * Two layers:
 *
 *   1. Pure helpers — the level block, the adaptive-id matcher, config defaults,
 *      and the route/model filtering rules.
 *   2. A real integration run against the actual `cordis-plugin-loader` and the
 *      actual `dsh-llm-pi-ai`, asserting on `llm.resolveModelInfo(...).reasoning`
 *      — the same surface the GUI reads to build its effort picker.
 *
 * The integration layer is the one that matters: it exercises the volatile-commit
 * seam end to end, so a passing run means the levels really are live rather than
 * merely present in some intermediate object.
 *
 * Run with `node test/test-augment.mjs` (or `npm test`).
 */

import { createRequire } from "node:module";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  apply,
  augmentProviders,
  buildEfforts,
  isAdaptiveModel,
  name as pluginName,
  normalizeConfig,
} from "../index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ENTRY = resolve(HERE, "..", "index.js");

let passed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(detail === undefined ? label : `${label} — ${detail}`);
}

function equal(label, actual, expected) {
  check(label, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* ------------------------------------------------------------------ *
 * Locate the DSH installation so the integration layer can import the
 * real loader and the real llm-pi-ai plugin.
 * ------------------------------------------------------------------ */

function findDshRoot() {
  const candidates = [];
  if (process.env.DSH_ROOT) candidates.push(process.env.DSH_ROOT);

  // Walk up from this file and from the plugin package looking for the DSH tree.
  for (const start of [HERE, process.cwd()]) {
    let dir = start;
    for (let depth = 0; depth < 8; depth += 1) {
      candidates.push(join(dir, "node_modules", "@deepseek-ai", "dsh"));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // The usual global install location for the running node.
  const require = createRequire(import.meta.url);
  try {
    const bin = require.resolve("dsh/package.json");
    candidates.push(dirname(bin));
  } catch {
    /* not resolvable from here; keep looking */
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, "node_modules", "@deepseek-ai", "dsh-llm-pi-ai"))) {
      return candidate;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Layer 1 — pure helpers
 * ------------------------------------------------------------------ */

console.log("── 纯函数层 ─────────────────────────────────────────");

const ADAPTIVE = ["claude-opus-5", "claude-opus-5-5", "claude-opus-4-6"];

check("插件名固定为 thinking-effort", pluginName === "thinking-effort", pluginName);
equal("apply 是函数", typeof apply, "function");

// Adaptive-id matching must be exact or dated — never a bare prefix.
check("精确匹配 claude-opus-5", isAdaptiveModel("claude-opus-5", ADAPTIVE));
check("带日期戳 claude-opus-5-20260101", isAdaptiveModel("claude-opus-5-20260101", ADAPTIVE));
check("opus-5-5 不被 opus-5 前缀吞掉（仍在表中）", isAdaptiveModel("claude-opus-5-5", ADAPTIVE));
check("budget 类 claude-opus-4-5 不匹配", !isAdaptiveModel("claude-opus-4-5", ADAPTIVE),
  "opus-4-5 与 opus-4-6 同前缀，绝不能被当成 adaptive");
check("budget 类 claude-haiku-4-5 不匹配", !isAdaptiveModel("claude-haiku-4-5", ADAPTIVE));
check("未知 id 不匹配", !isAdaptiveModel("gpt-6-astra", ADAPTIVE));
check("正则元字符不会误伤", !isAdaptiveModel("claude-opus-5X", ADAPTIVE));

// The default block must NOT declare `off`.
const defaultEfforts = buildEfforts(normalizeConfig({}));
check("默认不含 off", !("off" in defaultEfforts), JSON.stringify(defaultEfforts));
equal("默认档位", defaultEfforts, { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });

const withOff = buildEfforts(normalizeConfig({ includeOff: true }));
check("includeOff 时写入 off: null", "off" in withOff && withOff.off === null, JSON.stringify(withOff));

// Levels the runtime would reject must be dropped rather than forwarded.
const filtered = buildEfforts(normalizeConfig({ levels: { off: null, low: "low", high: "", max: null } }));
equal("空串与 null 档位被剔除", filtered, { low: "low" });

// Config defaults.
const defaults = normalizeConfig(undefined);
check("默认开启 adaptiveCompat", defaults.adaptiveCompat === true);
check("默认不覆盖已有 reasoningEfforts", defaults.overwrite === false);
check("默认不限制 provider", defaults.providers === null);
equal("默认 adaptiveModels 为内置表", defaults.adaptiveModels.length, 9);
check("自定义档位生效", normalizeConfig({ levels: { high: "ultra" } }).levels.high === "ultra");

// augmentProviders — the filtering contract.
const RAW = {
  providers: {
    cloud: {
      api: "anthropic-messages",
      models: [
        { id: "claude-opus-5" },
        { id: "claude-haiku-4-5" },
        { id: "already-set", reasoningEfforts: { low: "lo" } },
        { id: "non-reasoning", reasoningEfforts: false },
      ],
    },
    a1: { api: "openai-responses", models: [{ id: "deepseek-v4.1-flash" }] },
    noModels: { api: "anthropic-messages" },
  },
};

const settings = normalizeConfig({});
const report = { models: [], adaptive: [], committed: false };
const out = augmentProviders(RAW, settings, report);
const byId = Object.fromEntries(out.providers.cloud.models.map((m) => [m.id, m]));

equal("anthropic 模型拿到档位", byId["claude-opus-5"].reasoningEfforts,
  { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
check("adaptive 模型带上 forceAdaptiveThinking",
  byId["claude-opus-5"].compat?.forceAdaptiveThinking === true);
check("budget 模型不写 forceAdaptiveThinking",
  byId["claude-haiku-4-5"].compat === undefined,
  JSON.stringify(byId["claude-haiku-4-5"].compat));
check("已有 reasoningEfforts 默认被尊重", byId["already-set"].reasoningEfforts.low === "lo");
check("reasoningEfforts:false 的非推理模型跳过", byId["non-reasoning"].reasoningEfforts === false);
check("非 anthropic 路由完全不动", out.providers.a1.models[0].reasoningEfforts === undefined);
check("没有 models 数组的路由不报错", out.providers.noModels.reasoningEfforts === undefined);

// The input must never be mutated — it is the raw config the loader retains.
check("入参未被就地修改", RAW.providers.cloud.models[0].reasoningEfforts === undefined);

// overwrite: true should replace a profile-declared block.
const overwritten = augmentProviders(RAW, normalizeConfig({ overwrite: true }), { models: [], adaptive: [] });
check("overwrite 时覆盖已有档位",
  overwritten.providers.cloud.models.find((m) => m.id === "already-set").reasoningEfforts.max === "max");

// Provider allow/deny lists.
const onlyA1 = augmentProviders(RAW, normalizeConfig({ providers: ["a1"] }), { models: [], adaptive: [] });
check("providers 白名单生效", onlyA1.providers.cloud.models[0].reasoningEfforts === undefined);
const skipCloud = augmentProviders(RAW, normalizeConfig({ excludeProviders: ["cloud"] }), { models: [], adaptive: [] });
check("excludeProviders 黑名单生效", skipCloud.providers.cloud.models[0].reasoningEfforts === undefined);

// Degenerate inputs must pass straight through.
for (const bad of [null, undefined, 42, "x", {}, { providers: null }]) {
  check(`退化输入原样返回 (${JSON.stringify(bad)})`, augmentProviders(bad, settings, { models: [], adaptive: [] }) === bad);
}

// A config that cannot be cloned (functions, `!!js` results) must be left alone.
const unclonable = { providers: { cloud: { api: "anthropic-messages", models: [], fn() {} } } };
check("不可克隆的配置原样返回", augmentProviders(unclonable, settings, { models: [], adaptive: [] }) === unclonable);

/* ------------------------------------------------------------------ *
 * Layer 2 — real loader + real llm-pi-ai
 * ------------------------------------------------------------------ */

console.log("── 集成层（真 loader + 真 llm-pi-ai）───────────────");

const DSH = findDshRoot();
if (!DSH) {
  console.log("  ⚠ 未找到 DSH 安装，跳过集成层（设置 DSH_ROOT 可指定）");
} else {
  const { Context } = await import(`${DSH}/node_modules/@deepseek-ai/cordis/lib/index.js`);
  const { LlmRuntime } = await import(`${DSH}/node_modules/@deepseek-ai/dsh-llm/lib/index.js`);
  const { Loader } = await import(`${DSH}/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js`);

  // The loader resolves an entry's `name` relative to `baseUrl`, and that
  // baseUrl has to be a *file URL* (a plain directory string silently leaves the
  // entry without a fiber). Both the shim and the plugin are therefore re-export
  // shims written next to a throwaway runner, referenced by relative name.
  const scratch = mkdtempSync(join(tmpdir(), "thinking-effort-"));
  const writeShim = (file, target) =>
    writeFileSync(join(scratch, file), `export * from ${JSON.stringify(pathToFileURL(target).href)};\n`);

  writeShim("pi-shim.mjs", `${DSH}/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`);
  writeShim("plugin.mjs", PLUGIN_ENTRY);
  writeFileSync(join(scratch, "runner.mjs"), "// loader base for the integration run\n");
  const baseUrl = pathToFileURL(join(scratch, "runner.mjs")).href;

  const PROFILE_CONFIG = {
    providers: {
      cloud: {
        displayName: "ai cloud",
        apiKeyEnv: "CLOUD_API_KEY",
        api: "anthropic-messages",
        baseURL: "https://input.codes",
        models: [
          { id: "claude-opus-5", name: "claude-opus-5", contextWindow: 1000000 },
          { id: "claude-haiku-4-5", name: "claude-haiku-4-5", contextWindow: 200000 },
        ],
      },
      a1: {
        displayName: "国模",
        apiKeyEnv: "A1_API_KEY",
        api: "openai-responses",
        baseURL: "https://input.codes/v1",
        models: [{ id: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash", contextWindow: 1000000 }],
      },
    },
  };

  const ctx = new Context();
  const llm = new LlmRuntime(ctx);
  const loader = new Loader(ctx, { baseUrl });
  ctx.provide("credentials", { resolve: async () => ({ value: "dummy" }) });
  await sleep(150);

  const levelsOf = async (provider, model) => {
    const info = await llm.resolveModelInfo(provider, model);
    return info.reasoning ? info.reasoning.efforts.map((e) => e.id) : null;
  };

  // llm-pi-ai loads FIRST, exactly as it does in a real profile.
  await loader.create({ id: "llm-pi-ai", name: "./pi-shim.mjs", config: PROFILE_CONFIG });
  await loader.await();
  await sleep(600);

  // Capture the config llm-pi-ai actually receives. Waterfall listeners run
  // outermost-first, so registering *before* the plugin puts this listener
  // outside the augmentation and it observes the final value rather than the
  // pre-augmentation one.
  let resolvedConfig = null;
  ctx.on("internal/config", function (raw, next) {
    const value = next();
    if (this?.entry?.options?.id === "llm-pi-ai" || this?.runtime?.name === "llm-pi-ai") resolvedConfig = value;
    return value;
  });

  equal("基线：cloud 无任何档位", await levelsOf("cloud", "claude-opus-5"), null);
  equal("基线：a1 无任何档位", await levelsOf("a1", "deepseek-v4.1-flash"), null);

  // Now the plugin, as its own inserted row.
  await loader.create({ id: "thinking-effort", name: "./plugin.mjs", config: {} });
  await loader.await();
  await sleep(1000);

  equal("生效：claude-opus-5 拿到五档",
    await levelsOf("cloud", "claude-opus-5"), ["low", "medium", "high", "xhigh", "max"]);
  equal("生效：claude-haiku-4-5 同样拿到五档",
    await levelsOf("cloud", "claude-haiku-4-5"), ["low", "medium", "high", "xhigh", "max"]);

  // `off` must not be selectable: omitting it is what makes pi-ai send no
  // thinking field at all, which is the only shape adaptive models accept.
  const opusLevels = await levelsOf("cloud", "claude-opus-5");
  check("off 不出现在可选档位里", !opusLevels.includes("off"), opusLevels.join(","));

  // A non-anthropic route must be untouched — that is the whole safety property.
  equal("非 anthropic 路由未被动过", await levelsOf("a1", "deepseek-v4.1-flash"), null);

  // The profile's raw config must still be pristine: the plugin works in memory.
  const entry = [...loader.entries()].find((e) => e.options?.id === "llm-pi-ai");
  const rawModel = entry?.options?.config?.providers?.cloud?.models?.[0];
  check("profile 原始配置未被写入", rawModel?.reasoningEfforts === undefined,
    JSON.stringify(rawModel?.reasoningEfforts));

  // Capture what the waterfall actually hands to llm-pi-ai, to assert on compat.
  const entryRef = [...loader.entries()].find((e) => e.options?.id === "llm-pi-ai");
  entryRef?._commitVolatile?.();
  await sleep(300);

  const resolvedCloud = resolvedConfig?.providers?.cloud?.models ?? [];
  const resolvedOpus = resolvedCloud.find((m) => m.id === "claude-opus-5");
  const resolvedHaiku = resolvedCloud.find((m) => m.id === "claude-haiku-4-5");
  check("adaptive 模型带上 forceAdaptiveThinking", resolvedOpus?.compat?.forceAdaptiveThinking === true,
    JSON.stringify(resolvedOpus?.compat));
  check("budget 模型不带 forceAdaptiveThinking", resolvedHaiku?.compat?.forceAdaptiveThinking === undefined,
    JSON.stringify(resolvedHaiku?.compat));

  // Durability: an ordinary config change must not drop the augmentation, since
  // the listener re-applies on every resolution.
  await loader.create({
    id: "llm-pi-ai",
    name: "./pi-shim.mjs",
    config: { providers: { ...PROFILE_CONFIG.providers, cloud: { ...PROFILE_CONFIG.providers.cloud, displayName: "renamed" } } },
  });
  await loader.await();
  await sleep(800);
  equal("普通配置变更后档位仍在", await levelsOf("cloud", "claude-opus-5"),
    ["low", "medium", "high", "xhigh", "max"]);
}

/* ------------------------------------------------------------------ */

console.log("");
if (failures.length > 0) {
  console.log(`✗ ${failures.length} 项失败，${passed} 项通过：`);
  for (const failure of failures) console.log(`   - ${failure}`);
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 项断言通过`);
