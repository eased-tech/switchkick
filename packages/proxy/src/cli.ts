#!/usr/bin/env node
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { createApp, VERSION } from "./app.js";

const HELP = `switchkick ${VERSION}

Usage:
  switchkick serve [--host 127.0.0.1] [--port 8787]
  switchkick --version
  switchkick --help
`;

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8787" },
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
  if (command === "serve") {
    const port = Number(values.port);
    serve({ fetch: createApp().fetch, hostname: values.host, port }, (info) => {
      process.stderr.write(`switchkick listening on http://${info.address}:${info.port}\n`);
    });
    return 0;
  }
  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
