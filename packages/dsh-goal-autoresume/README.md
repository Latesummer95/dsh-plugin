# dsh-goal-autoresume

A local DSH plugin that keeps an armed goal alive across failures caused by
`dsh-llm-loop-guard`, so a long unattended run does not silently stop.

## The gap it closes

`dsh-goal-round-driver` disarms the goal on **every** agent error:

```js
ctx.on("agent/error", ({ agent }) => {
    disarm(stateFor(agent));
});
```

That is a sound default, but it means an autonomous run halts the first time a
step exhausts its retry budget. The `a1` route degenerates intermittently, so
`llm-loop-guard` will occasionally burn all attempts on one step, fail the turn,
and leave the goal disarmed — with nobody watching to notice.

## What it does

It listens on `agent/error`, and **only** when the error text carries a
loop-guard marker does it re-arm the goal:

```js
goals.resume(agent, { id: goal.id, revision: goal.revision });
```

Everything else keeps the upstream behaviour untouched.

Listener order is load-bearing: this plugin is inserted after the bundles, so its
`agent/error` listener registers after the round driver's and therefore runs
*after* the disarm it compensates for.

## Bounded on purpose

Each goal gets `maxAutoResumes` re-arms (default **3**), tracked per agent and
keyed by goal id — a new goal starts with a fresh budget. Without a bound, a
persistently broken route would spin forever and hide the failure instead of
surfacing it.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `maxAutoResumes` | `3` | re-arms allowed per goal |
| `markers` | `["llm-loop-guard"]` | substrings identifying a guard failure |

## Verified behaviour

`test/test-autoresume.mjs` — 11/11 pass:

- a guard failure re-arms an active goal once, with the right `{id, revision}`
- an unrelated failure (e.g. quota) is left alone
- no goal present means no action
- the budget is respected and a warning is logged once it is spent
- a new goal id resets the budget
- a throwing `resume` is contained and logged rather than propagated

## Interaction with the rest of the setup

This is the third piece of the unattended story, and the three are complementary:

1. **`llm-loop-guard`** aborts a degenerate stream so the garbage never reaches
   the conversation surface and the step can be retried.
2. **`retryPolicy.maxRetries: 30`** on the `a1` provider gives the guard a large,
   cheap budget — each aborted attempt costs only the ~2-9k characters before
   the trip.
3. **This plugin** covers the case where even that budget runs out, so the goal
   keeps going instead of stopping for a human.

If `maxAutoResumes` warnings start appearing on every step, the route is
persistently broken rather than intermittently degenerating — that is the signal
to switch providers or investigate the gateway, not to raise the bound.
