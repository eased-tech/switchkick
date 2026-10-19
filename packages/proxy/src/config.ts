import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ACCEPT,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_POLICY,
  type Policy,
  SESSION_MODES,
  TIERS,
  type Tier,
} from "@switchkick/core";
import {
  DEFAULT_DEADLINE_MS,
  DEFAULT_DECISIONS_BASE_URL,
  DEFAULT_JEV_MODEL,
} from "@switchkick/jev";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { COST_TIERS, ModelPatterns, UNSUPPORTED_REASONING } from "./hosted.js";
import { DEFAULT_TIER_MODELS } from "./tiers.js";

export const CONFIG_SCHEMA_URL = "https://eased-tech.github.io/switchkick/schema/v1.json";

/**
 * Reasoning effort levels a tier can set. These are the levels all three client APIs accept on
 * OpenRouter; `minimal` and `none` are left out because Anthropic Messages rejects them.
 */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Routing modes. */
export const MODES = ["static", "hosted", "local"] as const;
export type Mode = (typeof MODES)[number];

const UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

/** Byte counts: an integer, or a string such as `20mb` (binary units). */
const Size = z
  .union([
    z.int().positive(),
    z.string().regex(/^\s*\d+\s*([kKmMgG]?[bB])\s*$/, "expected a size such as 512kb or 20mb"),
  ])
  .transform((value) => {
    if (typeof value === "number") return value;
    const [, digits = "0", unit = "b"] = /^\s*(\d+)\s*([a-z]+)\s*$/.exec(value.toLowerCase()) ?? [];
    return Number(digits) * (UNITS[unit] ?? 1);
  });

const TierTarget = z.strictObject({
  model: z.string().min(1).describe("OpenRouter model slug, e.g. anthropic/claude-sonnet-5.5."),
  effort: z
    .enum(EFFORTS)
    .optional()
    .describe("Reasoning effort to request. Omit to keep whatever the client sent."),
});

/** Characters of conversation text Jev sees, which keeps requests out of its long-context mode. */
export const DEFAULT_REQUEST_CHARS = 24_000;

const Probability = z.number().min(0).max(1);

const tierTargets = Object.fromEntries(
  TIERS.map((tier) => [
    tier,
    TierTarget.optional().describe(`Defaults to { model: ${DEFAULT_TIER_MODELS[tier]} }.`),
  ]),
) as Record<Tier, z.ZodOptional<typeof TierTarget>>;

