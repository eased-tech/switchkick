import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialError, run } from "../src/index.js";
import { send, startUpstream, type Upstream } from "./helpers.js";

let dir: string;
let upstream: Upstream;
let server: Server | undefined;
let stderr: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "switchkick-run-"));
  stderr = "";
  upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
  }
  server = undefined;
  await upstream.close();
  await rm(dir, { recursive: true, force: true });
});

/** Runs the CLI in-process with a config file that points upstream at the mock. */
async function serve(yaml: string, argv: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const config = join(dir, "config.yaml");
  await writeFile(config, `upstream: { baseUrl: "${upstream.baseUrl}" }\n${yaml}`);
  const result = await run(["serve", "--config", config, "--port", "0", ...argv], {
    env: { OPENROUTER_API_KEY: "sk-test", XDG_STATE_HOME: dir, ...env },
    // Stands in for the real lookup so a test can never reach the user's Keychain.
    findApiKey: async (env) => {
      if (env.OPENROUTER_API_KEY) return { key: env.OPENROUTER_API_KEY, source: "test" };
      throw new CredentialError("No OpenRouter API key found.");
    },
    stdout: () => {},
    stderr: (text) => {
      stderr += text;
    },
  });
  server = result.server;
  const port = server ? (server.address() as AddressInfo).port : 0;
  return { ...result, url: `http://127.0.0.1:${port}` };
}

async function routedModel(url: string): Promise<string> {
  await send(`${url}/v1/chat/completions`, { body: '{"model":"client"}' });
  return JSON.parse(upstream.requests.at(-1)?.body ?? "{}").model;
}

describe("switchkick serve", () => {
  it("routes with the config file's tier and models", async () => {
    const { exitCode, url } = await serve(
      "defaultTier: frontier\ntiers:\n  frontier: { model: test/frontier }\n",
    );
    expect(exitCode).toBe(0);
    expect(await routedModel(url)).toBe("test/frontier");
    expect(stderr).toContain("static, frontier → test/frontier");
  });

  it("lets flags override the config file", async () => {
    const { url } = await serve("defaultTier: frontier\n", ["--tier", "fast"]);
    expect(await routedModel(url)).toBe("anthropic/claude-haiku-5.5");
  });

  it("refuses a non-loopback host from the config file without a token", async () => {
    const { exitCode, server } = await serve("server: { host: 0.0.0.0 }\n");
    expect(exitCode).toBe(1);
    expect(server).toBeUndefined();
    expect(stderr).toContain("refusing to listen on 0.0.0.0 without SWITCHKICK_TOKEN");
  });

  it("reports an invalid config file and exits", async () => {
    const { exitCode } = await serve("tiers: { fast: { model: x, efort: high } }\n");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("tiers.fast.efort: unrecognized key");
  });

  it.each([
    ["the config file", "attribution: false\n", [], {}],
    ["--no-attribution", "", ["--no-attribution"], {}],
    ["SWITCHKICK_ATTRIBUTION=off", "", [], { SWITCHKICK_ATTRIBUTION: "off" }],
  ])("turns attribution off from %s", async (_name, yaml, argv, env) => {
    const { url } = await serve(yaml, argv, env);
    await send(`${url}/v1/chat/completions`, { body: "{}" });
    expect(upstream.requests[0]?.headers["http-referer"]).toBeUndefined();
  });

  it("lets --attribution win over SWITCHKICK_ATTRIBUTION=off", async () => {
    const { url } = await serve("", ["--attribution"], { SWITCHKICK_ATTRIBUTION: "off" });
    await send(`${url}/v1/chat/completions`, { body: "{}" });
    expect(upstream.requests[0]?.headers["http-referer"]).toBeDefined();
  });

  it("writes the decision log where the config file says", async () => {
    const file = join(dir, "custom.jsonl");
    const { url } = await serve(`log: { file: "${file}" }\n`);
    await send(`${url}/v1/chat/completions`, { body: "{}" });
    await expect.poll(() => readFile(file, "utf8").catch(() => "")).toContain('"status":200');
  });

  it("exits when no API key is found", async () => {
    const { exitCode } = await serve("", [], { OPENROUTER_API_KEY: "" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No OpenRouter API key found.");
  });

  it("reports where the key came from, but never the key", async () => {
    await serve("", [], { OPENROUTER_API_KEY: "sk-secret-value" });
    expect(stderr).toContain("key:    from test");
    expect(stderr).not.toContain("sk-secret-value");
  });
});
