# dsh-degradation-probe

A sidebar panel for DeepSeek Harness that answers one question: **has this model
route been silently weakened?**

It runs a small battery of problems whose answers can be verified independently,
then reports a verdict per model. The panel appears in the left sidebar next to
Plugins and Schedules.

## Why the battery is tiered

A route can be degraded in two different ways, and they need different
responses. Collapsing them into one score hides the distinction that matters:

| Tier | Fails when | Verdict |
| --- | --- | --- |
| `easy` fails | the route was swapped for a smaller model | **已降智** (degraded) |
| `easy` passes, `hard` fails | a capable model is denied reasoning budget | **推理受限** (capped) |
| `medium` fails, rest pass | capability is below the healthy baseline | **偏弱** (weak) |
| everything fails | the route is unreachable, not stupid | **不可达** (unreachable) |
| all pass | no degradation detected | **正常** (healthy) |

The `unreachable` verdict exists so a gateway outage is never reported as a
stupid model — a distinction the manual investigation needed and got wrong
several times.

## The probes

Eight problems, every answer re-derived from the problem statement in
`test/test-probe.mjs` so a typo cannot silently mark a healthy route as
degraded.

| id | tier | problem | answer |
| --- | --- | --- | --- |
| `arith` | easy | 847 × 6593 | 5584271 |
| `char` | easy | count `r` in `strawrrberry` | 5 |
| `rev` | easy | reverse `abcdefghij` | jihgfedcba |
| `batball` | medium | bat-and-ball, ball cost in cents | 5 |
| `idempotent` | hard | n² ≡ n (mod 1000), 0 < n < 1000 | 3 |
| `trailing` | hard | trailing zeros of 100! in base 12 | 48 |
| `digitsum` | hard | digit sum of 2^1000 | 1366 |
| `stirling` | hard | 10 distinct balls into 3 identical non-empty boxes | 9330 |

These are the same problems used in the manual investigation that established
the degradation on this gateway, so the panel's output is directly comparable
to that record.

## Architecture

Two halves, and the split is deliberate.

**`index.js` (Node)** owns the battery and **does all scoring**. It registers
`POST /degradation-probe/run` on `ctx.webServer`, calls `ctx.llm.stream(...)`
for each probe, and returns the graded report.

**`client.js` (browser)** only renders what that route returns. Scoring never
happens in the browser, so a degraded route cannot be presented as healthy by
anything running on the client.

Calls go through DSH's own `llm` service rather than raw HTTP, which means the
probe exercises the *real configured route* — including whatever prompt
injection, reasoning caps, or throttling that route applies.

## Configuration

Every default is overridable from the profile patch:

```yaml
- id: degradation-probe
  name: dsh-degradation-probe
  config:
    provider: a1
    modelPattern: gpt-6      # substring filter over that provider's models
    reasoningEffort: high    # null omits the field entirely
    concurrency: 2           # keep low: some gateways throttle hard
    spacingMs: 1500
    timeoutMs: 120000
```

`models: ["a1/gpt-6.1-sol", "a1/gpt-6-astra"]` overrides `provider` +
`modelPattern` with an explicit list.

## Install

```bash
cp -r packages/dsh-degradation-probe ~/.dsh/profiles/web/node_modules/
```

Then add to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: degradation-probe
      name: dsh-degradation-probe
```

Restart the web profile, then open **降智检测** in the left sidebar.

## Test

```bash
node test/test-probe.mjs
```

34 checks: answer extraction, grading, every verdict branch, tier accounting,
and independent re-derivation of all eight answers.

## Notes from building this

Three things this plugin encodes that cost real time to learn:

1. **The verdict must be computed server-side.** During the manual
   investigation, several conclusions had to be retracted because the judging
   was done ad hoc. Putting scoring in one tested place prevents that.

2. **A wrong answer constant is the worst bug this tool can have.** The first
   version had `char = 4` when `strawrrberry` contains 5 `r`s — it would have
   reported a *correct* model as degraded. The answer-reproducibility tests
   exist specifically for that failure.

3. **Easy questions do not detect a capped model.** Reasoning caps leave
   trivia intact. Only the tier split reveals them, which is why the battery is
   not just "eight hard problems".
