import { TIERS } from "@switchkick/core";
import { DEFAULT_JEV_MODEL } from "@switchkick/jev";
import { describe, expect, it } from "vitest";

// Guards the `switchkick-source` export condition: workspace packages must resolve to their
// TypeScript sources in tests, without a prior build.
describe("workspace package resolution", () => {
  it("imports sibling packages from source", () => {
    expect(TIERS).toContain("balanced");
    expect(DEFAULT_JEV_MODEL).toBe("typesafe/jev-1.14");
  });
});
