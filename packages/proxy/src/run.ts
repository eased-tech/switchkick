import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import { createAdaptorServer } from "@hono/node-server";
import { SessionStore, TIERS, type Tier } from "@switchkick/core";
import { createJevClient, type DecideFailure } from "@switchkick/jev";
import { isLoopback, LOOPBACK_HOSTS } from "./access.js";
import { createApp, VERSION } from "./app.js";
import {
  type Config,
  ConfigError,
  configDir,
  expandHome,
  loadConfig,
  MODES,
  type Mode,
  resolvePolicy,
  resolveTiers,
  resolveTrusted,
} from "./config.js";
import {
  CredentialError,
  defaultCredentialDeps,
  envFilePath,
  type FoundKey,
  findApiKey,
} from "./credentials.js";
import { ATTRIBUTION } from "./forward.js";
import { COST_TIER_FOR, JEV_ROUTER_MODEL, jevRouterPlugin } from "./hosted.js";
import type { LocalRoute } from "./local.js";
import { createFileLog, type DecisionLog, defaultLogPath, NO_LOG } from "./log.js";
import { defaultSessionsPath, type PersistedSessions, persistSessions } from "./sessions.js";

const HELP = `switchkick ${VERSION}

Usage:
  switchkick serve [options]
  switchkick --version
  switchkick --help

Serve options (each overrides the config file):
  --config <path>     Config file (default ${configDir()}/config.yaml if it exists)
  --host <addr>       Address to listen on (default 127.0.0.1)
  --port <n>          Port to listen on (default 8787)
  --mode <mode>       How requests are routed: ${MODES.join(", ")} (default static)
  --tier <tier>       Tier every request is routed to in static mode, and the fallback in
                      hosted and local mode: ${TIERS.join(", ")} (default balanced)
  --log-file <path>   Decision log (default ${defaultLogPath()})
  --no-log            Don't write a decision log
  --no-attribution    Don't identify requests as coming from switchkick (see below)

API key, the first found wins:
  1. The OPENROUTER_API_KEY environment variable.
  2. The OS credential store, service "switchkick", account "openrouter":
       macOS:  security add-generic-password -s switchkick -a openrouter -w
       Linux:  secret-tool store --label=switchkick service switchkick account openrouter
  3. ${envFilePath()}, a file with an OPENROUTER_API_KEY=... line. It must be
     readable only by you (chmod 600).

Environment:
  SWITCHKICK_CONFIG   Config file, if --config isn't given.
  SWITCHKICK_TOKEN    Clients must send this as their API key. Required when the host is not a
                      loopback address.
  SWITCHKICK_TIER     Route every request at this tier: the static tier, the tier in local
                      mode (Jev isn't asked), or the matching cost_tier in hosted mode.
  SWITCHKICK_ATTRIBUTION=off
                      Same as --no-attribution.

By default, requests carry OpenRouter app-attribution headers naming switchkick, so its usage
appears (summed across all users) in OpenRouter's public app rankings. Nothing identifying you
is sent.
`;

export interface RunIo {
  env: NodeJS.ProcessEnv;
  /** Finds the OpenRouter key. Defaults to the real environment, credential store and env file. */
  findApiKey?: (env: NodeJS.ProcessEnv) => Promise<FoundKey>;
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface RunResult {
  exitCode: number;
  /** The listening server, for `serve`. */
  server?: Server;
  /**
   * Stops `serve`: stops accepting connections, then saves sessions and flushes the decision log.
   * Requests still streaming are not waited for.
   */
  close?: () => Promise<void>;
}

interface ServeFlags {
  config?: string | undefined;
  host?: string | undefined;
  port?: string | undefined;
  mode?: string | undefined;
  tier?: string | undefined;
  "log-file"?: string | undefined;
  log?: boolean | undefined;
  attribution?: boolean | undefined;
}

export interface ServeSettings {
  host: string;
  port: number;
  mode: Mode;
  tier: Tier;
  /** `SWITCHKICK_TIER` in hosted and local mode, where it overrides every request. */
  envTier: Tier | null;
  token: string | null;
  attribution: boolean;
  /** Null when logging is off. */
  logFile: string | null;
}

function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value);
}

const OFF = ["off", "false", "0", "no"];

/**
 * Merges flags over environment over the config file (which already carries built-in defaults).
 * Returns an error message when the combination is invalid.
 */
