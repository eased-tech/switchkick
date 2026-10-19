/** Capability tiers, ordered from cheapest to most capable. */
export const TIERS = ["fast", "balanced", "frontier"] as const;

export type Tier = (typeof TIERS)[number];

/** Position of a tier in capability order; higher is more capable. */
export function tierRank(tier: Tier): number {
  return TIERS.indexOf(tier);
}

/** The more capable of two tiers. Used by guards and the session ratchet, which may only raise. */
export function maxTier(a: Tier, b: Tier): Tier {
  return tierRank(a) >= tierRank(b) ? a : b;
}
