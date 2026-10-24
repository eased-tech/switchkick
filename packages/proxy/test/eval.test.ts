import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type EvalResult, parseEvalSet, scoreAnswers } from "../src/eval.js";
import { type FakeMachine, fakeMachine, json } from "./system.js";

let machine: FakeMachine;

afterEach(async () => {
  await machine?.cleanup();
});

const SET = [
  { id: "a", tier: "fast", prompt: "rename x" },
  { id: "b", tier: "fast", prompt: "unsure: fix typo" },
  { id: "c", tier: "balanced", prompt: "add pagination" },
  { id: "d", tier: "frontier", prompt: "design a cache" },
]
  .map((c) => JSON.stringify(c))
  .join("\n");

/** Jev's probabilities per prompt, keyed by the prompt's first word. */
const PROBABILITIES: Record<string, Record<string, number>> = {
  rename: { fast: 0.95, balanced: 0.05 },
  "unsure:": { fast: 0.7, balanced: 0.3 },
  add: { fast: 0.2, balanced: 0.7, frontier: 0.1 },
  design: { balanced: 0.6, frontier: 0.4 },
};

function jev() {
  machine = undefined as unknown as FakeMachine;
  return fakeMachine({
    fetch: (url, init) => {
      if (!url.endsWith("/decisions")) return undefined;
      const body = JSON.parse(String(init?.body));
      const word = String(body.state.latest_user_message).split(" ")[0] as string;
      return json({
        model: "typesafe/jev-1.14-20261014",
        answers: {
          tier: { type: "choice", choice: "x", probabilities: PROBABILITIES[word] },
          sensitive: { type: "noul", noul: 0 },
          self_routing: { type: "noul", noul: 0 },
        },
        usage: { input_tokens: 10, output_tokens: 0, cost: 0.0003 },
      });
    },
  });
}

describe("switchkick eval", () => {
  it("asks Jev once per prompt and compares the routed tiers with the labels", async () => {
    machine = await jev();
    const set = join(machine.dir, "set.jsonl");
    const answers = join(machine.dir, "answers.jsonl");
    await writeFile(set, `# comment\n${SET}\n`);
    const env = { OPENROUTER_API_KEY: "sk-or-test" };
    expect(await machine.run(["eval", "--set", set, "--answers", answers, "--json"], env)).toBe(0);
    expect(machine.fetches).toHaveLength(4);

    const result = JSON.parse(machine.stdout) as EvalResult;
    // a: fast 0.95 ≥ 0.8 → fast. b: fast 0.7 < 0.8 → balanced (below bar, take the dearer).
    // c: balanced 0.7 ≥ 0.6 → balanced. d: balanced 0.6 ≥ 0.6 → balanced, under its label.
    expect(result.score).toMatchObject({ scored: 4, correct: 2, under: 1, over: 1 });
    expect(result.score.confusion.fast).toEqual({ fast: 1, balanced: 1, frontier: 0 });
    expect(result.cost).toBeCloseTo(0.0012);
    // Lowering the fast bar to 0.7 routes b to fast.
    expect(result.sweeps.fast.find((s) => s.bar === 0.7)?.score.correct).toBe(3);

    // The saved answers hold no prompt text, and re-running from them doesn't ask Jev.
    const saved = await readFile(answers, "utf8");
    expect(saved).not.toContain("pagination");
    machine.stdout = "";
    expect(await machine.run(["eval", "--from", answers])).toBe(0);
    expect(machine.fetches).toHaveLength(4);
    expect(machine.stdout).toContain("Accuracy 50% (2/4)");
    expect(machine.stdout).toContain("0.80   50% /  25% /  25% ← current");
  });

  it("reports a set it can't read", async () => {
    machine = await jev();
    const missing = join(machine.dir, "missing.jsonl");
    expect(await machine.run(["eval", "--set", missing], { OPENROUTER_API_KEY: "k" })).toBe(1);
    expect(machine.stderr).toContain(`can't read ${missing}`);
  });
});

describe("parseEvalSet", () => {
  it("rejects bad labels and duplicate ids, naming the line", () => {
    expect(() => parseEvalSet('{"tier":"huge","prompt":"x"}', "s")).toThrow('s:1: "tier"');
    expect(() =>
      parseEvalSet(
        '{"id":"a","tier":"fast","prompt":"x"}\n{"id":"a","tier":"fast","prompt":"y"}',
        "s",
      ),
    ).toThrow('s:2: duplicate id "a"');
  });

  it("parses the starter set in the repo", async () => {
    const text = await readFile(
      join(import.meta.dirname, "..", "..", "..", "eval", "prompts.jsonl"),
      "utf8",
    );
    const cases = parseEvalSet(text, "eval/prompts.jsonl");
    expect(cases.length).toBeGreaterThanOrEqual(24);
    for (const tier of ["fast", "balanced", "frontier"]) {
      expect(cases.filter((c) => c.tier === tier).length).toBeGreaterThanOrEqual(8);
    }
  });
});

describe("scoreAnswers", () => {
  it("skips answers Jev failed on", () => {
    const score = scoreAnswers([{ id: "x", tier: "fast", verdict: null, error: "timeout" }], {
      accept: { fast: 0.85, balanced: 0.6, frontier: 0.3 },
      sensitiveFloor: "balanced",
      claimGuard: true,
    });
    expect(score.scored).toBe(0);
  });
});
