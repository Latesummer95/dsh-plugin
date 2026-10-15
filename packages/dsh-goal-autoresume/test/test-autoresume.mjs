import { apply, DEFAULTS } from "../index.js";

let pass = 0;
let fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
};

function harness({ goal, maxAutoResumes } = {}) {
  const listeners = [];
  const resumed = [];
  const logs = [];
  let current = goal;
  // The budget is keyed by the agent instance, which is stable in production;
  // hold one object here so repeated failures share a budget.
  const agent = {};
  const ctx = {
    logger: { warn: (...a) => logs.push(String(a[0])) },
    goals: {
      get: () => current,
      resume: (target, ref) => resumed.push(ref)
    },
    on: (event, fn) => { if (event === "agent/error") listeners.push(fn); }
  };
  apply(ctx, maxAutoResumes === undefined ? {} : { maxAutoResumes });
  return {
    fire: (error) => listeners.forEach((fn) => fn({ agent, error })),
    resumed,
    logs,
    setGoal: (g) => { current = g; }
  };
}

const guardError = new Error("llm-loop-guard: degenerate repetition detected (97 consecutive 632-char cycles); this attempt was discarded so the step can be retried");
const otherError = new Error("Quota exceeded for account");

console.log("== guard failure re-arms an active goal ==");
{
  const h = harness({ goal: { id: "g1", revision: 4, phase: "active" } });
  h.fire(guardError);
  check("resume called once", h.resumed.length === 1, JSON.stringify(h.resumed));
  check("ref carries id and revision", h.resumed[0]?.id === "g1" && h.resumed[0]?.revision === 4);
  check("logged the re-arm", h.logs.length === 1 && h.logs[0].includes("goal-autoresume"));
}

console.log("== unrelated failures are left alone ==");
{
  const h = harness({ goal: { id: "g1", revision: 1, phase: "active" } });
  h.fire(otherError);
  check("no resume for a non-guard error", h.resumed.length === 0);
}

console.log("== no goal means nothing to re-arm ==");
{
  const h = harness({ goal: undefined });
  h.fire(guardError);
  check("no resume without a goal", h.resumed.length === 0);
}

console.log("== the budget is bounded ==");
{
  const h = harness({ goal: { id: "g1", revision: 1, phase: "active" }, maxAutoResumes: 2 });
  h.fire(guardError);
  h.fire(guardError);
  h.fire(guardError);
  h.fire(guardError);
  check("resumed exactly maxAutoResumes times", h.resumed.length === 2, `got ${h.resumed.length}`);
  check("warned that the budget is spent", h.logs.some((l) => l.includes("already used")));
}

console.log("== a new goal gets a fresh budget ==");
{
  const h = harness({ goal: { id: "g1", revision: 1, phase: "active" }, maxAutoResumes: 1 });
  h.fire(guardError);
  h.setGoal({ id: "g2", revision: 1, phase: "active" });
  h.fire(guardError);
  check("second goal resumed too", h.resumed.length === 2, `got ${h.resumed.length}`);
  check("refs point at distinct goals", h.resumed[0].id === "g1" && h.resumed[1].id === "g2");
}

console.log("== a throwing resume is contained ==");
{
  const listeners = [];
  const logs = [];
  const ctx = {
    logger: { warn: (...a) => logs.push(String(a[0])) },
    goals: { get: () => ({ id: "g1", revision: 1, phase: "active" }), resume: () => { throw new Error("not resumable"); } },
    on: (event, fn) => { if (event === "agent/error") listeners.push(fn); }
  };
  apply(ctx, {});
  let threw = false;
  try { listeners.forEach((fn) => fn({ agent: {}, error: guardError })); } catch { threw = true; }
  check("resume failure does not propagate", threw === false);
  check("resume failure is logged", logs.some((l) => l.includes("could not re-arm")));
}

console.log("== markers are re-read on every error ==");
{
  // `readConfig()` re-reads on every event so a profile edit takes effect without
  // a restart. Deriving the markers once at mount silently ignored that reload:
  // the plugin kept matching the markers it booted with.
  const listeners = [];
  const resumed = [];
  const agent = {};
  let entryConfig = { markers: ["MARKER-A"] };
  const ctx = {
    logger: { warn: () => {} },
    loader: { entries: () => [{ fiber: { runtime: { name: "goal-autoresume" } }, options: { get config() { return entryConfig; } } }] },
    goals: { get: () => ({ id: "g1", revision: 1 }), resume: (_t, ref) => resumed.push(ref) },
    on: (event, fn) => { if (event === "agent/error") listeners.push(fn); }
  };
  apply(ctx, {});
  const fire = (msg) => listeners.forEach((fn) => fn({ agent, error: new Error(msg) }));

  fire("MARKER-A appeared");
  check("boot-time marker matched", resumed.length === 1, `got ${resumed.length}`);

  entryConfig = { markers: ["MARKER-B"] };
  fire("MARKER-B appeared");
  check("a reloaded marker takes effect without a restart", resumed.length === 2, `got ${resumed.length}`);

  fire("MARKER-A appeared");
  check("the replaced marker no longer matches", resumed.length === 2, `got ${resumed.length}`);
}

console.log("== a revision bump resets the budget ==");
{
  // A revision bump means the user edited the objective, which is a new
  // instruction to keep going. Keying the budget on the id alone left a goal that
  // had spent its budget disarmed forever, even after being redefined.
  const h = harness({ goal: { id: "g1", revision: 1 }, maxAutoResumes: 1 });
  h.fire(guardError);
  h.fire(guardError);
  check("budget exhausted for revision 1", h.resumed.length === 1, `got ${h.resumed.length}`);

  h.setGoal({ id: "g1", revision: 2 });
  h.fire(guardError);
  check("a new revision gets a fresh budget", h.resumed.length === 2, `got ${h.resumed.length}`);
  check("the resumed ref carries the new revision", h.resumed[1]?.revision === 2, JSON.stringify(h.resumed[1]));
}

console.log("")

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
