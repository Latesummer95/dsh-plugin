# NOTICE

## Third-party material

The detection algorithm, the reference model bank, and the challenge prompts in
this package are ported from **[Ikaleio/lm-detector](https://github.com/Ikaleio/lm-detector)**
(homepage: <https://lm.ikale.io>), which is licensed under the MIT License:

```
MIT License

Copyright (c) 2026 xqy2006

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## What is derived, and from where

Pinned to commit **`b1a71db35f26c2f8e66dbc63a5aac48893d52462`**:

| Upstream path | Used as | How |
| --- | --- | --- |
| `shared/fingerprint-core.js` | `lib/fingerprint-core.js` | Ported; maths unchanged |
| `shared/positional.ts` | `lib/positional.js` | Ported; maths unchanged |
| `shared/shared-detector.ts` | `lib/detector.js` | Ported; maths unchanged |
| `shared/detector-codec.ts` | `lib/detector.js` (`decodeDetector`) | Ported |
| `shared/challenge-browser.js` | `lib/challenge.js` | Ported; prompt templates verbatim |
| `data/unified_bank.json` | `data/bank-meta.json` | Trimmed to model metadata (8.8 KB of 11.7 MB) |
| `data/shared_detector.bin` | *(not vendored)* | Downloaded at first use, SHA-256 verified |

The detector binary is **not** redistributed here. It is fetched from the pinned
commit on first use and verified against
`sha256:2bd3f10427337abc573ff4ce52e9354dd5e8c19b09a9671b24b5c84adef14e8e`, which is
the digest published at that commit.

## Why the maths is kept bit-compatible

The reference bank was fitted offline in Python and shipped frozen. The feature
construction, block order, weights and RBF centres must therefore match the
export exactly: a divergence does not raise an error, it silently re-ranks every
model. `test/test-detector.mjs` guards this by re-scoring real reference answers
and asserting each model's own answers rank it first — a check that fails loudly
for any porting error, where the unit tests above it would still pass.

## Upstream status of the method

Fingerprint detection as implemented upstream is a **closed-set ranking** over
the reference bank. It is evidence about resemblance, not proof of identity, and
this package's UI states that limitation alongside the result rather than
burying it. See the upstream documentation for the full method:
<https://github.com/Ikaleio/lm-detector/tree/main/docs>.