export function resolveSettings(
  flags: ServeFlags,
  env: NodeJS.ProcessEnv,
  config: Config,
): ServeSettings | string {
  const host = flags.host ?? config.server.host;
  let port = config.server.port;
  if (flags.port !== undefined) {
    port = Number(flags.port);
    if (!/^\d+$/.test(flags.port) || port > 65535) {
      return `--port must be an integer from 0 to 65535, got "${flags.port}".`;
    }
  }
  const mode = flags.mode ?? config.mode;
  if (!isMode(mode)) return `--mode must be one of ${MODES.join(", ")}, got "${mode}".`;
  const envTier = env.SWITCHKICK_TIER?.trim().toLowerCase() || null;
  if (envTier !== null && !isTier(envTier)) {
    return `SWITCHKICK_TIER must be one of ${TIERS.join(", ")}, got "${env.SWITCHKICK_TIER}".`;
  }
  // In static mode the environment's tier is the static tier, below the flag.
  const tier = flags.tier ?? (mode === "static" ? envTier : null) ?? config.defaultTier;
  if (!isTier(tier)) return `--tier must be one of ${TIERS.join(", ")}, got "${tier}".`;

  const token = env.SWITCHKICK_TOKEN?.trim() || null;
  if (token === null && !isLoopback(host)) {
    return (
      `refusing to listen on ${host} without SWITCHKICK_TOKEN: anyone who can reach it could ` +
      "spend your OpenRouter credits."
    );
  }

  const attributionEnv = env.SWITCHKICK_ATTRIBUTION?.trim().toLowerCase() ?? "";
  const attribution =
    flags.attribution ?? (OFF.includes(attributionEnv) ? false : config.attribution);
  const logging = flags.log ?? config.log.enabled;
  const logFile = flags["log-file"] ?? (config.log.file && expandHome(config.log.file));

  return {
    host,
    port,
    mode,
    tier,
    envTier: mode === "static" ? null : envTier,
    token,
    attribution,
    logFile: logging ? (logFile ?? defaultLogPath(env)) : null,
  };
}

async function listen(server: Server, host: string, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address() as AddressInfo);
    });
  });
}

