#!/usr/bin/env node
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { TIERS, type Tier } from "@switchkick/core";
import { isLoopback, LOOPBACK_HOSTS } from "./access.js";
import { createApp, VERSION } from "./app.js";
import { createFileLog, type DecisionLog, defaultLogPath, NO_LOG } from "./log.js";
import { DEFAULT_TIER_MODELS } from "./tiers.js";

const HELP = `switchkick ${VERSION}

Usage:
  switchkick serve [options]
  switchkick --version
  switchkick --help

Serve options:
  --host <addr>       Address to listen on (default 127.0.0.1)
  --port <n>          Port to listen on (default 8787)
  --tier <tier>       Tier every request is routed to: ${TIERS.join(", ")} (default balanced)
  --log-file <path>   Decision log (default ${defaultLogPath()})
  --no-log            Don't write a decision log
  --no-attribution    Don't identify requests as coming from switchkick (see below)

Environment:
  OPENROUTER_API_KEY  Required. Used for every upstream call.
  SWITCHKICK_TOKEN    Clients must send this as their API key. Required when --host is not a
                      loopback address.
  SWITCHKICK_ATTRIBUTION=off
                      Same as --no-attribution.

By default, requests carry OpenRouter app-attribution headers naming switchkick, so its usage
appears (summed across all users) in OpenRouter's public app rankings. Nothing identifying you
is sent.
`;

function fail(message: string): number {
  process.stderr.write(`switchkick: ${message}\n`);
  return 1;
}

function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8787" },
      tier: { type: "string", default: "balanced" },
      "log-file": { type: "string" },
      log: { type: "boolean", default: true },
      attribution: { type: "boolean", default: true },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const [command] = positionals;
  if (values.help || command === undefined) {
    process.stdout.write(HELP);
    return 0;
  }
  if (command !== "serve") {
    process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
    return 1;
  }

  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return fail(`--port must be an integer from 0 to 65535, got "${values.port}".`);
  }
  if (!isTier(values.tier)) {
    return fail(`--tier must be one of ${TIERS.join(", ")}, got "${values.tier}".`);
  }
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return fail("OPENROUTER_API_KEY is not set.");
  const token = process.env.SWITCHKICK_TOKEN?.trim() || null;
  if (token === null && !isLoopback(values.host)) {
    return fail(
      `refusing to listen on ${values.host} without SWITCHKICK_TOKEN: anyone who can reach ` +
        "it could spend your OpenRouter credits.",
    );
  }

  let log: DecisionLog = NO_LOG;
  if (values.log) {
    const path = values["log-file"] ?? defaultLogPath();
    log = createFileLog({
      path,
      onError: (error) => {
        process.stderr.write(`switchkick: can't write the decision log at ${path}: ${error}\n`);
      },
    });
  }

  const attributionEnv = process.env.SWITCHKICK_ATTRIBUTION?.trim().toLowerCase();
  const attribution =
    values.attribution && !["off", "false", "0", "no"].includes(attributionEnv ?? "");

  const app = createApp({
    apiKey,
    route: { tier: values.tier, model: DEFAULT_TIER_MODELS[values.tier] },
    token,
    allowedHosts: new Set([...LOOPBACK_HOSTS, values.host.replace(/^\[|\]$/g, "").toLowerCase()]),
    log,
    attribution,
  });
  serve({ fetch: app.fetch, hostname: values.host, port }, (info) => {
    process.stderr.write(
      `switchkick listening on http://${info.address}:${info.port} ` +
        `(static, ${values.tier}: ${DEFAULT_TIER_MODELS[values.tier as Tier]})\n`,
    );
  });
  return 0;
}

process.exitCode = main(process.argv.slice(2));
