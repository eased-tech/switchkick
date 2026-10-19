import { z } from "zod";

/** The OpenRouter model that hands each request to the Jev router. */
export const JEV_ROUTER_MODEL = "typesafe/jev-router";

/** The router's spend policies, from cheapest to most capable. */
export const COST_TIERS = ["low", "medium", "high"] as const;
export type CostTier = (typeof COST_TIERS)[number];

/** Limits the router enforces on each model list, returning 400 beyond them. */
export const MAX_PATTERNS = 1024;
export const MAX_PATTERN_CHARS = 1024;
export const MAX_LIST_CHARS = 65_536;

/**
 * A list of model patterns: exact slugs (`anthropic/claude-sonnet-5.5`), dated revisions,
 * case-sensitive wildcards (`anthropic/*`, `*flash*`) or family aliases (`~anthropic/claude-opus-latest`).
 */
export const ModelPatterns = z
  .array(z.string().min(1).max(MAX_PATTERN_CHARS))
  .max(MAX_PATTERNS)
  .refine(
    (patterns) => patterns.reduce((total, pattern) => total + pattern.length, 0) <= MAX_LIST_CHARS,
    `the patterns may total at most ${MAX_LIST_CHARS} characters`,
  );

/**
 * The plugin entry the router accepts. It rejects any other field with a 400, so switchkick
 * validates the entry before sending it rather than spending a round trip to find out.
 */
export const JevRouterPluginSchema = z.strictObject({
  id: z.literal("jev-router"),
  cost_tier: z.enum(COST_TIERS).optional(),
  /** Include preferences: ignored by the router when none of them is in its pool. */
  models: ModelPatterns.optional(),
  /** An alias of `models`. */
  allowed_models: ModelPatterns.optional(),
  /** Hard exclusions: the router never picks a match, and returns 404 if nothing is left. */
  excluded_models: ModelPatterns.optional(),
});

export type JevRouterPlugin = z.infer<typeof JevRouterPluginSchema>;

/** What to do with reasoning settings the router rejects: drop them, or refuse the request. */
export const UNSUPPORTED_REASONING = ["strip", "reject"] as const;
export type UnsupportedReasoning = (typeof UNSUPPORTED_REASONING)[number];

export interface HostedRoute {
  plugin: JevRouterPlugin;
  /** Defaults to `strip`. */
  unsupportedReasoning?: UnsupportedReasoning;
}

export interface HostedSettings {
  cost_tier: CostTier;
  models: string[];
  excluded_models: string[];
}

/** The plugin entry for the config's `hosted` settings. Empty lists are left out. */
export function jevRouterPlugin(settings: HostedSettings): JevRouterPlugin {
  return validatePlugin({
    id: "jev-router",
    cost_tier: settings.cost_tier,
    ...(settings.models.length > 0 ? { models: settings.models } : {}),
    ...(settings.excluded_models.length > 0 ? { excluded_models: settings.excluded_models } : {}),
  });
}

/** Checks a plugin entry against what the router accepts. Throws with every problem listed. */
export function validatePlugin(plugin: unknown): JevRouterPlugin {
  const result = JevRouterPluginSchema.safeParse(plugin);
  if (!result.success) {
    throw new Error(`Invalid jev-router plugin:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouterPlugin(entry: unknown): boolean {
  return isPlainObject(entry) && entry.id === "jev-router";
}

/** `body` without any `jev-router` plugin entry, for sending a request somewhere other than the router. */
export function withoutRouterPlugin(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.plugins) || !body.plugins.some(isRouterPlugin)) return body;
  return { ...body, plugins: body.plugins.filter((entry) => !isRouterPlugin(entry)) };
}

export type PreparedHostedBody =
  | { body: Record<string, unknown>; warnings: string[] }
  | { error: string; param: string };

/**
 * Rewrites a client request for the router: `model` becomes {@link JEV_ROUTER_MODEL} and the
 * plugin entry is added. The client's other plugins are kept, but a `jev-router` entry of its own
 * is replaced, so `excluded_models` from the config always applies. Reasoning settings the router
 * rejects are stripped or refused. The client's `reasoning.effort` passes through as a hint.
 * `body` is not modified.
 */
export function prepareHostedBody(
  body: Record<string, unknown>,
  route: HostedRoute,
): PreparedHostedBody {
  const warnings: string[] = [];
  const out: Record<string, unknown> = { ...body, model: JEV_ROUTER_MODEL };

  let plugins: unknown[] = [];
  if (body.plugins != null) {
    if (!Array.isArray(body.plugins)) {
      return { error: "`plugins` must be an array.", param: "plugins" };
    }
    plugins = body.plugins.filter((entry) => !isRouterPlugin(entry));
    if (plugins.length < body.plugins.length) warnings.push("client_router_plugin_replaced");
  }
  out.plugins = [...plugins, route.plugin];

  if (isPlainObject(body.reasoning)) {
    const { max_tokens: maxTokens, ...reasoning } = body.reasoning;
    const hasMaxTokens = maxTokens !== undefined;
    const isPro = reasoning.mode === "pro";
    if (hasMaxTokens || isPro) {
      if (route.unsupportedReasoning === "reject") {
        const fields = [hasMaxTokens && "reasoning.max_tokens", isPro && 'reasoning.mode "pro"'];
        return {
          error:
            `The Jev router doesn't accept ${fields.filter(Boolean).join(" or ")}. Remove it, ` +
            "or set `hosted.unsupportedReasoning: strip` in the switchkick config to drop it.",
          param: "reasoning",
        };
      }
      if (hasMaxTokens) warnings.push("reasoning_max_tokens_stripped");
      if (isPro) {
        warnings.push("reasoning_mode_pro_stripped");
        delete reasoning.mode;
      }
      if (Object.keys(reasoning).length > 0) out.reasoning = reasoning;
      else delete out.reasoning;
    }
  }
  return { body: out, warnings };
}
