import { describe, expect, it } from "vitest";
import { jevState, ROUTING_QUESTIONS, readVerdict, TIERS } from "../src/index.js";

describe("ROUTING_QUESTIONS", () => {
  it("offers exactly the tiers as choices", () => {
    expect(Object.keys(ROUTING_QUESTIONS.tier.criteria)).toEqual([...TIERS]);
  });
});

describe("readVerdict", () => {
  const answers = {
    tier: { type: "choice", choice: "balanced", probabilities: { fast: 0.1, balanced: 0.7 } },
    sensitive: { type: "noul", noul: 0.2 },
    self_routing: { type: "noul", noul: 0 },
  };

  it("reads probabilities and Noul answers, treating missing tiers as 0", () => {
    expect(readVerdict(answers)).toEqual({
      probabilities: { fast: 0.1, balanced: 0.7, frontier: 0 },
      sensitive: 0.2,
      selfRouting: 0,
    });
  });

  it("falls back to the choice and its confidence without probabilities", () => {
    const tier = { type: "choice", choice: "frontier", confidence: 0.4 };
    expect(readVerdict({ ...answers, tier })?.probabilities).toEqual({
      fast: 0,
      balanced: 0,
      frontier: 0.4,
    });
  });

  it.each([
    ["no answers", null],
    ["a missing guard", { tier: answers.tier, sensitive: answers.sensitive }],
    ["an unknown choice", { ...answers, tier: { type: "choice", choice: "turbo" } }],
    ["an invalid Noul", { ...answers, sensitive: { type: "noul", noul: 2 } }],
  ])("rejects %s", (_name, value) => {
    expect(readVerdict(value)).toBeNull();
  });
});

describe("jevState", () => {
  it("sends the message and the previous reply when they fit", () => {
    expect(jevState("yes, do that", "Shall I split the module?", 100)).toEqual({
      latest_user_message: "yes, do that",
      previous_assistant_message: "Shall I split the module?",
    });
  });

  it("keeps both ends of a long message and drops the previous reply first", () => {
    const message = `START${"x".repeat(200)}END`;
    const state = jevState(message, "earlier reply", 50);
    expect(state.latest_user_message).toHaveLength(50);
    expect(state.latest_user_message.startsWith("START")).toBe(true);
    expect(state.latest_user_message.endsWith("END")).toBe(true);
    expect(state).not.toHaveProperty("previous_assistant_message");
  });

  it("keeps the end of the previous reply when only part of it fits", () => {
    const state = jevState("ok", `${"a".repeat(50)}QUESTION?`, 12);
    expect(state.previous_assistant_message).toBe("aQUESTION?");
  });

  it("leaves out a previous reply that contains a secret", () => {
    const previous = `Your .env has OPENAI_API_KEY=sk-proj-${"aB3dE5fG7h".repeat(4)}`;
    expect(jevState("ok, deploy", previous, 1000)).toEqual({ latest_user_message: "ok, deploy" });
  });

  it("never sends an empty message", () => {
    expect(jevState("  ", null, 100).latest_user_message).toBe("(no text)");
  });
});
