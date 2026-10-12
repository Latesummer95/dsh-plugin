# dsh-plugin

Two local plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
that keep a **degeneration-prone model route usable for unattended work**.

Written against a specific failure: the `a1` route
(`https://input.codes/v1`, `deepseek-v4.1-flash`) intermittently collapses into
a short cycle repeated thousands of times inside its **reasoning** channel.

Measured from real local session logs:

| Client | Route | Worst single response |
| --- | --- | --- |
| DSH | `a1` / `deepseek-v4.1-flash` | 217,551 chars, one phrase ×6,929 |
| Codex | `input.codes` / `deepseek-v4.1-flash` | 1.58 MB, one phrase ×25,288 |
| Claude Code | `api.deepseek.com` (official) | 15 KB, ×7 (just quoting the phrase) |

The failure is not client-specific, which is why the fix lives in the harness
rather than in any one application.

## The packages

| Package | Purpose |
| --- | --- |
| [`dsh-llm-loop-guard`](packages/dsh-llm-loop-guard) | Detect the degenerate cycle mid-stream, abort that attempt with a retryable failure, and let `dsh-llm-retry` replay the step |
| [`dsh-goal-autoresume`](packages/dsh-goal-autoresume) | Re-arm an armed goal after a bounded number of loop-guard failures, so an unattended run does not silently stop |

