import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DecisionLogEntry } from "../src/index.js";
import { formatUsd, parseSince, priceUsage, type ReportSummary } from "../src/report.js";
import { type FakeMachine, fakeMachine, json } from "./system.js";

let machine: FakeMachine;

afterEach(async () => {
  await machine?.cleanup();
});

const base: DecisionLogEntry = {
  ts: "2026-10-19T10:00:00.000Z",
  format: "messages",
  stream: true,
  mode: "local",
  tier: "fast",
  requestedModel: "claude-opus-5-5",
  model: "anthropic/claude-haiku-5.5",
  effort: null,
  reason: "jev",
  status: 200,
  generationId: null,
  upstreamMs: 100,
};
const jev = (latencyMs: number) => ({
  model: "typesafe/jev-1.14-20261014",
  tier: "fast" as const,
  pick: "fast" as const,
  guards: [],
  probabilities: { fast: 0.9, balanced: 0.1, frontier: 0 },
  sensitive: 0,
  selfRouting: 0,
  latencyMs,
  cost: 0.0003,
});

const ENTRIES: DecisionLogEntry[] = [
  {
    ...base,
    turn: "human",
    jev: jev(500),
    usage: { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0, cost: 0.1 },
  },
  { ...base, ts: "2026-10-19T10:01:00.000Z", turn: "inherit", reason: "inherit", jev: null },
  {
    ...base,
    ts: "2026-10-19T10:02:00.000Z",
    tier: "frontier",
    model: "anthropic/claude-opus-5.5",
    turn: "human",
    jev: { error: "timeout", latencyMs: 1500 },
    reason: "fail_open",
    usage: { inputTokens: 0, outputTokens: 1_000_000, cost: 20 },
  },
  {
    ...base,
    ts: "2026-10-19T10:03:00.000Z",
    mode: "hosted",
    tier: null,
    model: "typesafe/jev-router",
    reason: "hosted",
    servedModel: "z-ai/glm-5.3-flash",
    router: { reason: "initial" },
    warnings: ["models_ignored"],
    status: 502,
    error: "upstream_unreachable",
  },
];

const CATALOG = {
  data: [
    {
      id: "anthropic/claude-opus-5.5",
      pricing: { prompt: "0.000004", completion: "0.00002", input_cache_read: "0.0000002" },
    },
  ],
};

async function writeLog(entries: DecisionLogEntry[], rotated: DecisionLogEntry[] = []) {
  const dir = join(machine.home, ".local", "state", "switchkick");
  await mkdir(dir, { recursive: true });
  const lines = (list: DecisionLogEntry[]) => list.map((e) => JSON.stringify(e)).join("\n");
  await writeFile(join(dir, "decisions.jsonl"), `${lines(entries)}\n{broken\n`);
  if (rotated.length) await writeFile(join(dir, "decisions.jsonl.1"), `${lines(rotated)}\n`);
}

describe("switchkick report", () => {
  it("summarizes tiers, models, spend against a baseline, Jev and hosted routing", async () => {
    machine = await fakeMachine({
      fetch: (url) => (url.endsWith("/models") ? json(CATALOG) : undefined),
    });
    await writeLog(ENTRIES.slice(1), ENTRIES.slice(0, 1));
    expect(await machine.run(["report", "--json"])).toBe(0);
    const s = JSON.parse(machine.stdout) as ReportSummary;
    expect(s.requests).toBe(4);
    expect(s.skipped).toBe(1);
    expect(s.files).toHaveLength(2);
    expect(s.tiers).toEqual({ fast: 2, frontier: 1, router: 1 });
    expect(s.models[0]).toMatchObject({ model: "anthropic/claude-haiku-5.5", requests: 2 });
    expect(s.spend.models).toBeCloseTo(20.1);
    expect(s.spend.jev).toBeCloseTo(0.0003);
    // 1M input + 1M output on Opus at $4/M and $20/M.
    expect(s.baseline).toEqual({ model: "anthropic/claude-opus-5.5", cost: 24 });
    expect(s.jev).toMatchObject({
      calls: 2,
      failures: { timeout: 1 },
      p50Ms: 500,
      p95Ms: 1500,
      fellBack: 1,
    });
    expect(s.hosted).toMatchObject({
      requests: 1,
      modelsIgnored: 1,
      routerReasons: { initial: 1 },
    });
    expect(s.errors).toEqual({ upstream_unreachable: 1 });
  });

  it("prints a readable summary, without prices when OpenRouter can't be reached", async () => {
    machine = await fakeMachine();
    await writeLog(ENTRIES);
    expect(await machine.run(["report"])).toBe(0);
    expect(machine.stdout).toContain(
      "4 requests, 2026-10-19T10:00:00.000Z to 2026-10-19T10:03:00.000Z",
    );
    expect(machine.stdout).toContain("anthropic/claude-haiku-5.5");
    expect(machine.stdout).toContain(
      "Jev: 2 calls, p50 500 ms, p95 1500 ms; failed: timeout 1 (50%)",
    );
    expect(machine.stdout).toContain(
      "no comparison with anthropic/claude-opus-5.5: couldn't fetch prices",
    );
  });

  it("filters with --since", async () => {
    machine = await fakeMachine();
    await writeLog(ENTRIES);
    expect(await machine.run(["report", "--json", "--since", "2026-10-19T10:02:00Z"])).toBe(0);
    expect(JSON.parse(machine.stdout).requests).toBe(2);
  });

  it("fails without a log", async () => {
    machine = await fakeMachine();
    expect(await machine.run(["report"])).toBe(1);
    expect(machine.stderr).toContain("no decision log at");
  });
});

describe("report helpers", () => {
  it("prices cached input at the cache-read price", () => {
    const pricing = { prompt: 1, completion: 10, cacheRead: 0.1 };
    expect(
      priceUsage({ inputTokens: 100, cachedTokens: 90, outputTokens: 1 }, pricing),
    ).toBeCloseTo(29);
  });

  it("shows amounts under a cent to two significant figures", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.0000208)).toBe("$0.000021");
    expect(formatUsd(0.00002)).toBe("$0.000020");
    expect(formatUsd(0.0003)).toBe("$0.00030");
    expect(formatUsd(0.004)).toBe("$0.0040");
    expect(formatUsd(0.00999)).toBe("$0.01");
    expect(formatUsd(0.0000001)).toBe("<$0.000001");
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(-0.00002)).toBe("-$0.000020");
  });

  it("parses durations and dates", () => {
    expect(parseSince("2h", 10_000_000)).toBe(10_000_000 - 7_200_000);
    expect(parseSince("2026-10-19", 0)).toBe(Date.parse("2026-10-19"));
    expect(() => parseSince("yesterday", 0)).toThrow(/--since/);
  });
});
