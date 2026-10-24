import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyGuards,
  DEFAULT_ACCEPT,
  DEFAULT_POLICY,
  type JevVerdict,
  pickTier,
  planRoute,
  type SessionState,
  TIERS,
  type Tier,
  tierFromVerdict,
  tierRank,
} from "../src/index.js";

const tier = fc.constantFrom(...TIERS);
const probability = fc.double({ min: 0, max: 1, noNaN: true });
const probabilities = fc.record({
  fast: probability,
  balanced: probability,
  frontier: probability,
});
const verdict: fc.Arbitrary<JevVerdict> = fc.record({
  probabilities,
  sensitive: probability,
  selfRouting: probability,
});
const accept = fc.record({ fast: probability, balanced: probability, frontier: probability });
const policyParts = fc.record({ sensitiveFloor: tier, claimGuard: fc.boolean() });

const probs = (fast: number, balanced: number, frontier: number) => ({ fast, balanced, frontier });

describe("pickTier", () => {
  it("accepts the top tier when it reaches its bar", () => {
    expect(pickTier(probs(0.9, 0.1, 0), DEFAULT_ACCEPT)).toBe("fast");
    expect(pickTier(probs(0.1, 0.6, 0.3), DEFAULT_ACCEPT)).toBe("balanced");
    expect(pickTier(probs(0.3, 0.35, 0.35), DEFAULT_ACCEPT)).toBe("frontier");
  });

  it("takes the more capable of the top two when the top tier misses its bar", () => {
    expect(pickTier(probs(0.75, 0.2, 0.05), DEFAULT_ACCEPT)).toBe("balanced");
    expect(pickTier(probs(0.5, 0, 0.5), DEFAULT_ACCEPT)).toBe("frontier");
    expect(pickTier(probs(0.05, 0.55, 0.4), DEFAULT_ACCEPT)).toBe("frontier");
  });

  it("is monotonic: raising any bar never lowers the tier", () => {
    fc.assert(
      fc.property(probabilities, accept, accept, (p, a, b) => {
        const higher = Object.fromEntries(TIERS.map((t) => [t, Math.max(a[t], b[t])])) as Record<
          Tier,
          number
        >;
        expect(tierRank(pickTier(p, higher))).toBeGreaterThanOrEqual(tierRank(pickTier(p, a)));
      }),
    );
  });
});

describe("guards", () => {
  it("apply the sensitive floor", () => {
    const result = applyGuards("fast", { sensitive: 0.9, selfRouting: 0 }, DEFAULT_POLICY);
    expect(result).toEqual({ tier: "balanced", guards: ["sensitive_floor"] });
  });

  it("raise a self-routing message by one level", () => {
    const result = applyGuards("balanced", { sensitive: 0, selfRouting: 0.7 }, DEFAULT_POLICY);
    expect(result).toEqual({ tier: "frontier", guards: ["claim_guard"] });
  });

  it("leave the tier alone when the claim guard is off", () => {
    const policy = { ...DEFAULT_POLICY, claimGuard: false };
    expect(applyGuards("fast", { sensitive: 0, selfRouting: 1 }, policy).tier).toBe("fast");
  });

  it("never lower the tier, whatever Jev answers (property)", () => {
    fc.assert(
      fc.property(tier, verdict, policyParts, (t, v, p) => {
        expect(tierRank(applyGuards(t, v, p).tier)).toBeGreaterThanOrEqual(tierRank(t));
      }),
    );
  });

  it("never let the final tier fall below Jev's accepted pick (property)", () => {
    fc.assert(
      fc.property(verdict, accept, policyParts, (v, a, p) => {
        const result = tierFromVerdict(v, { ...p, accept: a });
        expect(tierRank(result.tier)).toBeGreaterThanOrEqual(tierRank(result.pick));
        if (v.sensitive >= 0.5) {
          expect(tierRank(result.tier)).toBeGreaterThanOrEqual(tierRank(p.sensitiveFloor));
        }
      }),
    );
  });
});

describe("the ratchet (property)", () => {
  const session = (t: Tier, now: number): SessionState => ({
    tier: t,
    provisional: false,
    trusted: false,
    lastSeenAt: now,
    root: null,
  });

  it("never routes a human turn below the session's tier within the idle window", () => {
    fc.assert(
      fc.property(tier, fc.option(verdict, { nil: null }), (current, v) => {
        const now = 1_000_000;
        const plan = planRoute(
          {
            turn: "human",
            text: "do the thing",
            root: null,
            firstMessage: false,
            pin: null,
            headerTier: null,
            envTier: null,
            now,
          },
          session(current, now - 1000),
          DEFAULT_POLICY,
        );
        const routed = plan.kind === "done" ? plan : plan.complete(v);
        expect(routed).not.toBeNull();
        expect(tierRank(routed?.decision.tier as Tier)).toBeGreaterThanOrEqual(tierRank(current));
        expect(tierRank(routed?.session?.tier as Tier)).toBeGreaterThanOrEqual(tierRank(current));
      }),
    );
  });
});
