import { TIERS, type Tier } from "@switchkick/core";
import { DEFAULT_TIER_MODELS } from "./tiers.js";

/** Named sets of models, selected with `preset` in the config file. */
export const PRESETS = ["claude-only", "multi-provider"] as const;
export type Preset = (typeof PRESETS)[number];

export interface PresetModels {
  tiers: Record<Tier, { model: string }>;
  trusted: { model: string };
  /** Hosted mode's lists, used when the config file doesn't set them. */
  hosted: { models: string[]; excluded_models: string[] };
}

const CLAUDE_TIERS = Object.fromEntries(
  TIERS.map((tier) => [tier, { model: DEFAULT_TIER_MODELS[tier] }]),
) as PresetModels["tiers"];
const CLAUDE_TRUSTED = { model: DEFAULT_TIER_MODELS.balanced };

/**
 * Model authors on OpenRouter other than Anthropic, as of 2026-10-19. Hosted mode's `models` list is
 * only a preference, so the Claude-only preset also excludes these. `switchkick doctor` reports
 * authors that appeared since. `typesafe` and `openrouter` are left out: they publish routers, not
 * models a router picks.
 */
export const NON_ANTHROPIC_AUTHORS = [
  "aion-labs",
  "amazon",
  "anthracite-org",
  "arcee-ai",
  "bytedance",
  "bytedance-seed",
  "cognitivecomputations",
  "cohere",
  "deepseek",
  "dots-studio",
  "elorian",
  "fireworks",
  "google",
  "gryphe",
  "ibm-granite",
  "inception",
  "inclusionai",
  "inference-net",
  "liquid",
  "mancer",
  "meituan",
  "meta",
  "meta-llama",
  "microsoft",
  "minimax",
  "mistralai",
  "moondream",
  "moonshotai",
  "morph",
  "nex-agi",
  "nousresearch",
  "nvidia",
  "openai",
  "perceptron",
  "perplexity",
  "poolside",
  "prism-ml",
  "qwen",
  "reflection",
  "rekaai",
  "relace",
  "sakana",
  "sao10k",
  "scaledown",
  "stepfun",
  "tencent",
  "thedrummer",
  "thinkingmachines",
  "unbiased",
  "undi95",
  "upstage",
  "writer",
  "x-ai",
  "xiaomi",
  "xingchen-agi",
  "z-ai",
] as const;

/** Authors the Claude-only preset never excludes. */
export const ROUTER_AUTHORS = ["anthropic", "typesafe", "openrouter"] as const;

export const PRESET_MODELS: Record<Preset, PresetModels> = {
  /**
   * Anthropic models only, which is what Claude Code supports. The default for Claude Code.
   */
  "claude-only": {
    tiers: CLAUDE_TIERS,
    trusted: CLAUDE_TRUSTED,
    hosted: {
      models: ["anthropic/*"],
      excluded_models: NON_ANTHROPIC_AUTHORS.map((author) => `${author}/*`),
    },
  },
  /**
   * Models from several providers, all with tool calling and reasoning effort. The default for
   * Codex and OpenAI SDK apps, which can talk to any model through OpenRouter.
   */
  "multi-provider": {
    tiers: {
      fast: { model: "google/gemini-3.8-flash" },
      balanced: { model: "openai/gpt-6.1-sol" },
      frontier: { model: "anthropic/claude-opus-5.5" },
    },
    trusted: { model: "anthropic/claude-sonnet-5.5" },
    hosted: { models: [], excluded_models: [] },
  },
};

/** Without a preset: Claude models per tier, and no hosted lists (the router picks freely). */
export const NO_PRESET: PresetModels = {
  tiers: CLAUDE_TIERS,
  trusted: CLAUDE_TRUSTED,
  hosted: { models: [], excluded_models: [] },
};

export function presetModels(preset: Preset | undefined): PresetModels {
  return preset ? PRESET_MODELS[preset] : NO_PRESET;
}
