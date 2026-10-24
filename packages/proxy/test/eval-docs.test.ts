import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig, resolvePolicy } from "../src/config.js";
import { type EvalAnswer, evaluate, formatEval, parseEvalSet } from "../src/eval.js";

// The tuning guide quotes `switchkick eval --from eval/answers-jev-1.14.jsonl --config /dev/null`
// word for word. This recomputes it from the saved answers with the default policy, so the
// guide changes whenever the defaults or the answers do. Rewrite the guide's block with
// `UPDATE_DOCS=1 pnpm test packages/proxy/test/eval-docs.test.ts`.
const root = new URL("../../../", import.meta.url);
const ANSWERS = "eval/answers-jev-1.14.jsonl";
const GUIDE = new URL("docs/site/src/content/docs/guides/tuning.md", root);
const BLOCK = /(<!-- eval:start -->\n```\n)([\s\S]*?)(```\n<!-- eval:end -->)/;

const answers = readFileSync(new URL(ANSWERS, root), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as EvalAnswer);

describe("the tuning guide", () => {
  const output = formatEval(evaluate(ANSWERS, answers, resolvePolicy(parseConfig({}, "test"))));
  const guide = readFileSync(GUIDE, "utf8");

  if (process.env.UPDATE_DOCS) writeFileSync(GUIDE, guide.replace(BLOCK, `$1${output}$3`));

  it("quotes eval's output on the saved answers with the default policy", () => {
    expect(guide).toMatch(BLOCK);
    expect(guide.match(BLOCK)?.[2]).toBe(output);
  });

  it("uses answers that match the labelled set", () => {
    const set = parseEvalSet(readFileSync(new URL("eval/prompts.jsonl", root), "utf8"), "set");
    expect(answers.map((a) => [a.id, a.tier])).toEqual(set.map((c) => [c.id, c.tier]));
    expect(answers.every((a) => a.verdict !== null)).toBe(true);
  });
});
