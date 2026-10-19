import type { JevVerdict } from "./questions.js";
import { maxTier, raiseTier, TIERS, type Tier, tierRank } from "./tier.js";

/** How a session's tier evolves across human turns. */
export const SESSION_MODES = ["ratchet", "sticky", "per-request"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export interface Policy {
  /** Used when Jev fails, and for requests that can't be decided. */
  defaultTier: Tier;
  /**
   * - `ratchet`: decide at every human turn, but never below the session's current tier.
   * - `sticky`: decide once per session.
   * - `per-request`: decide at every human turn, with no memory.
   */
  session: SessionMode;
  /** Probability Jev's top tier needs to be accepted. Cheaper tiers should need more. */
  accept: Record<Tier, number>;
  /** Lowest tier for a request Jev considers sensitive. */
  sensitiveFloor: Tier;
  /** Raise the tier one level when a message tries to steer its own routing. */
  claimGuard: boolean;
  /** After this long without requests, the next human turn starts the session afresh. */
  idleResetMs: number;
  /** Refuse requests (503) instead of falling back when Jev fails. */
  failClosed: boolean;
}

export const DEFAULT_ACCEPT: Readonly<Record<Tier, number>> = {
  fast: 0.85,
  balanced: 0.6,
  frontier: 0.3,
};

export const DEFAULT_POLICY: Readonly<Policy> = {
  defaultTier: "balanced",
  session: "ratchet",
  accept: DEFAULT_ACCEPT,
  sensitiveFloor: "balanced",
  claimGuard: true,
  idleResetMs: 30 * 60_000,
  failClosed: false,
};

/** A Noul answer at or above this probability counts as yes. */
export const NOUL_THRESHOLD = 0.5;

/**
 * Jev's tier, held to the acceptance bars: the top tier stands if its probability reaches its
 * bar. Otherwise the more capable of the top two is taken, so doubt costs money, not quality.
 * Ties between probabilities go to the more capable tier.
 */
export function pickTier(probabilities: Record<Tier, number>, accept: Record<Tier, number>): Tier {
  const ranked = [...TIERS].sort(
    (a, b) => probabilities[b] - probabilities[a] || tierRank(b) - tierRank(a),
  );
  const [top, second] = ranked as [Tier, Tier, ...Tier[]];
  return probabilities[top] >= accept[top] ? top : maxTier(top, second);
}

export type Guard = "sensitive_floor" | "claim_guard";

/**
 * Applies the guards to a tier. They can only raise it: Jev reads text the user controls, so no
 * answer may push the tier below what the policy would otherwise choose.
 */
export function applyGuards(
  tier: Tier,
  verdict: Pick<JevVerdict, "sensitive" | "selfRouting">,
  policy: Pick<Policy, "sensitiveFloor" | "claimGuard">,
): { tier: Tier; guards: Guard[] } {
  const guards: Guard[] = [];
  let result = tier;
  if (verdict.sensitive >= NOUL_THRESHOLD && tierRank(result) < tierRank(policy.sensitiveFloor)) {
    result = policy.sensitiveFloor;
    guards.push("sensitive_floor");
  }
  if (policy.claimGuard && verdict.selfRouting >= NOUL_THRESHOLD) {
    result = raiseTier(result);
    guards.push("claim_guard");
  }
  return { tier: result, guards };
}

/** The tier Jev's answers lead to: the accepted pick, then the guards. */
export function tierFromVerdict(
  verdict: JevVerdict,
  policy: Pick<Policy, "accept" | "sensitiveFloor" | "claimGuard">,
): { tier: Tier; pick: Tier; guards: Guard[] } {
  const pick = pickTier(verdict.probabilities, policy.accept);
  return { pick, ...applyGuards(pick, verdict, policy) };
}
