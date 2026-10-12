import { apply } from "../index.js";

let listener = null;
const logs = [];
const ctx = {
  logger: { warn: (...a) => logs.push(String(a[0])) },
  on: (event, fn) => { if (event === "llm/stream") listener = fn; }
};
apply(ctx, {});

let pass = 0;
let fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
};

const dshCycle = "Now.\n\nLet me write.\n\nOK.\n\nWriting.\n\nLet me go.\n\n";

function makeSource(chunks, state) {
  return (async function* () {
    try {
      for (const c of chunks) yield c;
    } finally {
      state.closed = true;
    }
  })();
}

console.log("== degenerate stream: must abort with a retryable error finish ==");
{
  const state = { closed: false };
  const text = dshCycle.repeat(200);
  const chunks = [{ type: "block-start", index: 0, blockType: "reasoning" }];
  for (let i = 0; i < text.length; i += 4) {
    chunks.push({ type: "reasoning-delta", index: 0, text: text.slice(i, i + 4) });
  }
  chunks.push({ type: "finish", reason: { kind: "stop" } });

  const stream = listener({}, () => makeSource(chunks, state));
  const out = [];
  for await (const c of stream) out.push(c);

  const last = out[out.length - 1];
  check("terminal chunk is a finish", last?.type === "finish");
  check("finish reason is error", last?.reason?.kind === "error", JSON.stringify(last?.reason));
  check("failure code is retryable SERVER", last?.reason?.failure?.code === "SERVER");
  check("failure carries a message", typeof last?.reason?.failure?.message === "string" && last.reason.failure.message.length > 0);
  check("upstream was closed early", state.closed === true);
  check(`stopped early: ${out.length} of ${chunks.length} chunks`, out.length < chunks.length / 2);
  check("no normal-stop finish leaked through", !out.some((c) => c.type === "finish" && c.reason?.kind === "stop"));
  check("guard logged a warning", logs.length === 1 && logs[0].includes("llm-loop-guard"));
}

console.log("== healthy stream: must pass through untouched ==");
{
  const state = { closed: false };
  const chunks = [
    { type: "block-start", index: 0, blockType: "reasoning" },
    { type: "reasoning-delta", index: 0, text: "The retry executor checks retryableCodes before replaying. " },
    { type: "reasoning-delta", index: 0, text: "A synthetic SERVER failure is therefore replayed." },
    { type: "block-end", index: 0, block: { type: "reasoning", text: "..." } },
    { type: "block-start", index: 1, blockType: "text" },
    { type: "text-delta", index: 1, text: "Here is the answer." },
    { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
    { type: "finish", reason: { kind: "stop" } }
  ];
  const stream = listener({}, () => makeSource(chunks, state));
  const out = [];
  for await (const c of stream) out.push(c);
  check("all chunks forwarded", out.length === chunks.length);
  check("finish reason preserved as stop", out[out.length - 1].reason.kind === "stop");
  check("no warning logged", logs.length === 1);
}

console.log("== consumer abort: upstream must still be closed ==");
{
  const state = { closed: false };
  const stream = listener({}, () => makeSource([
    { type: "text-delta", index: 0, text: "a" },
    { type: "text-delta", index: 0, text: "b" },
    { type: "text-delta", index: 0, text: "c" }
  ], state));
  for await (const _ of stream) break;
  check("upstream closed on early consumer exit", state.closed === true);
}

console.log("== promise-returning next(): must still work ==");
{
  const state = { closed: false };
  const stream = listener({}, async () => makeSource([
    { type: "text-delta", index: 0, text: "hello" },
    { type: "finish", reason: { kind: "stop" } }
  ], state));
  const out = [];
  for await (const c of stream) out.push(c);
  check("resolved promise source and forwarded chunks", out.length === 2);
}

console.log("== non-repetitive runaway: the length backstop must trip ==");
{
  const state = { closed: false };
  const chunks = [{ type: "block-start", index: 0, blockType: "reasoning" }];
  // Distinct text every delta, so the cycle detector can never match; only the
  // character budget can stop this.
  let n = 0;
  const seen = new Set();
  while (n < 200000) {
    const piece = `token${n.toString(36)}${String.fromCharCode(97 + (n % 26))} `;
    if (seen.has(piece)) throw new Error("test generator produced a repeat");
    seen.add(piece);
    chunks.push({ type: "reasoning-delta", index: 0, text: piece });
    n += piece.length;
  }
  chunks.push({ type: "finish", reason: { kind: "stop" } });
  const logsBefore = logs.length;
  const stream = listener({}, () => makeSource(chunks, state));
  const out = [];
  for await (const c of stream) out.push(c);
  const last = out[out.length - 1];
  check("terminal chunk is a finish", last?.type === "finish");
  check("finish reason is error", last?.reason?.kind === "error");
  check("failure names a runaway, not a cycle", last?.reason?.failure?.message.includes("runaway output detected"), last?.reason?.failure?.message);
  check("stopped before the full stream", out.length < chunks.length, `${out.length} of ${chunks.length}`);
  check("upstream closed", state.closed === true);
  check("logged a runaway warning", logs.length === logsBefore + 1 && logs[logs.length - 1].includes("runaway"));
}

console.log("== a long but bounded attempt is left alone ==");
{
  const state = { closed: false };
  const chunks = [{ type: "block-start", index: 0, blockType: "reasoning" }];
  let n = 0;
  while (n < 60000) {
    const piece = `w${n.toString(36)} `;
    chunks.push({ type: "reasoning-delta", index: 0, text: piece });
    n += piece.length;
  }
  chunks.push({ type: "finish", reason: { kind: "stop" } });
  const stream = listener({}, () => makeSource(chunks, state));
  const out = [];
  for await (const c of stream) out.push(c);
  check("60000 characters passes through (below the 120000 limit)", out.length === chunks.length);
  check("finish reason preserved", out[out.length - 1].reason.kind === "stop");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
