import { describe, expect, it } from "vitest";
import { validateDecisionsResponse } from "../src/index.js";
import live from "./fixtures/decisions-live.response.json" with { type: "json" };
import request from "./fixtures/decisions-tutorial.request.json" with { type: "json" };
import response from "./fixtures/decisions-tutorial.response.json" with { type: "json" };

const questions = Object.keys(request.questions);

describe("validateDecisionsResponse", () => {
  it("accepts the documented tutorial response", () => {
    const result = validateDecisionsResponse(response, questions);
    expect(result.ok).toBe(true);
  });

  it("accepts a live Jev 1.14 response", () => {
    expect(validateDecisionsResponse(live, questions).ok).toBe(true);
  });

  it("reports a missing answer by question name", () => {
    const { team: _team, ...answers } = response.answers;
    const result = validateDecisionsResponse({ ...response, answers }, questions);
    expect(result).toEqual({ ok: false, problems: ["answers.team"] });
  });

  it("rejects out-of-range probabilities", () => {
    const answers = { ...response.answers, is_bug: { type: "noul", noul: 1.4 } };
    const result = validateDecisionsResponse({ ...response, answers }, questions);
    expect(result).toEqual({ ok: false, problems: ["answers.is_bug"] });
  });

  it("rejects an error envelope", () => {
    const result = validateDecisionsResponse({ error: { code: 503, message: "down" } }, questions);
    expect(result.ok).toBe(false);
  });
});
