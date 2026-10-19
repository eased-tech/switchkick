import { describe, expect, it } from "vitest";
import { maxTier, TIERS, tierRank } from "../src/index.js";

describe("tier ordering", () => {
  it("ranks tiers from cheapest to most capable", () => {
    expect(TIERS.map(tierRank)).toEqual([0, 1, 2]);
  });

  it("maxTier never returns the less capable tier", () => {
    for (const a of TIERS) {
      for (const b of TIERS) {
        const m = maxTier(a, b);
        expect(tierRank(m)).toBe(Math.max(tierRank(a), tierRank(b)));
      }
    }
  });
});