They are designed to be used together with a larger retry budget; see
[Recommended configuration](#recommended-configuration).

## Why the loop guard is enough to protect a session

`dsh-agent-loop` appends the durable `assistant/message` — the event that enters
the conversation surface and gets replayed on every later request — **only on a
normal finish**. For an `error` finish it records an `assistant/attempt`
diagnostic and then consults `agent/request-error`.

So aborting the stream with a retryable failure means the degenerate text never
becomes part of the conversation, and the step is retried from scratch.

Verified live (headless profile, deliberately aggressive thresholds):

```
assistant/attempt : 6   (original try + 5 retries)
llm/retry         : 5   (code SERVER, retries 1..5)
leaked assistant/message with repeated text : 0
```

## Why the auto-resume plugin is needed

`dsh-goal-round-driver` disarms the goal on **every** agent error:

```js
ctx.on("agent/error", ({ agent }) => { disarm(stateFor(agent)); });
```

That is a sound default, but it means the first step that exhausts its retry
budget stops an autonomous run, with nobody watching to notice. `dsh-goal-autoresume`
re-arms the goal for loop-guard failures only, bounded per goal.

## Install

```sh
cp -r packages/dsh-llm-loop-guard  ~/.dsh/profiles/<profile>/node_modules/
cp -r packages/dsh-goal-autoresume ~/.dsh/profiles/<profile>/node_modules/
```

Then in that profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: llm-loop-guard
      name: dsh-llm-loop-guard
    - id: goal-autoresume
      name: dsh-goal-autoresume
```

Restart the profile to load them.

## Recommended configuration

Both plugins are route-agnostic, but the pair is only half the story — a larger
retry budget is what makes the guard useful for unattended runs:

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      <your-provider>:
        retryPolicy:
          mode: normal          # not "always": never retry without a bound
          maxRetries: 30        # default is 5
          retryableCodes:
            - EMPTY_RESPONSE
            - RATE_LIMIT
            - SERVER
            - TIMEOUT
            - TRANSPORT
          backoff:
            initialDelayMs: 1000
            maxDelayMs: 30000
            jitterRatio: 0.2
        models:
          - id: <your-model>
            # Declare the route's real capacity. Do NOT shrink it as a way to make
            # compaction fire: the window bound is recoverable, because
            # compaction-basic also listens on agent/request-error and turns a
            # CONTEXT_WINDOW_EXCEEDED into compactIfNeeded + retry
            # (maxOverflowRetries, default 1).
            contextWindow: 1000000
            maxTokens: 256000
# Compact while there is still room, instead of at the window. See
# "Configuring the compaction threshold" for why this re-enables the root entry.
- id: compaction-basic
  name: "@deepseek-ai/dsh-compaction-basic"
  disabled: false
  config:
    thresholdRatio: 0.2
    retainRatio: 0.08
```

Leave `reasoningEffort` where your work needs it. A lower level reduces how much
deliberation precedes the turn's final answer, and every measured failure landed
on the **final step of a turn** — but that link was never measured against a
`high`/`medium` control, so treat it as a lever to reach for if the retry logs
show frequent trips, not as a requirement.

Do not shrink `maxTokens` as a backstop either: the guard already bounds an
attempt, and a character budget would truncate genuine high-effort reasoning.
`dsh-llm-loop-guard` carries its own `maxAttemptChars` backstop (default 120000
characters of watched output) for a runaway that is *not* repetitive and
therefore invisible to the cycle detector.

## Tests

Each package is self-contained with no external dependencies:

```sh
cd packages/dsh-llm-loop-guard  && npm test   # 33 assertions
cd packages/dsh-goal-autoresume && npm test   # 11 assertions
```

`packages/dsh-llm-loop-guard/test/fixture-degenerate.txt` is a real 15 KB sample
of the captured degeneration, kept so the detector is tested against the actual
failure rather than a synthetic approximation. That distinction matters: the
first release of the guard passed synthetic tests and still never fired in
production, because the real cycle is 632 characters long and the guessed bounds
were far too small.

## Configuring the compaction threshold

The built-in auto-compaction trigger is `contextWindow * thresholdRatio`
(`0.8` by default) — about 800k tokens on a 1M route, so a long session climbs
to the window before anything happens. Setting that threshold is the one
configuration problem this repo ran into that a plugin **cannot** solve, and the
reason is worth recording.

**The live entry is unreachable from a profile patch layer.** In the `web`
profile, `@deepseek-ai/dsh-web-app` disables the root-level `compaction-basic` and
moves compaction into the agent-preset subtrees:

```
- id: preset-standard          <- top-level, but an unrecognized carrier
      - id: compaction         <- the live group is in here
            - id: compaction-basic
- id: preset-ptc
      - id: compaction
- id: preset-cordis
      - id: compaction
```

Presets arrive through `cordis:include`, and patch targets explicitly exclude
include descendants, so `applyEntryPatches`' map never descends into them. The
failure modes differ but none work:

| Patch attempt | Result |
| --- | --- |
| `insert` with `id: compaction` | `patch insert: entry "compaction" not found` |
| `id: compaction:compaction-basic` | `patch: entry "..." not found` — that map is keyed by bare id only |
| `id: compaction-basic` | resolves, but to the **disabled** root entry, so it is inert |

**A plugin cannot reach the service either.** The preset group declares
`isolate: { compaction: true }`, and `isolate` works by mapping a service name to
a realm-local Symbol (`Symbol("compaction@...")` versus `Symbol("compaction")`).
A plugin mounted outside that realm resolves `ctx.compaction` to a different
symbol, so it cannot call `compactNow` on the live engine. This was verified by
building exactly such a plugin, testing it, and then discovering the realm
boundary — it is the wrong tool here, not an untested idea.

**What works.** Re-enable the *root-level* `compaction-basic`, which is a valid
patch target, and give it the threshold:

```yaml
- id: compaction-basic
  name: "@deepseek-ai/dsh-compaction-basic"
  disabled: false
  config:
    thresholdRatio: 0.2
    retainRatio: 0.08
```

Root-scope `agent/pre-step` listeners do receive agent events — `dsh-goal-round-driver`
depends on that — so this instance runs for every preset tree. It is a *second*
compactor beside the preset's own, which stays at `0.8` and so never fires.

Verified end-to-end in a live headless run at two thresholds against the same
~12.9k-token context:

| `thresholdRatio` | Trigger | Observed |
| --- | --- | --- |
| `0.02` (20k tokens) | not reached | **no** compaction — correct |
| `0.005` (5k tokens) | exceeded | `compaction/prune` shadowed 12491 tokens, then `compaction/start` → `summary` → `end` |

The threshold is honored precisely, and the reactive path on
`CONTEXT_WINDOW_EXCEEDED` still covers a hard overflow, so declaring the route's
real `contextWindow` costs nothing.

## Known limitations

- **The guard is a safety net, not a cure.** It bounds the damage of a
  gateway-side degeneration; it does not stop the model from degenerating.
- **No way to stop reasoning replay.** The reasoning channel is ~99.5% English
  even in an all-Chinese conversation, and it is replayed into later requests,
  which is the largest single contributor to both the growing English bias of the
  output and the context size. `dsh-llm-pi-ai` exposes no switch for it, and an
  `llm/stream` listener is contractually forbidden from rewriting `options`.
- **Auto-resume is bounded on purpose.** If the budget warning appears on every
  step, the route is persistently broken rather than intermittently degenerating;
  that is a signal to change routes, not to raise the bound.
- **The compaction threshold is a ratio, not an absolute.** There is no supported
  way to say "compact at 200k tokens" independent of `contextWindow`; you express
  it as `thresholdRatio` against whatever window the route declares.