export const ConfigSchema = z
  .strictObject({
    $schema: z.string().optional().describe("JSON Schema URL, for editor support."),
    mode: z
      .enum(MODES)
      .default("static")
      .describe(
        "How requests are routed. `static` sends every request to `defaultTier`. `hosted` lets " +
          "OpenRouter's Jev router choose the model, configured by `hosted`. `local` asks Jev " +
          "which tier each human turn needs, and applies `policy`.",
      ),
    defaultTier: z
      .enum(TIERS)
      .default("balanced")
      .describe(
        "Tier used in static mode, in hosted mode when the router is unavailable (HTTP 503), " +
          "and in local mode when Jev fails or times out.",
      ),
    tiers: z
      .strictObject(tierTargets)
      .default({})
      .describe("Model per tier. A tier given here replaces the built-in one entirely."),
    trusted: TierTarget.optional().describe(
      "Local mode: the model for every request in a session where a secret (an API key, a " +
        `private key, a password) was seen. Defaults to { model: ${DEFAULT_TIER_MODELS.balanced} }.`,
    ),
    policy: z
      .strictObject({
        session: z
          .enum(SESSION_MODES)
          .default(DEFAULT_POLICY.session)
          .describe(
            "How a session's tier evolves. `ratchet` decides at every human turn but never goes " +
              "below the session's tier, which keeps the prompt cache warm. `sticky` decides " +
              "once per session. `per-request` decides every human turn afresh.",
          ),
        accept: z
          .strictObject({
            fast: Probability.default(DEFAULT_ACCEPT.fast),
            balanced: Probability.default(DEFAULT_ACCEPT.balanced),
            frontier: Probability.default(DEFAULT_ACCEPT.frontier),
          })
          .default({ ...DEFAULT_ACCEPT })
          .describe(
            "Probability Jev's top tier needs to be accepted. Below it, the more capable of " +
              "Jev's top two tiers is used. Cheaper tiers should need more confidence.",
          ),
        sensitiveFloor: z
          .enum(TIERS)
          .default(DEFAULT_POLICY.sensitiveFloor)
          .describe(
            "Lowest tier for requests that touch production, credentials or destructive operations.",
          ),
        claimGuard: z
          .boolean()
          .default(DEFAULT_POLICY.claimGuard)
          .describe(
            "Raise the tier one level when a message tries to dictate its own tier or claims " +
              "prior review.",
          ),
        idleResetMinutes: z
          .number()
          .min(0)
          .default(DEFAULT_POLICY.idleResetMs / 60_000)
          .describe("After this long without requests, a session starts afresh at its next turn."),
        failClosed: z
          .boolean()
          .default(DEFAULT_POLICY.failClosed)
          .describe("Answer 503 when Jev fails, instead of falling back to `defaultTier`."),
        maxSessions: z
          .int()
          .min(1)
          .default(DEFAULT_MAX_SESSIONS)
          .describe("Sessions kept in memory. The least recently used are forgotten first."),
        modelPins: z
          .record(z.string().min(1), z.string().min(1))
          .default({})
          .describe(
            "Requested models to send to a fixed OpenRouter model instead of routing, e.g. " +
              '`{ "claude-opus-*": anthropic/claude-opus-5.5 }`. `*` matches anything.',
          ),
        slugPins: z
          .boolean()
          .default(true)
          .describe(
            "Send a requested model that is already an OpenRouter slug (contains `/`, e.g. " +
              "`openai/gpt-5.5`) as is, instead of routing it. Set to false to make `tiers`, " +
              "`trusted` and `modelPins` the only models local mode can use.",
          ),
      })
      .default({
        session: DEFAULT_POLICY.session,
        accept: { ...DEFAULT_ACCEPT },
        sensitiveFloor: DEFAULT_POLICY.sensitiveFloor,
        claimGuard: DEFAULT_POLICY.claimGuard,
        idleResetMinutes: DEFAULT_POLICY.idleResetMs / 60_000,
        failClosed: DEFAULT_POLICY.failClosed,
        maxSessions: DEFAULT_MAX_SESSIONS,
        modelPins: {},
        slugPins: true,
      })
      .describe("Local mode routing policy."),
    jev: z
      .strictObject({
        model: z
          .string()
          .min(1)
          .default(DEFAULT_JEV_MODEL)
          .describe(
            "Jev model. Pinned to a version because the thresholds are tuned against it; " +
              "`~typesafe/jev-latest` follows new releases.",
          ),
        baseUrl: z
          .url()
          .default(DEFAULT_DECISIONS_BASE_URL)
          .describe("Base URL of OpenRouter's Decisions API."),
        deadlineMs: z
          .int()
          .min(50)
          .max(60_000)
          .default(DEFAULT_DEADLINE_MS)
          .describe("How long to wait for Jev before falling back. Jev's median is about 0.7 s."),
        requestChars: z
          .int()
          .min(1000)
          .max(1_000_000)
          .default(DEFAULT_REQUEST_CHARS)
          .describe(
            "Most characters of conversation text sent to Jev. Above about 32,000, Jev switches " +
              "to a slower, less accurate long-context mode.",
          ),
      })
      .default({
        model: DEFAULT_JEV_MODEL,
        baseUrl: DEFAULT_DECISIONS_BASE_URL,
        deadlineMs: DEFAULT_DEADLINE_MS,
        requestChars: DEFAULT_REQUEST_CHARS,
      })
      .describe("Local mode: how switchkick calls Jev."),
    hosted: z
      .strictObject({
        cost_tier: z
          .enum(COST_TIERS)
          .default("medium")
          .describe("The router's spend policy. Higher tiers pick more capable, costlier models."),
        models: ModelPatterns.default([]).describe(
          "Models the router should prefer: slugs, wildcards such as `anthropic/*`, or " +
            "`~author/family-latest` aliases. A preference only: if none of them is in the " +
            "router's pool, the router ignores the list. Use local mode for a strict allowlist.",
        ),
        excluded_models: ModelPatterns.default([]).describe(
          "Models the router must never pick, in the same pattern syntax. The only hard " +
            "restriction: if it excludes every candidate, requests fail with 404.",
        ),
        unsupportedReasoning: z
          .enum(UNSUPPORTED_REASONING)
          .default("strip")
          .describe(
            'What to do with `reasoning.max_tokens` and `reasoning.mode: "pro"`, which the ' +
              "router rejects: `strip` drops them and notes it in the log, `reject` answers 400.",
          ),
      })
      .default({
        cost_tier: "medium",
        models: [],
        excluded_models: [],
        unsupportedReasoning: "strip",
      })
      .describe("Hosted mode settings."),
    attribution: z
      .boolean()
      .default(true)
      .describe("Send OpenRouter app-attribution headers naming switchkick."),
    server: z
      .strictObject({
        host: z.string().min(1).default("127.0.0.1").describe("Address to listen on."),
        port: z.int().min(0).max(65535).default(8787).describe("Port to listen on."),
        maxBodyBytes: Size.default(20 * 1024 ** 2).describe("Largest request body accepted."),
      })
      .default({ host: "127.0.0.1", port: 8787, maxBodyBytes: 20 * 1024 ** 2 }),
    upstream: z
      .strictObject({
        baseUrl: z.url().default("https://openrouter.ai/api/v1").describe("OpenRouter API URL."),
      })
      .default({ baseUrl: "https://openrouter.ai/api/v1" }),
    log: z
      .strictObject({
        enabled: z.boolean().default(true).describe("Write the decision log."),
        file: z
          .string()
          .min(1)
          .optional()
          .describe("Decision log path. Defaults to $XDG_STATE_HOME/switchkick/decisions.jsonl."),
        maxBytes: Size.default(50 * 1024 ** 2).describe("Size at which the log is rotated."),
      })
      .default({ enabled: true, maxBytes: 50 * 1024 ** 2 }),
  })
  .meta({ $id: CONFIG_SCHEMA_URL, title: "switchkick configuration" });

