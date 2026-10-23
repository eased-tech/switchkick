// Smoke-tests a built switchkick: a standalone binary, the Docker image, or the npm package.
// Starts a mock OpenRouter, runs the given command against it, and checks that /healthz answers
// with the expected version and that recorded responses come back byte for byte, including a
// stream that goes quiet for longer than common idle timeouts.
//
//   node scripts/release/smoke.mjs ./switchkick serve --config {config} --port {port}
//
// `{config}`, `{dir}` and `{port}` in the command are replaced. The command gets
// OPENROUTER_API_KEY and SWITCHKICK_TOKEN in its environment (pass them into a container with
// `-e NAME`), and its state directories point into the temporary `{dir}`.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = join(import.meta.dirname, "..", "..");
const fixtures = join(root, "packages", "proxy", "test", "fixtures");
const version = JSON.parse(readFileSync(join(root, "packages/proxy/package.json"), "utf8")).version;
const TOKEN = "smoke-token";
/** Longer than the 10 s idle timeouts some servers and fetch implementations default to. */
const QUIET_MS = 12_000;

const CASES = [
  { name: "chat-stream", path: "/chat/completions", ext: "sse", quiet: true },
  { name: "messages-stream", path: "/messages", ext: "sse" },
  { name: "responses-stream", path: "/responses", ext: "sse" },
  { name: "chat-json", path: "/chat/completions", ext: "json" },
];

const template = process.argv.slice(2);
if (template.length === 0) {
  console.error("usage: node scripts/release/smoke.mjs <command> [args...]");
  process.exit(2);
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

let current = null;
const upstream = createServer((req, res) => {
  req.resume();
  req.on("end", async () => {
    const c = current;
    if (!c) {
      res.writeHead(500).end();
      return;
    }
    res.writeHead(c.meta.status, c.meta.headers);
    // Cut at odd offsets so chunk boundaries fall mid-event and mid-character.
    const cuts = [0, 7, Math.floor(c.body.length / 2) + 3, c.body.length];
    for (let i = 0; i < cuts.length - 1; i++) {
      res.write(c.body.subarray(cuts[i], cuts[i + 1]));
      if (c.quiet && i === 1) await sleep(QUIET_MS);
    }
    res.end();
  });
});

const dir = await mkdtemp(join(tmpdir(), "switchkick-smoke-"));
// Readable by everyone, so a container running as another user can read the config. It holds
// no secrets.
await chmod(dir, 0o755);
const upstreamPort = await listen(upstream);
const port = await freePort();
const config = join(dir, "config.yaml");
await writeFile(
  config,
  `upstream: { baseUrl: "http://127.0.0.1:${upstreamPort}/api/v1" }\nlog: { enabled: false }\n`,
  { mode: 0o644 },
);

const fill = (arg) =>
  arg.replaceAll("{config}", config).replaceAll("{dir}", dir).replaceAll("{port}", String(port));
const [command, ...args] = template.map(fill);
const child = spawn(command, args, {
  env: {
    ...process.env,
    OPENROUTER_API_KEY: "sk-or-v1-smoke",
    SWITCHKICK_TOKEN: TOKEN,
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_STATE_HOME: join(dir, "state"),
  },
  stdio: ["ignore", "inherit", "inherit"],
});
let exited = null;
child.on("exit", (code, signal) => {
  exited = signal ?? code;
});

let failures = 0;
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures++;
};

try {
  const base = `http://127.0.0.1:${port}`;
  let health = null;
  for (let i = 0; i < 120 && exited === null && health === null; i++) {
    health = await fetch(`${base}/healthz`).then(
      (r) => r.json(),
      () => null,
    );
    if (health === null) await sleep(500);
  }
  check(health?.ok === true, `/healthz answers (${JSON.stringify(health ?? exited)})`);
  check(health?.version === version, `/healthz reports version ${version}`);

  for (const c of health ? CASES : []) {
    const meta = JSON.parse(readFileSync(join(fixtures, `${c.name}.meta.json`), "utf8"));
    const body = readFileSync(join(fixtures, `${c.name}.${c.ext}`));
    current = { meta, body, quiet: c.quiet };
    const started = Date.now();
    const res = await fetch(`${base}/v1${c.path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(meta.request),
    });
    const received = Buffer.from(await res.arrayBuffer());
    const quiet = c.quiet ? `, quiet for ${QUIET_MS / 1000} s` : "";
    check(
      res.status === meta.status && received.equals(body),
      `${c.name} byte for byte (${res.status}, ${received.length}/${body.length} bytes, ` +
        `${Date.now() - started} ms${quiet})`,
    );
  }
} finally {
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(5000)]);
  upstream.close();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("smoke test passed");
