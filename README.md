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
            # Compaction fires at contextWindow * 0.8. The nested compaction entry
            # cannot be patched from a user layer (see the loop-guard README), so
            # declare a smaller window to make automatic compaction actually fire.
            contextWindow: 300000
            maxTokens: 64000
```

Also drop `reasoningEffort` a level (e.g. `high` -> `medium`). The degeneration
grows out of long reasoning chains, and the measured failures all landed on the
**final step of a turn**, when the model is deliberating about writing its
conclusion.

## Tests

Each package is self-contained with no external dependencies:

```sh
cd packages/dsh-llm-loop-guard  && npm test   # 25 assertions
cd packages/dsh-goal-autoresume && npm test   # 11 assertions
```

`packages/dsh-llm-loop-guard/test/fixture-degenerate.txt` is a real 15 KB sample
of the captured degeneration, kept so the detector is tested against the actual
failure rather than a synthetic approximation. That distinction matters: the
first release of the guard passed synthetic tests and still never fired in
production, because the real cycle is 632 characters long and the guessed bounds
were far too small.

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
