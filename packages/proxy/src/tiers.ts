import type { Tier } from "@switchkick/core";

/**
 * Built-in model for each tier until a config file can override it. Claude-only, so every
 * client (Claude Code included) gets a model it can talk to.
 */
export const DEFAULT_TIER_MODELS: Record<Tier, string> = {
  fast: "anthropic/claude-haiku-5.5",
  balanced: "anthropic/claude-sonnet-5.5",
  frontier: "anthropic/claude-opus-5.5",
};
