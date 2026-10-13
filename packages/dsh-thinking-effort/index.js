/**
 * dsh-thinking-effort — give every `anthropic-messages` route its thinking levels.
 *
 * ## The problem
 *
 * `dsh-llm-pi-ai` decides a model's selectable thinking levels from
 * `reasoningEfforts` in the provider config. A route that declares nothing gets
 * `reasoning: base?.reasoning ?? false`, and `base` only exists for model ids
 * present in pi-ai's *builtin catalog*. A custom route (say `cloud`, pointing at
 * a gateway) is not a catalog route, so its models resolve with no reasoning at
 * all: the GUI offers no effort picker, and `reasoningEffort` in a profile is
 * rejected with `UNSUPPORTED_REASONING_EFFORT`.
 *
 * The fix is per-model YAML, which is exactly what you do not want to repeat on
 * every new machine, and what you cannot express as a bundle patch: a profile
 * patch replaces the targeted row's whole `config`, and `models` is an array
 * that merges by replacement rather than by element. So this plugin augments
 * the config **in memory** instead, and never reads or writes the profile YAML.
 *
 * ## How it hooks in
 *
 * `llm-pi-ai`'s config is a cosmokit *volatile* ref (`providers: z.dict(...).volatile()`).
 * Volatile values are allowed to change without re-running the plugin, through a
 * dedicated path in `cordis-plugin-loader`:
 *
 *   1. `Entry._commitVolatile()` re-runs the `internal/config` waterfall over the
 *      entry's raw config;
 *   2. it deep-compares the result against the running `fiber.config`. Two
 *      volatile refs compare *equal* regardless of content (`deepEqual`'s
 *      volatile short-circuit), so a change confined to `providers` does not look
 *      like an ordinary config change and does not restart the plugin;
 *   3. it writes the changed values into the live refs and emits
 *      `loader/volatile-update`, which `dsh-llm-pi-ai` answers by rebuilding its
 *      provider directory.
 *
 * So the plugin (a) registers an `internal/config` listener that returns an
 * augmented clone for `llm-pi-ai`, and (b) asks the loader to commit it. The
 * listener is what makes it durable: every later config resolution re-applies the
 * augmentation, so an ordinary settings edit cannot silently drop it.
 *
 * ## Why `off` is omitted by default
 *
 * pi-ai's `off` handling is inverted relative to intuition. In
 * `resolveModelReasoning`, a level that is *declared* with a value is mapped to
 * that value, a level that is declared `null` stays absent from the map, and a
 * level that is *omitted* is pinned to `null`:
 *
 *   - omit `off`        → `thinkingLevelMap.off === null` → pi-ai omits the
 *                         `thinking` field entirely → correct "do not think";
 *   - declare `off: null` → `thinkingLevelMap.off === undefined` → pi-ai sends
 *                         `{type: "disabled"}`, which adaptive-only models reject
 *                         with HTTP 400.
 *
 * Omitting `off` is therefore the portable choice, and it also removes `off`
 * from the selectable levels, which matches those models' real capability.
 *
 * ## Why adaptive thinking is matched by id
 *
 * pi-ai selects between two mutually exclusive thinking shapes:
 *
 *   - `compat.forceAdaptiveThinking === true` → `{type: "adaptive"}` plus
 *     `output_config.effort`;
 *   - otherwise → `{type: "enabled", budget_tokens: ...}`.
 *
 * Neither works everywhere. In pi-ai's own catalog, 9 of the 15 Anthropic models
 * are adaptive and 6 (`claude-haiku-4-5`, `claude-opus-4-5`, `claude-sonnet-4-5`
 * and their dated variants) are budget-based; forcing the adaptive shape on those
 * is a 400. pi-ai's catalog is not importable from a profile plugin (the
 * `@earendil-works/*` specifier does not resolve there), so the plugin carries a
 * small, explicit list of the adaptive ids instead, and only ever *adds* the flag
 * to models matching it. Anything else keeps whatever `compat` it already had.
 *
 * @see dsh-llm-pi-ai/lib/index.js — `resolveModelReasoning`, `resolveModelCompat`
 * @see cordis-plugin-loader/lib/index.js — `Entry._commitVolatile`
 * @see @earendil-works/pi-ai/dist/api/anthropic-messages.js — thinking construction
 */

