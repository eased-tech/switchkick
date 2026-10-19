import type { DecisionAnswer, DecisionsResponse } from "./types.js";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isProbability = (v: unknown): v is number => typeof v === "number" && v >= 0 && v <= 1;

const isProbabilityMap = (v: unknown): boolean =>
  v === undefined || (isRecord(v) && Object.values(v).every(isProbability));

const isOptionalProbability = (v: unknown): boolean => v === undefined || isProbability(v);

function isAnswer(v: unknown): v is DecisionAnswer {
  if (!isRecord(v)) return false;
  switch (v.type) {
    case "noul":
      return isProbability(v.noul);
    case "choice":
      return (
        typeof v.choice === "string" &&
        isOptionalProbability(v.confidence) &&
        isProbabilityMap(v.probabilities)
      );
    case "score":
      return (
        typeof v.score === "number" &&
        isOptionalProbability(v.confidence) &&
        isProbabilityMap(v.probabilities)
      );
    default:
      return false;
  }
}

/**
 * Structural check of a Decisions API response body. Returns the names of the expected
 * questions that are missing or malformed, so callers can fail open with a precise reason.
 */
export function validateDecisionsResponse(
  body: unknown,
  expectedQuestions: readonly string[],
): { ok: true; response: DecisionsResponse } | { ok: false; problems: string[] } {
  if (!isRecord(body)) return { ok: false, problems: ["body is not an object"] };
  const problems: string[] = [];
  if (typeof body.model !== "string") problems.push("model");
  if (!isRecord(body.usage) || typeof body.usage.input_tokens !== "number") problems.push("usage");
  const answers = isRecord(body.answers) ? body.answers : undefined;
  if (answers === undefined) {
    problems.push("answers");
  } else {
    for (const name of expectedQuestions) {
      if (!isAnswer(answers[name])) problems.push(`answers.${name}`);
    }
  }
  return problems.length === 0
    ? { ok: true, response: body as unknown as DecisionsResponse }
    : { ok: false, problems };
}
