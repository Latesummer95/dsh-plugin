import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectCycle, DEFAULTS } from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = { ...DEFAULTS };

let pass = 0;
let fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
}

// The cycle that actually escaped the first version of this guard: 632
// characters, repeated 97 times in one response. A 16-character probe anchored
// on a spurious nearer match and never saw it.
const REAL_CYCLE_CHARS = 632;
const synthetic = (cycle, repeats) => cycle.repeat(repeats);
const longCycle = Array.from({ length: REAL_CYCLE_CHARS }, (_, i) =>
  i % 61 === 60 ? "\n" : String.fromCharCode(97 + (i % 26))).join("");
const shortCycle = "Now.\n\nLet me write.\n\nOK.\n\nWriting.\n\n";

console.log("== regression: the real measured degeneration ==");
{
  const fixture = join(here, "fixture-degenerate.txt");
  if (existsSync(fixture)) {
    const text = readFileSync(fixture, "utf8");
    const hit = detectCycle(text, cfg);
    check(`real fixture (${text.length} chars) trips`, hit !== null,
      hit ? `-> cycle=${hit.cycleChars} repeats=${hit.repeats}` : "-> null");

    // Replay it the way a stream delivers it, through the capped window.
    let buf = "";
    let trippedAt = null;
    for (let i = 0; i < text.length; i += 4) {
      buf += text.slice(i, i + 4);
      if (buf.length > cfg.bufferChars) buf = buf.slice(-cfg.bufferChars);
      if (trippedAt === null && detectCycle(buf, cfg) !== null) trippedAt = buf.length;
    }
    check(`streamed fixture trips at ${trippedAt} chars (< 12000)`,
      trippedAt !== null && trippedAt < 12000);
  } else {
    check("fixture present", false, "- test/fixture-degenerate.txt missing");
  }
}

console.log("== should TRIP (unmistakable degeneration) ==");
{
  const hit = detectCycle(synthetic(longCycle, 12), cfg);
  check("632-char cycle x12", hit !== null, hit ? `-> ${hit.cycleChars}x${hit.repeats}` : "-> null");
}
{
  const hit = detectCycle(synthetic(shortCycle, 200), cfg);
  check("48-char cycle x200", hit !== null, hit ? `-> ${hit.cycleChars}x${hit.repeats}` : "-> null");
}

console.log("== should NOT TRIP (ordinary content) ==");
{
  const prose = `Looking at the failure, the retry executor consults agent/request-error and only replays
the step when the failure code is listed in retryableCodes. The default set contains EMPTY_RESPONSE,
RATE_LIMIT, SERVER, TIMEOUT and TRANSPORT, so a synthetic SERVER failure is replayed. The agent loop
appends assistant/message only on a normal finish, which is why a failed attempt never reaches the
conversation surface. We should also confirm the identifier names line up with the declaration file.`;
  check("normal prose", detectCycle(prose, cfg) === null);
}
{
  const code = `export function apply(ctx, config = {}) {
	const cfg = { ...DEFAULTS, ...config };
	ctx.on("llm/stream", (_options, next) => {
		return guardStream(next(), cfg);
	}, { global: true });
}`;
  check("source code", detectCycle(code, cfg) === null);
}
{
  let table = "| name | value | note |\n| --- | --- | --- |\n";
  for (let i = 0; i < 60; i++) table += `| item-${i} | ${i * 7} | generated row |\n`;
  check("60-row markdown table", detectCycle(table, cfg) === null);
}
check("separator repeated 9x", detectCycle("---\n".repeat(9), cfg) === null);
check("short cycle below the span floor (x20 = 960 chars)",
  detectCycle(synthetic(shortCycle, 20), cfg) === null);
check("whitespace only", detectCycle("\n".repeat(5000), cfg) === null);
check("empty", detectCycle("", cfg) === null);
check("single short delta", detectCycle("hello", cfg) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
