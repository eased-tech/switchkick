import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialError, run } from "../src/index.js";
import { send, startUpstream, type Upstream } from "./helpers.js";

const JEV_FRONTIER = {
  model: "typesafe/jev-1.14-20261014",
  answers: {
    tier: { type: "choice", choice: "frontier", probabilities: { frontier: 0.9 } },
    sensitive: { type: "noul", noul: 0 },
    self_routing: { type: "noul", noul: 0 },
  },
  usage: { input_tokens: 100, output_tokens: 0, cost: 0.000004 },
};

let dir: string;
let upstream: Upstream;
let server: Server | undefined;
let stderr: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "switchkick-run-"));
  stderr = "";
  upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    // Stands in for Jev too, which local mode reaches at `jev.baseUrl`.
    res.end(req.url.endsWith("/decisions") ? JSON.stringify(JEV_FRONTIER) : "{}");
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

  it("routes through the Jev router in hosted mode, with the config's plugin settings", async () => {
    const { exitCode, url } = await serve(
      "mode: hosted\nhosted: { cost_tier: high, excluded_models: [openai/*] }\n",
    );
    expect(exitCode).toBe(0);
    await send(`${url}/v1/chat/completions`, { body: '{"model":"client"}' });
    const sent = JSON.parse(upstream.requests[0]?.body ?? "{}");
    expect(sent.model).toBe("typesafe/jev-router");
    expect(sent.plugins).toEqual([
      { id: "jev-router", cost_tier: "high", excluded_models: ["openai/*"] },
    ]);
    expect(stderr).toContain("hosted, typesafe/jev-router at cost_tier high");
    expect(stderr).toContain("fallback: static, balanced → anthropic/claude-sonnet-5.5");
  });

  it("asks Jev in local mode, with the config's Jev settings and attribution", async () => {
    const { exitCode, url } = await serve(
      `mode: local\njev: { baseUrl: "${upstream.baseUrl}", model: test/jev }\n` +
        "trusted: { model: test/trusted }\n",
    );
    expect(exitCode).toBe(0);
    const body = JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "hi" }] });
    await send(`${url}/v1/chat/completions`, { body });
    const [warm, decision, call] = upstream.requests;
    expect(warm).toMatchObject({ method: "HEAD", url: "/api/v1/decisions" });
    expect(warm?.headers.authorization).toBeUndefined();
    expect(decision?.url).toBe("/api/v1/decisions");
    expect(JSON.parse(decision?.body ?? "{}").model).toBe("test/jev");
    expect(decision?.headers["x-openrouter-title"]).toBe("switchkick");
    expect(JSON.parse(call?.body ?? "{}").model).toBe("anthropic/claude-opus-5.5");
    expect(stderr).toContain("local, test/jev picks the tier, ratchet sessions");
    expect(stderr).toContain("trusted → test/trusted");
  });

  it("restores local-mode sessions after a restart", async () => {
    const yaml = `mode: local\njev: { baseUrl: "${upstream.baseUrl}" }\n`;
    const human = { role: "user", content: "plan the migration" };
    const chat = (messages: unknown[]) =>
      send(`${url}/v1/chat/completions`, { body: JSON.stringify({ model: "gpt-5", messages }) });
    let { url, close } = await serve(yaml);
    await chat([human]);
    await close?.();

    ({ url, close } = await serve(yaml));
    expect(stderr).toContain(`sessions: ${join(dir, "switchkick", "sessions.json")} (1 restored)`);
    const before = upstream.requests.length;
    // A tool step after the restart inherits frontier instead of asking Jev again.
    await chat([
      human,
      { role: "assistant", tool_calls: [{ id: "c1" }] },
      { role: "tool", content: "ok" },
    ]);
    const sent = upstream.requests.slice(before).filter((r) => r.method === "POST");
    expect(sent.map((r) => r.url)).toEqual(["/api/v1/chat/completions"]);
    expect(JSON.parse(sent[0]?.body ?? "{}").model).toBe("anthropic/claude-opus-5.5");
    await close?.();
  });

  it("doesn't save sessions when persistSessions is off", async () => {
    const yaml = `mode: local\njev: { baseUrl: "${upstream.baseUrl}" }\npolicy: { persistSessions: false }\n`;
    const { url, close } = await serve(yaml);
    await send(`${url}/v1/responses`, { body: '{"input":"hi"}' });
    await close?.();
    expect(stderr).not.toContain("sessions:");
    await expect(readFile(join(dir, "switchkick", "sessions.json"))).rejects.toThrow();
  });

  it("routes every request at SWITCHKICK_TIER in local mode, without asking Jev", async () => {
    const { url } = await serve(`mode: local\njev: { baseUrl: "${upstream.baseUrl}" }\n`, [], {
      SWITCHKICK_TIER: "fast",
    });
    expect(await routedModel(url)).toBe("anthropic/claude-haiku-5.5");
    expect(upstream.requests).toHaveLength(1);
    expect(stderr).toContain("every request at fast (SWITCHKICK_TIER=fast)");
  });

  it("uses SWITCHKICK_TIER as the static tier, below --tier", async () => {
    const env = { SWITCHKICK_TIER: "frontier" };
    expect(await routedModel((await serve("", [], env)).url)).toBe("anthropic/claude-opus-5.5");
    server?.closeAllConnections();
    server?.close();
    expect(await routedModel((await serve("", ["--tier", "fast"], env)).url)).toBe(
      "anthropic/claude-haiku-5.5",
    );
  });

  it("rejects an unknown SWITCHKICK_TIER", async () => {
    const { exitCode } = await serve("", [], { SWITCHKICK_TIER: "turbo" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      'SWITCHKICK_TIER must be one of fast, balanced, frontier, got "turbo"',
    );
  });

  it("lets --mode override the config file", async () => {
    const { url } = await serve("mode: hosted\n", ["--mode", "static"]);
    expect(await routedModel(url)).toBe("anthropic/claude-sonnet-5.5");
  });

  it("rejects an unknown --mode", async () => {
    const { exitCode } = await serve("", ["--mode", "smart"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--mode must be one of static, hosted, local, got "smart"');
  });

  it("takes the mode from SWITCHKICK_MODE, below --mode", async () => {
    const env = { SWITCHKICK_MODE: "hosted" };
    expect(await routedModel((await serve("", [], env)).url)).toBe("typesafe/jev-router");
    server?.closeAllConnections();
    server?.close();
    const { url } = await serve("mode: hosted\n", ["--mode", "static"], env);
    expect(await routedModel(url)).toBe("anthropic/claude-sonnet-5.5");
  });

  it("rejects an unknown SWITCHKICK_MODE or SWITCHKICK_PORT", async () => {
    expect((await serve("", [], { SWITCHKICK_MODE: "smart" })).exitCode).toBe(1);
    expect(stderr).toContain('SWITCHKICK_MODE must be one of static, hosted, local, got "smart"');
    // `serve` passes --port, so this run leaves it out for the environment to apply.
    const result = await run(["serve", "--config", join(dir, "config.yaml")], {
      env: { SWITCHKICK_PORT: "80a" },
      findApiKey: async () => ({ key: "sk-test", source: "test" }),
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
    });
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain('SWITCHKICK_PORT must be an integer from 0 to 65535, got "80a"');
  });

  it("refuses SWITCHKICK_HOST=0.0.0.0 without a token, and listens with one", async () => {
    expect((await serve("", [], { SWITCHKICK_HOST: "0.0.0.0" })).exitCode).toBe(1);
    expect(stderr).toContain("refusing to listen on 0.0.0.0 without SWITCHKICK_TOKEN");
    const listening = await serve("", [], { SWITCHKICK_HOST: "0.0.0.0", SWITCHKICK_TOKEN: "t" });
    expect(listening.exitCode).toBe(0);
    expect((listening.server as Server).address()).toMatchObject({ address: "0.0.0.0" });
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
