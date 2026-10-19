import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import { createAdaptorServer } from "@hono/node-server";
import { TIERS, type Tier } from "@switchkick/core";
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
  resolveTiers,
} from "./config.js";
import {
  CredentialError,
  defaultCredentialDeps,
  envFilePath,
  type FoundKey,
  findApiKey,
} from "./credentials.js";
import { JEV_ROUTER_MODEL, jevRouterPlugin } from "./hosted.js";
import { createFileLog, type DecisionLog, defaultLogPath, NO_LOG } from "./log.js";

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
                      hosted mode: ${TIERS.join(", ")} (default balanced)
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
  /** The listening server, for `serve`. Close it to stop. */
  server?: Server;
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
  const tier = flags.tier ?? config.defaultTier;
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
  if (settings.logFile !== null) {
    const path = settings.logFile;
    log = createFileLog({
      path,
      maxBytes: loaded.config.log.maxBytes,
      onError: (error) =>
        io.stderr(`switchkick: can't write the decision log at ${path}: ${error}\n`),
    });
  }

  const target = resolveTiers(loaded.config)[settings.tier];
  const { hosted } = loaded.config;
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
  const route =
    settings.mode === "hosted"
      ? `hosted, ${JEV_ROUTER_MODEL} at cost_tier ${hosted.cost_tier}` +
        `${hosted.excluded_models.length > 0 ? `, excluding ${hosted.excluded_models.length} pattern(s)` : ""}` +
        `\n  fallback: static, ${tierRoute}`
      : `static, ${tierRoute}`;
  io.stderr(
    `switchkick listening on http://${host}:${address.port}\n` +
      `  config: ${loaded.path ?? "built-in defaults"}\n` +
      `  key:    from ${found.source}\n` +
      `  route:  ${route}\n`,
  );
  return { exitCode: 0, server };
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