/** The `switchkick` command line. `cli.ts` calls this with the real process. */
export async function run(argv: string[], io: RunIo): Promise<RunResult> {
  const fail = (message: string): RunResult => {
    io.stderr(`switchkick: ${message}\n`);
    return { exitCode: 1 };
  };

  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    return fail(`${(error as Error).message}\n\n${HELP}`);
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(`${VERSION}\n`);
    return { exitCode: 0 };
  }
  const [command] = positionals;
  if (values.help || command === undefined) {
    io.stdout(HELP);
    return { exitCode: 0 };
  }
  if (command !== "serve") return fail(`unknown command: ${command}\n\n${HELP}`);

  let loaded: Awaited<ReturnType<typeof loadConfig>>;
  try {
    loaded = await loadConfig(values.config, io.env);
  } catch (error) {
    if (error instanceof ConfigError) return fail(error.message);
    throw error;
  }
  const settings = resolveSettings(values, io.env, loaded.config);
  if (typeof settings === "string") return fail(settings);

  let found: FoundKey;
  try {
    found = await (io.findApiKey ?? ((env) => findApiKey(defaultCredentialDeps(env))))(io.env);
  } catch (error) {
    if (error instanceof CredentialError) return fail(error.message);
    throw error;
  }

  let log: DecisionLog = NO_LOG;
  let flushLog = async () => {};
  if (settings.logFile !== null) {
    const path = settings.logFile;
    const fileLog = createFileLog({
      path,
      maxBytes: loaded.config.log.maxBytes,
      onError: (error) =>
        io.stderr(`switchkick: can't write the decision log at ${path}: ${error}\n`),
    });
    log = fileLog;
    flushLog = fileLog.flush;
  }

  const tiers = resolveTiers(loaded.config);
  const target = tiers[settings.tier];
  const { hosted, jev } = loaded.config;
  const trusted = resolveTrusted(loaded.config);
  let local: LocalRoute | null = null;
  let persisted: PersistedSessions | null = null;
  let sessionsLine = "";
  if (settings.mode === "local") {
    const warned = new Set<number>();
    const { policy } = loaded.config;
    const sessions = new SessionStore(policy.maxSessions);
    if (policy.persistSessions) {
      const path = policy.sessionFile
        ? expandHome(policy.sessionFile)
        : defaultSessionsPath(io.env);
      persisted = await persistSessions({
        path,
        store: sessions,
        onError: (error) =>
          io.stderr(`switchkick: can't read or save sessions at ${path}: ${error}\n`),
      });
      sessionsLine = `  sessions: ${path} (${sessions.size} restored)\n`;
    }
    const jevClient = createJevClient({
      apiKey: found.key,
      model: jev.model,
      baseUrl: jev.baseUrl,
      deadlineMs: jev.deadlineMs,
      headers: settings.attribution ? { ...ATTRIBUTION } : {},
    });
    // With SWITCHKICK_TIER set, Jev is never asked, so there is nothing to warm.
    if (!settings.envTier) void jevClient.warm?.();
    local = {
      jev: jevClient,
      sessions,
      policy: resolvePolicy(loaded.config, settings.tier),
      tiers,
      trusted,
      modelPins: loaded.config.policy.modelPins,
      slugPins: loaded.config.policy.slugPins,
      requestChars: jev.requestChars,
      onJevError: (failure) => {
        // Configuration problems and bugs are worth a warning, once per status. Timeouts and
        // outages just fall back, and show up in the decision log.
        const status = failure.kind === "http" ? failure.status : 0;
        if (![400, 401, 402, 403, 404, 413].includes(status) || warned.has(status)) return;
        warned.add(status);
        io.stderr(`switchkick: Jev returned ${status}: ${jevErrorHint(failure)}\n`);
      },
    };
  }
  const app = createApp({
    apiKey: found.key,
    route: { tier: settings.tier, ...target },
    hosted:
      settings.mode === "hosted"
        ? {
            plugin: jevRouterPlugin(hosted),
            unsupportedReasoning: hosted.unsupportedReasoning,
          }
        : null,
    local,
    envTier: settings.envTier,
    upstreamBaseUrl: loaded.config.upstream.baseUrl.replace(/\/+$/, ""),
    maxBodyBytes: loaded.config.server.maxBodyBytes,
    token: settings.token,
    allowedHosts: new Set([...LOOPBACK_HOSTS, settings.host.replace(/^\[|\]$/g, "").toLowerCase()]),
    log,
    attribution: settings.attribution,
  });
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  let address: AddressInfo;
  try {
    address = await listen(server, settings.host, settings.port);
  } catch (error) {
    return fail(`can't listen on ${settings.host}:${settings.port}: ${(error as Error).message}`);
  }
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  const tierRoute =
    `${settings.tier} → ${target.model}` + `${target.effort ? `, effort ${target.effort}` : ""}`;
  const forced = settings.envTier ? ` (SWITCHKICK_TIER=${settings.envTier})` : "";
  let route = `static, ${tierRoute}`;
  if (settings.mode === "hosted") {
    const costTier = settings.envTier ? COST_TIER_FOR[settings.envTier] : hosted.cost_tier;
    route =
      `hosted, ${JEV_ROUTER_MODEL} at cost_tier ${costTier}${forced}` +
      `${hosted.excluded_models.length > 0 ? `, excluding ${hosted.excluded_models.length} pattern(s)` : ""}` +
      `\n  fallback: static, ${tierRoute}`;
  } else if (settings.mode === "local") {
    const { session } = loaded.config.policy;
    route =
      `local, ${settings.envTier ? `every request at ${settings.envTier}${forced}` : `${jev.model} picks the tier, ${session} sessions`}` +
      `\n  tiers:  ${TIERS.map((t) => `${t} → ${tiers[t].model}`).join(", ")}; trusted → ${trusted.model}` +
      `\n  fallback: ${tierRoute}${loaded.config.policy.failClosed ? " (off: failClosed)" : ""}`;
  }
  io.stderr(
    `switchkick listening on http://${host}:${address.port}\n` +
      `  config: ${loaded.path ?? "built-in defaults"}\n` +
      `  key:    from ${found.source}\n` +
      `  route:  ${route}\n` +
      sessionsLine,
  );
  const close = async () => {
    server.close();
    server.closeIdleConnections();
    await persisted?.close();
    await flushLog();
  };
  return { exitCode: 0, server, close };
}

function jevErrorHint(failure: DecideFailure): string {
  const message = failure.kind === "http" ? failure.message : failure.kind;
  if (failure.kind === "http" && [401, 402, 403].includes(failure.status)) {
    return `${message}. Check the OpenRouter key and its credits; routing falls back to defaultTier.`;
  }
  if (failure.kind === "http" && failure.status === 404) {
    return `${message}. Check \`jev.model\` in the config; routing falls back to defaultTier.`;
  }
  return `${message}. This looks like a switchkick bug; please report it. Routing falls back to defaultTier.`;
}

function parse(argv: string[]) {
  // No defaults here: an unset flag must fall through to the config file.
  return parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      config: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      mode: { type: "string" },
      tier: { type: "string" },
      "log-file": { type: "string" },
      log: { type: "boolean" },
      attribution: { type: "boolean" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
}
