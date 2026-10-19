import type { Handler } from "hono";
import { errorBody } from "./formats.js";

/**
 * Tokens per character, by character class. Fitted to input tokens OpenRouter billed for Claude
 * 5.5 models (whose tokenizer is less compact than older Claude models') on prose, code, JSON,
 * Markdown, logs, CJK, accented text, emoji, hashes and base64.
 */
const WEIGHTS = {
  letter: 0.4,
  digit: 0.55,
  punctuation: 0.9,
  space: 0.47,
  /** Each space after the first in a run, as in indentation; tokenizers merge these. */
  extraSpace: 0.15,
  newline: 0.3,
  /** Hashes, ids and base64 tokenize at close to one token per character. */
  randomRun: 1,
  /** Latin with diacritics, Greek, Cyrillic: two UTF-8 bytes. */
  twoByte: 0.8,
  /** CJK, kana and Hangul. */
  cjk: 1.05,
  /** Other three-byte characters: symbols such as ✅ and —. */
  otherBmp: 2,
  /** Four-byte characters, mostly emoji. */
  astral: 3.2,
} as const;
/**
 * Applied to the total. With it, every calibration sample came out 1.02–1.65 times its billed
 * count, typically 1.1–1.4. Overestimating is the safe direction: an underestimate lets a
 * client overflow its context window, while an overestimate only makes it compact early.
 */
const SAFETY_MARGIN = 1.1;
/** A one-character message is billed about this many tokens. */
const REQUEST_OVERHEAD_TOKENS = 10;
/** Anthropic resizes large images, so one image costs at most about this many tokens. */
const IMAGE_TOKENS = 1600;
/** Anthropic's hidden tool-use system prompt, rounded up. */
const TOOLS_OVERHEAD_TOKENS = 400;
/** A run of letters and digits with at least two of each, e.g. a hash or base64. */
const RANDOM_RUN = /[A-Za-z0-9+=]{8,}/g;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/** Estimated tokens for one string, before the safety margin. */
export function estimateTextTokens(text: string): number {
  let total = 0;
  const rest = text.replace(RANDOM_RUN, (run) => {
    const digits = run.replace(/[^0-9]/g, "").length;
    if (digits < 2 || run.length - digits < 2) return run;
    total += WEIGHTS.randomRun * run.length;
    return "";
  });
  let previous = "";
  for (const char of rest) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0xffff) total += WEIGHTS.astral;
    else if (code > 0x7ff) total += isCjk(code) ? WEIGHTS.cjk : WEIGHTS.otherBmp;
    else if (code > 0x7f) total += WEIGHTS.twoByte;
    else if (/[A-Za-z]/.test(char)) total += WEIGHTS.letter;
    else if (/[0-9]/.test(char)) total += WEIGHTS.digit;
    else if (char === "\n") total += WEIGHTS.newline;
    else if (char === " " || char === "\t") {
      total += previous === " " || previous === "\t" ? WEIGHTS.extraSpace : WEIGHTS.space;
    } else if (code > 0x20) total += WEIGHTS.punctuation;
    previous = char;
  }
  return total;
}

/**
 * Estimates the input tokens of an Anthropic Messages request: its system prompt, messages and
 * tools. OpenRouter has no token-counting endpoint, so this never calls upstream.
 */
export function estimateInputTokens(body: Record<string, unknown>): number {
  let text = 0;
  let images = 0;

  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      text += estimateTextTokens(value);
    } else if (typeof value === "number" || typeof value === "boolean") {
      text += estimateTextTokens(String(value));
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (isObject(value)) {
      if (value.type === "image") {
        // Base64 or URL, the cost depends on pixels, not on how the image is sent.
        images += 1;
        return;
      }
      if (value.type === "document" && isObject(value.source) && value.source.type === "base64") {
        // A third of the decoded size, which overestimates PDFs: they are mostly non-text bytes.
        const data = typeof value.source.data === "string" ? value.source.data : "";
        text += Math.floor((data.length * 3) / 4) / 3;
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        text += estimateTextTokens(key);
        visit(item);
      }
    }
  };

  visit(body.system);
  visit(body.messages);
  visit(body.tools);
  const tools = Array.isArray(body.tools) && body.tools.length > 0 ? TOOLS_OVERHEAD_TOKENS : 0;
  return Math.ceil(
    (text + REQUEST_OVERHEAD_TOKENS) * SAFETY_MARGIN + images * IMAGE_TOKENS + tools,
  );
}

/**
 * `POST /v1/messages/count_tokens`, answered locally. Claude Code and other Anthropic clients
 * call it to track their context window. The response header marks the count as an estimate.
 */
export const countTokens: Handler = async (c) => {
  let body: unknown;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    return c.json(
      errorBody("messages", "invalid_request", "The request body is not valid JSON."),
      400,
    );
  }
  if (!isObject(body)) {
    return c.json(
      errorBody("messages", "invalid_request", "The request body must be a JSON object."),
      400,
    );
  }
  c.header("x-switchkick-token-estimate", "true");
  return c.json({ input_tokens: estimateInputTokens(body) });
};
