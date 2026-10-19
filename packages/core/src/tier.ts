/** Capability tiers, ordered from cheapest to most capable. */
export const TIERS = ["fast", "balanced", "frontier"] as const;

export type Tier = (typeof TIERS)[number];

/** The most capable tier. */
export const TOP_TIER: Tier = TIERS[TIERS.length - 1] as Tier;

export function isTier(value: unknown): value is Tier {
  return (TIERS as readonly unknown[]).includes(value);
}

/** Position of a tier in capability order; higher is more capable. */
export function tierRank(tier: Tier): number {
  return TIERS.indexOf(tier);
}

/** The more capable of two tiers. Used by guards and the session ratchet, which may only raise. */
export function maxTier(a: Tier, b: Tier): Tier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

/** The tier `steps` levels above `tier`, stopping at the top. */
export function raiseTier(tier: Tier, steps = 1): Tier {
  return TIERS[Math.min(TIERS.length - 1, tierRank(tier) + steps)] as Tier;
}
