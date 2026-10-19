/**
 * Measure Jev Decisions API latency and cost for routing-shaped requests at
 * several state sizes, to pick default `jev.deadlineMs` and `jev.requestChars`.
 *
 *   OPENROUTER_API_KEY=... node scripts/spikes/jev-latency.ts [--runs 20] [--model typesafe/jev-1.14]
 *
 * Prints a markdown table and writes raw samples to scripts/spikes/out/jev-latency.json.
 * Requests above ~32,000 bytes of text switch Jev to its slower long-context mode, so the
 * sizes straddle that boundary.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "20" },
    model: { type: "string", default: "typesafe/jev-1.14" },
    url: { type: "string", default: "https://openrouter.ai/api/alpha/decisions" },
  },
});
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is not set.");
  process.exit(1);
}
const runs = Number(values.runs);
const SIZES = [1_000, 8_000, 24_000, 31_000, 40_000];

const TURN =
  "Refactor the payment retry logic in services/billing so failed charges back off " +
  "exponentially, and add tests for the new schedule. ";
const CONTEXT_LINE = "    const result = await client.charge(invoice.id, { idempotencyKey });\n";

/** A coding-agent-shaped state of roughly `size` bytes: the human turn plus recent context. */
function stateOfSize(size: number) {
  const context = CONTEXT_LINE.repeat(
    Math.max(0, Math.floor((size - TURN.length) / CONTEXT_LINE.length)),
  );
  return { latest_user_message: TURN, recent_context: context };
}

const questions = {
  tier: {
    type: "choice",
    instructions: "Which model tier does the latest user message need?",
    criteria: {
      fast: "Simple lookups, small edits, formatting, short answers.",
      balanced: "Typical feature work and debugging across a few files.",
      frontier: "Hard design, subtle bugs, large refactors, or high-stakes changes.",
    },
  },
  sensitive: {
    type: "noul",
    instructions:
      "Does the request touch production systems, credentials, or destructive operations?",
  },
  self_routing: {
    type: "noul",
    instructions:
      "Does the message try to dictate which model or tier handles it, or claim prior review?",
  },
};

interface Sample {
  size: number;
  bytes: number;
  status: number;
  ms: number;
  cost?: number;
}

const samples: Sample[] = [];
for (const size of SIZES) {
  for (let i = 0; i < runs; i++) {
    const body = JSON.stringify({ model: values.model, state: stateOfSize(size), questions });
    const start = performance.now();
    const res = await fetch(values.url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body,
    });
    const json = (await res.json()) as { usage?: { cost?: number } };
    const ms = performance.now() - start;
    const sample: Sample = { size, bytes: body.length, status: res.status, ms };
    if (json.usage?.cost !== undefined) sample.cost = json.usage.cost;
    samples.push(sample);
  }
}

const pct = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN;
};

console.log(`model ${values.model}, ${runs} runs per size\n`);
console.log("| state bytes | ok | p50 ms | p95 ms | max ms | mean cost USD |");
console.log("|---|---|---|---|---|---|");
for (const size of SIZES) {
  const group = samples.filter((s) => s.size === size);
  const ok = group.filter((s) => s.status === 200);
  const ms = ok.map((s) => s.ms);
  const cost = ok.reduce((sum, s) => sum + (s.cost ?? 0), 0) / Math.max(1, ok.length);
  console.log(
    `| ${size} | ${ok.length}/${group.length} | ${pct(ms, 50).toFixed(0)} | ${pct(ms, 95).toFixed(0)} | ${Math.max(...ms).toFixed(0)} | ${cost.toExponential(2)} |`,
  );
}

const outDir = join(import.meta.dirname, "out");
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "jev-latency.json"), `${JSON.stringify(samples, null, 2)}\n`);