/** Host plugin name, as referenced by `cordis.patch.yml`. */
export const name = "thinking-effort";

/** The loader service is the only thing needed, and only to trigger a commit. */
export const inject = ["loader"];

/**
 * Model ids that pi-ai drives with `thinking.type = "adaptive"`.
 *
 * Taken verbatim from pi-ai's Anthropic catalog (`forceAdaptiveThinking: true`).
 * The budget-based models — `claude-haiku-4-5`, `claude-opus-4-5`,
 * `claude-sonnet-4-5` and their dated variants — are deliberately absent, because
 * sending them the adaptive shape is a 400.
 */
const ADAPTIVE_MODELS = [
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
];

/** Levels offered when the profile does not say otherwise. `off` is absent on purpose. */
const DEFAULT_LEVELS = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * Does this id name one of the adaptive models?
 *
 * Matches exactly, or with a trailing `-<digits>` date stamp
 * (`claude-opus-5-20260101`), so dated releases are covered without letting a
 * bare prefix match swallow a *different* model — `claude-opus-4-5` is not
 * adaptive even though it shares a prefix with `claude-opus-4-6`.
 */
export function isAdaptiveModel(id, adaptiveModels) {
  return adaptiveModels.some((base) => id === base || new RegExp(`^${escapeRegExp(base)}-\\d+$`).test(id));
}

/** Escape a string for literal use inside a regular expression. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Normalize plugin config, tolerating an absent or partial block. */
export function normalizeConfig(config) {
  const source = config && typeof config === "object" ? config : {};
  const levels =
    source.levels && typeof source.levels === "object" && Object.keys(source.levels).length > 0
      ? { ...source.levels }
      : { ...DEFAULT_LEVELS };
  return {
    levels,
    includeOff: source.includeOff === true,
    overwrite: source.overwrite === true,
    adaptiveCompat: source.adaptiveCompat !== false,
    adaptiveModels: Array.isArray(source.adaptiveModels) && source.adaptiveModels.length > 0
      ? source.adaptiveModels.map(String)
      : ADAPTIVE_MODELS,
    providers: Array.isArray(source.providers) ? source.providers.map(String) : null,
    excludeProviders: Array.isArray(source.excludeProviders) ? source.excludeProviders.map(String) : [],
  };
}

/**
 * Build the `reasoningEfforts` block for one model.
 *
 * `off: null` is written only when explicitly requested. See the module comment:
 * declaring `off` with a null value is *not* the same as omitting it, and sends
 * an explicit `{type: "disabled"}` that adaptive-only models reject.
 */
export function buildEfforts(settings) {
  const efforts = settings.includeOff ? { off: null } : {};
  for (const [level, wire] of Object.entries(settings.levels)) {
    // `null` would mean "unsupported", and an empty string fails resolution.
    if (wire === null || wire === undefined || wire === "") continue;
    efforts[level] = wire;
  }
  return efforts;
}

/**
 * Return an augmented copy of a resolved `llm-pi-ai` config, or the input
 * unchanged when there is nothing to do.
 *
 * Never mutates the argument: the loader keeps the raw config for the next
 * activation, and a profile plugin has no business editing the user's YAML.
 */
