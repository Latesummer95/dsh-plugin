/**
 * Settings switch tests for the two guard plugins.
 *
 * `enabled` is what the Settings page writes, and it has to be honoured on the
 * *next* stream/error rather than at the next boot. Both plugins therefore read
 * their config through `ctx.loader.entries()` on each event instead of closing
 * over a boot-time snapshot — these tests pin that behaviour by mutating the
 * entry config between two calls and asserting the second call sees it.
 *
 * Run with `node test/test-toggles.mjs`.
 */

import { apply as applyGuard, Config as GuardConfig } from "../index.js";
import { apply as applyResume, Config as ResumeConfig } from "../../dsh-goal-autoresume/index.js";

let pass = 0;
let fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
};

/** A loader whose one entry carries whatever config the test last wrote. */
function makeCtx(entries) {
  return {
    logger: { warn: () => {}, info: () => {} },
    loader: { entries: () => entries },
    on: () => {},
    goals: undefined,
  };
}

const dshCycle = "Now.\n\nLet me write.\n\nOK.\n\nWriting.\n\nLet me go.\n\n";

/** A degenerate reasoning stream that the guard must abort. */
function degenerateChunks() {
  const text = dshCycle.repeat(200);
  const chunks = [{ type: "block-start", index: 0, blockType: "reasoning" }];
  for (let i = 0; i < text.length; i += 4) {
    chunks.push({ type: "reasoning-delta", index: 0, text: text.slice(i, i + 4) });
  }
  chunks.push({ type: "finish", reason: { kind: "stop" } });
  return chunks;
}

/** Wrap a chunk list as the async iterable the guard expects. */
function sourceOf(chunks) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

async function drain(stream) {
  const out = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

/* ------------------------------------------------------------------ *
 * llm-loop-guard
 * ------------------------------------------------------------------ */

console.log("== loop-guard: the switch is honoured per stream ==");
{
  const entries = [
    { options: { id: "llm-loop-guard", config: {} }, fiber: { runtime: { name: "llm-loop-guard" } } },
  ];
  let listener = null;
  const ctx = { ...makeCtx(entries), on: (event, fn) => { if (event === "llm/stream") listener = fn; } };
  applyGuard(ctx, {});

  // On (the default): a degenerate stream is aborted with a retryable error.
  const aborted = await drain(listener({}, () => sourceOf(degenerateChunks())));
  const last = aborted[aborted.length - 1];
  check("enabled: a degenerate stream is still aborted",
    last?.reason?.kind === "error" && last?.reason?.failure?.code === "SERVER");

  // Off: the very same stream must pass through untouched.
  entries[0].options.config = { enabled: false };
  const passed = await drain(listener({}, () => sourceOf(degenerateChunks())));
  const passedLast = passed[passed.length - 1];
  check("disabled: the stream is no longer guarded",
    passedLast?.reason?.kind === "stop", JSON.stringify(passedLast?.reason));
  check("disabled: every chunk reaches the caller",
    passed.length === degenerateChunks().length, `${passed.length} chunks`);

  // Back on: no restart, and the guard resumes immediately.
  entries[0].options.config = { enabled: true };
  const rearmed = await drain(listener({}, () => sourceOf(degenerateChunks())));
  check("re-enabled without a restart",
    rearmed[rearmed.length - 1]?.reason?.kind === "error");

  // A `0` must read as off, not as on: the schema coerces it, but the loader can
  // also activate a plugin without validating the config at all.
  entries[0].options.config = { enabled: 0 };
  const offByZero = await drain(listener({}, () => sourceOf(degenerateChunks())));
  check("enabled: 0 counts as off",
    offByZero[offByZero.length - 1]?.reason?.kind === "stop");
}

/* ------------------------------------------------------------------ *
 * goal-autoresume
 * ------------------------------------------------------------------ */

console.log("== goal-autoresume: the switch is honoured per error ==");
{
  const entries = [
    { options: { id: "goal-autoresume", config: {} }, fiber: { runtime: { name: "goal-autoresume" } } },
  ];
  let listener = null;
  const resumed = [];
  const goals = {
    get: () => ({ id: "goal-1", revision: 7 }),
    resume: (agent, goal) => resumed.push(goal),
  };
  const ctx = {
    ...makeCtx(entries),
    goals,
    on: (event, fn) => { if (event === "agent/error") listener = fn; },
  };
  applyResume(ctx, {});

  const loopGuardError = new Error("llm-loop-guard: aborted a degenerate stream; this attempt was discarded");
  const otherError = new Error("ENOENT: no such file");

  listener({ agent: {}, error: loopGuardError });
  check("enabled: a loop-guard failure re-arms the goal", resumed.length === 1);

  entries[0].options.config = { enabled: false };
  listener({ agent: {}, error: loopGuardError });
  check("disabled: the goal is left disarmed", resumed.length === 1, `resumed ${resumed.length} times`);

  entries[0].options.config = { enabled: true };
  listener({ agent: {}, error: loopGuardError });
  check("re-enabled without a restart", resumed.length === 2);

  // An unrelated failure must stay untouched whatever the switch says.
  listener({ agent: {}, error: otherError });
  check("unrelated failures are never re-armed", resumed.length === 2);
}

/* ------------------------------------------------------------------ *
 * Schemas
 * ------------------------------------------------------------------ */

console.log("== the schemas carry the field the Settings row writes ==");
{
  const fields = (schema) => Object.keys(schema.dict ?? {});
  check("loop-guard exposes enabled", fields(GuardConfig).includes("enabled"));
  check("goal-autoresume exposes enabled", fields(ResumeConfig).includes("enabled"));

  // `volatile` is what puts a field in the Settings page at all: dsh-settings
  // only projects schema nodes marked volatile.
  check("loop-guard marks enabled volatile", GuardConfig.dict.enabled.meta?.volatile === true);
  check("goal-autoresume marks enabled volatile", ResumeConfig.dict.enabled.meta?.volatile === true);

  check("loop-guard defaults to enabled", GuardConfig.dict.enabled.meta?.default === true,
    String(GuardConfig.dict.enabled.meta?.default));
  check("goal-autoresume defaults to enabled", ResumeConfig.dict.enabled.meta?.default === true,
    String(ResumeConfig.dict.enabled.meta?.default));

  // The schema default must agree with DEFAULTS, or the Settings page and the
  // runtime would disagree about the same field.
  check("maxAttemptChars agrees with the runtime default",
    GuardConfig.dict.maxAttemptChars.meta?.default === 120000,
    String(GuardConfig.dict.maxAttemptChars.meta?.default));
  check("maxAutoResumes agrees with the runtime default",
    ResumeConfig.dict.maxAutoResumes.meta?.default === 3,
    String(ResumeConfig.dict.maxAutoResumes.meta?.default));
}

console.log("");
if (fail > 0) {
  console.log(`✗ ${fail} 项失败，${pass} 项通过`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项断言通过`);