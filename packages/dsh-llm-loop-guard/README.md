# dsh-llm-loop-guard

A local DSH plugin that aborts **degenerate repetition** in a model stream and
lets the retry executor replay the step, so the garbage never reaches the
conversation surface.

## The problem it solves

The `a1` route (`https://input.codes/v1`, `deepseek-v4.1-flash`) intermittently
degenerates in its **reasoning** channel: the model falls into a short cycle
repeated thousands of times.

Observed in local logs:

| Client | Route | Worst single response |
| --- | --- | --- |
| DSH | `a1` / `deepseek-v4.1-flash` | 189,016 chars, `Let me write` ×3782 |
| Codex | `input.codes` / `deepseek-v4.1-flash` | 1.58 MB, `Let me write` ×25,288 |
| Claude Code | `api.deepseek.com` (official) | 15 KB, ×7 (just quoting the phrase) |

The harness has no detection for that shape — only a **zero-content** completion
is classified as retryable. So a degenerate stream runs until the user aborts,
and the garbage is then committed as an `assistant/message` and **replayed on
every later request**, which is what makes a session feel permanently poisoned.

## How the guard works

1. It wraps the `llm/stream` waterfall and folds the `reasoning-delta` (and
   optionally `text-delta`) text into a rolling window.
2. It decides the window has degenerated when the tail is a short cycle repeated
   `minRepeats` times. The cycle length is recovered from the distance to the
   previous occurrence of the tail, so the check is cheap and does not depend on
   the buffer ending on a cycle boundary.
3. On trip it stops the upstream iterator and emits a terminal
   `finish` chunk with `{kind: 'error', failure: {code: 'SERVER', ...}}`.

Why that is sufficient: `dsh-agent-loop` appends the durable `assistant/message`
(and therefore the conversation surface entry) **only** on a normal finish. For
an `error` finish it records an `assistant/attempt` diagnostic and consults
`agent/request-error`. `SERVER` is in the default retryable set, so
`dsh-llm-retry` replays the step with backoff.

## Verified behaviour

Offline detection tests (`test/test-loop-guard.mjs`): 11/11 pass — trips on both
observed degenerate cycles at ~480 chars, and does **not** trip on prose, source
code, a 60-row markdown table, short separators, or whitespace.

Stream tests (`test/test-loop-guard-stream.mjs`): 13/13 pass — aborts with a
retryable error, closes upstream, leaves healthy streams untouched.

Live end-to-end test (headless profile, a1 route, deliberately aggressive
thresholds):

```
assistant/attempt : 6   (original try + 5 retries, 6 chunks each)
llm/retry         : 5   (code SERVER, retries 1..5)
leaked assistant/message with repeated text : 0
```

Full chain confirmed: degenerate stream → guard trips → error finish → retry →
nothing committed.

## Why the first version of this guard silently did nothing

The first release used `probeChars: 16`, `maxCycleChars: 400`,
`minRepeats: 10` and `bufferChars: 4096`, and it **never fired on the real
degeneration**. Measured against the actual captured response (`seq 968`,
67,839 characters):

- the real cycle is **632 characters long** — above the `400` ceiling, so every
  candidate was rejected outright;
- a 16-character probe also anchored on a *spurious nearer* match at distance
  73 and then failed the repeat walk, so it never even reached the 632 period;
- `bufferChars: 4096` could not hold 10 repeats of a 632-character cycle
  (6,320 characters) even if the first two bugs were fixed.

The lesson: a "short loop" assumption was wrong for this route, and testing only
the nearest previous occurrence of the probe is not a sound way to recover a
period. The guard now tests every plausible distance back from the tail and
gates on **total repeated span** rather than a raw repeat count.

## Configuration

Passed through the `insert` entry in the profile patch layer. Defaults:

| Key | Default | Meaning |
| --- | --- | --- |
| `minCycleChars` | `8` | ignore cycles shorter than this |
| `maxCycleChars` | `1500` | ignore cycles longer than this (real cycle: 632) |
| `minRepeats` | `4` | absolute floor on consecutive identical cycles |
| `minRepeatedChars` | `2048` | minimum total span of verbatim repetition |
| `probeChars` | `48` | tail probe length used to find candidate cycles |
| `bufferChars` | `16384` | rolling detection window; must exceed `minRepeatedChars` |
| `watchReasoning` | `true` | watch the reasoning channel |
| `watchText` | `false` | watch the visible text channel |
| `failureCode` | `SERVER` | retryable code on the synthetic failure |

The trip condition is `repeats >= minRepeats && repeats * cycleChars >=
minRepeatedChars`, which keeps the detection point near a constant ~2 KiB span
regardless of cycle length while still requiring many repeats for short cycles.

Measured against the real captured response, the detection point is **8,888
characters** instead of the full 67,839.

## Caveat

This is a **safety net, not a cure**. It bounds the damage of a gateway-side
degeneration; it does not stop the model from degenerating. If every retry
degenerates, the step fails cleanly after `maxRetries` (5 by default) with the
guard's message, and the session stays clean.

The package lives in the profile's `node_modules` by hand. A future
`dsh plugin` / `pnpm install` in the profile directory may prune it; reinstall by
copying this directory back.