/** A validated config file, with defaults applied. */
export type Config = z.output<typeof ConfigSchema>;

export interface TierTargetConfig {
  model: string;
  effort?: Effort;
}

/** Built-in tiers, with any tier from the config file replacing its built-in counterpart. */
export function resolveTiers(config: Config): Record<Tier, TierTargetConfig> {
  return Object.fromEntries(
    TIERS.map((tier) => [tier, config.tiers[tier] ?? { model: DEFAULT_TIER_MODELS[tier] }]),
  ) as Record<Tier, TierTargetConfig>;
}

/** The trusted target, falling back to the built-in balanced model. */
export function resolveTrusted(config: Config): TierTargetConfig {
  return (
    (config.trusted as TierTargetConfig | undefined) ?? { model: DEFAULT_TIER_MODELS.balanced }
  );
}

/** The core routing policy for a config's `defaultTier` and `policy` settings. */
export function resolvePolicy(config: Config, defaultTier: Tier = config.defaultTier): Policy {
  const { policy } = config;
  return {
    defaultTier,
    session: policy.session,
    accept: policy.accept,
    sensitiveFloor: policy.sensitiveFloor,
    claimGuard: policy.claimGuard,
    idleResetMs: policy.idleResetMinutes * 60_000,
    failClosed: policy.failClosed,
  };
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** `$XDG_CONFIG_HOME/switchkick`, falling back to `~/.config/switchkick`. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "switchkick");
}

/** Expands a leading `~/`, which YAML users expect to work in paths. */
export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .flatMap((issue) => {
      const at = issue.path.join(".");
      if (issue.code === "unrecognized_keys") {
        return issue.keys.map((key) => `${at ? `${at}.` : ""}${key}: unrecognized key`);
      }
      return [`${at || "(root)"}: ${issue.message}`];
    })
    .join("\n");
}

/** Validates parsed YAML. `source` names the file in error messages. */
export function parseConfig(raw: unknown, source: string): Config {
  const result = ConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new ConfigError(`Invalid config in ${source}:\n${formatIssues(result.error)}`);
  }
  return result.data;
}

export interface LoadedConfig {
  config: Config;
  /** The file the config came from, or null when only built-in defaults apply. */
  path: string | null;
}

/**
 * Loads the config from, in order: `explicitPath` (the `--config` flag), `$SWITCHKICK_CONFIG`,
 * then `config.yaml` in {@link configDir}. A missing file is an error unless it is the default
 * path, which falls back to built-in defaults.
 */
export async function loadConfig(
  explicitPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<LoadedConfig> {
  const chosen = explicitPath ?? env.SWITCHKICK_CONFIG;
  const path = chosen ? expandHome(chosen) : join(configDir(env), "config.yaml");

  let text: string;
  try {
    text = await read(path);
  } catch (error) {
    if (!chosen && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: parseConfig({}, "built-in defaults"), path: null };
    }
    throw new ConfigError(`Can't read config file ${path}: ${(error as Error).message}`);
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`Invalid YAML in ${path}: ${(error as Error).message}`);
  }
  return { config: parseConfig(raw, path), path };
}

/** The config file's JSON Schema, published at {@link CONFIG_SCHEMA_URL}. */
export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ConfigSchema, { io: "input" }) as Record<string, unknown>;
}
