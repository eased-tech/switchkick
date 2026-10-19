import { TIERS, type Tier } from "./tier.js";

/** A `#fast`, `#balanced` or `#frontier` tag the user typed. `#fast!` forces the tier down too. */
export interface TierTag {
  tier: Tier;
  /** Written with a trailing `!`: applies even below a session's ratcheted tier. */
  force: boolean;
}

const NAMES = TIERS.join("|");
// A tag counts only as the first or last word on a line, so `#fast` in pasted code or prose
// mid-sentence isn't read as an instruction.
const LEADING = new RegExp(`^[ \\t]*#(${NAMES})(!?)(?=\\s|$)`, "gim");
const TRAILING = new RegExp(`(?:^|[ \\t])#(${NAMES})(!?)[ \\t]*$`, "gim");

/**
 * The tier tag in a human message, if any. A tag is the first or last word on a line, e.g.
 * `#frontier redesign the cache` or `rename this variable #fast`. When there are several, the last
 * one wins.
 */
export function parseTierTag(text: string): TierTag | null {
  let found: { index: number; tag: TierTag } | null = null;
  for (const pattern of [LEADING, TRAILING]) {
    for (const match of text.matchAll(pattern)) {
      const tier = match[1]?.toLowerCase() as Tier;
      if (found === null || match.index > found.index) {
        found = { index: match.index, tag: { tier, force: match[2] === "!" } };
      }
    }
  }
  return found?.tag ?? null;
}