export function augmentProviders(resolved, settings, report) {
  if (!resolved || typeof resolved !== "object" || !resolved.providers) return resolved;
  if (!resolved.providers || typeof resolved.providers !== "object") return resolved;

  const efforts = buildEfforts(settings);
  if (Object.keys(efforts).length === 0) return resolved;

  let clone;
  try {
    clone = structuredClone(resolved);
  } catch {
    // A config carrying functions or `!!js` results cannot be cloned; leaving it
    // untouched is the safe outcome, and llm-pi-ai keeps working either way.
    return resolved;
  }

  for (const [routeId, route] of Object.entries(clone.providers)) {
    if (!route || typeof route !== "object") continue;
    if (route.api !== "anthropic-messages") continue;
    if (settings.providers && !settings.providers.includes(routeId)) continue;
    if (settings.excludeProviders.includes(routeId)) continue;
    if (!Array.isArray(route.models)) continue;

    for (const model of route.models) {
      if (!model || typeof model !== "object" || typeof model.id !== "string") continue;

      if (model.reasoningEfforts === false) continue; // explicitly a non-reasoning model
      if (model.reasoningEfforts !== undefined && !settings.overwrite) continue; // respect the profile

      model.reasoningEfforts = { ...efforts };
      // The listener runs on every config resolution, so the report is deduped
      // rather than appended to; otherwise it would grow without bound.
      const key = `${routeId}/${model.id}`;
      if (!report.models.includes(key)) report.models.push(key);

      if (settings.adaptiveCompat && isAdaptiveModel(model.id, settings.adaptiveModels)) {
        model.compat = { ...(model.compat ?? {}), forceAdaptiveThinking: true };
        if (!report.adaptive.includes(key)) report.adaptive.push(key);
      }
    }
  }

  return clone;
}

/**
 * @param ctx - plugin context.
 * @param config - see {@link normalizeConfig}.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config);
  const report = { models: [], adaptive: [], committed: false };

  // The listener runs inside config resolution, including the one that starts
  // llm-pi-ai. A throw here would fail that plugin's load outright, so every
  // failure path returns the untouched config instead.
  ctx.on("internal/config", function (raw, next) {
    const resolved = next();
    try {
      if (!isPiAiFiber(this)) return resolved;
      return augmentProviders(resolved, settings, report);
    } catch (error) {
      loggerOf(ctx)?.warn?.(`thinking-effort: left config untouched: ${messageOf(error)}`);
      return resolved;
    }
  });

  // Ask the loader to re-resolve and commit the augmented config. `_commitVolatile`
  // is the only seam that updates a volatile ref without restarting the plugin.
  const kick = (attempt) => {
    let entries;
    try {
      entries = [...ctx.loader.entries()];
    } catch (error) {
      loggerOf(ctx)?.warn?.(`thinking-effort: cannot read loader entries: ${messageOf(error)}`);
      return;
    }

    let found = false;
    for (const entry of entries) {
      if (!isPiAiEntry(entry)) continue;
      found = true;
      try {
        if (typeof entry._commitVolatile !== "function") continue;
        if (entry._commitVolatile() === true) report.committed = true;
      } catch (error) {
        loggerOf(ctx)?.warn?.(`thinking-effort: commit failed: ${messageOf(error)}`);
      }
    }

    // llm-pi-ai may still be loading on the first pass; retry a couple of times.
    if ((!found || !report.committed) && attempt < 2) {
      const retry = () => kick(attempt + 1);
      if (attempt === 0) queueMicrotask(retry);
      else setTimeout(retry, 500).unref?.();
      return;
    }

    if (report.models.length > 0) {
      loggerOf(ctx)?.info?.(
        `thinking-effort: ${report.models.length} model(s) now offer ${Object.keys(settings.levels).join("/")}` +
          (report.adaptive.length > 0 ? `, adaptive thinking on ${report.adaptive.length}` : "") +
          ` — ${report.models.join(", ")}`,
      );
    }
  };

  kick(0);
}

/** Is this fiber the `llm-pi-ai` entry? Checked by entry id and by runtime name. */
function isPiAiFiber(fiber) {
  return fiber?.runtime?.name === "llm-pi-ai" || fiber?.entry?.options?.id === "llm-pi-ai";
}

/** Is this loader entry the `llm-pi-ai` row? */
function isPiAiEntry(entry) {
  return entry?.options?.id === "llm-pi-ai" || entry?.fiber?.runtime?.name === "llm-pi-ai";
}

/** The context logger, when the runtime provides one. */
function loggerOf(ctx) {
  try {
    return ctx?.logger ?? null;
  } catch {
    return null;
  }
}

/** Render an unknown throwable as a short message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
