import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { estimateInputTokens } from "../src/index.js";

const repeat = (text: string, times: number) => text.repeat(times);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
/** Matches Python's json.dumps spacing, which the calibration run used. */
const pyJson = Array.from(
  { length: 60 },
  (_, i) => `{"id": ${i}, "name": "item-${i}", "tags": ["a", "b"]}`,
).join(", ");

// Input tokens OpenRouter billed for each text as the only content of a user message, on
// anthropic/claude-haiku-5.5 (Sonnet 5.5 bills identically).
const BILLED: [name: string, text: string, tokens: number][] = [
  [
    "prose",
    repeat("The quick brown fox jumps over the lazy dog while the committee reviews budgets. ", 25),
    708,
  ],
  ["json", `{"items": [${pyJson}]}`, 1754],
  [
    "cjk",
    repeat("日本語のテキストを処理するためのサンプル文章です。東京は大きな都市です。", 15),
    473,
  ],
  [
    "mixed scripts",
    repeat("請用中文回答。Please answer in English too. これはテストです。한국어도 있어요. ", 12),
    379,
  ],
  [
    "accented",
    repeat("Café crème brûlée, naïve façade, São Paulo, Zürich, Ελληνικά, Русский текст. ", 15),
    608,
  ],
  ["emoji", repeat("Great job 🎉🚀 let's ship it ✅ — thanks! 🙏 ", 20), 607],
  ["emoji only", repeat("🎉🚀✅🙏🔥💡📦🧪", 40), 848],
  [
    "long words",
    repeat(
      "internationalization incomprehensibilities counterrevolutionaries pseudopseudohypoparathyroidism ",
      20,
    ),
    728,
  ],
  [
    "shell log",
    repeat(
      "$ pnpm install\nProgress: resolved 120, reused 118, downloaded 2, added 120, done\n",
      30,
    ),
    1087,
  ],
  ["hex hashes", Array.from({ length: 40 }, (_, i) => sha256(String(i))).join("\n"), 1718],
  ["one character", "x", 9],
];

describe("estimateInputTokens calibration", () => {
  // Upper bound: 1.7x, or 20 tokens of slack on tiny inputs, where the message keys dominate.
  it.each(BILLED)("never underestimates %s, and stays close", (_name, text, billed) => {
    const estimate = estimateInputTokens({ messages: [{ role: "user", content: text }] });
    expect(estimate).toBeGreaterThanOrEqual(billed);
    expect(estimate).toBeLessThanOrEqual(Math.max(billed * 1.7, billed + 20));
  });
});
