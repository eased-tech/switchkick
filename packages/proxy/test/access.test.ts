import { afterEach, describe, expect, it } from "vitest";
import { type AppOptions, hostnameOf, isLoopback } from "../src/index.js";
import { type ProxyServer, send, startProxy, startUpstream, type Upstream } from "./helpers.js";

const ROUTE = { tier: "balanced", model: "test/routed-model" } as const;

let upstream: Upstream | undefined;
let proxy: ProxyServer | undefined;

afterEach(async () => {
  await proxy?.close();
  await upstream?.close();
  proxy = upstream = undefined;
});

async function setup(options: Partial<AppOptions> = {}) {
  upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  proxy = await startProxy({
    apiKey: "sk-server",
    route: ROUTE,
    upstreamBaseUrl: upstream.baseUrl,
    ...options,
  });
  return { upstream, proxy };
}

describe("without a token", () => {
  it("accepts loopback Host headers", async () => {
    const { proxy } = await setup();
    for (const host of ["localhost:8787", "127.0.0.1", "[::1]:8787"]) {
      const res = await send(`${proxy.url}/v1/chat/completions`, { body: "{}", headers: { host } });
      expect(res.status, host).toBe(200);
    }
  });

  it("rejects other Host headers, to block DNS rebinding", async () => {
    const { upstream, proxy } = await setup();
    const res = await send(`${proxy.url}/v1/messages`, {
      body: "{}",
      headers: { host: "attacker.example:8787" },
    });
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({ type: "error", error: { type: "permission_error" } });
    expect(upstream.requests).toHaveLength(0);
  });

  it("requires a JSON content type", async () => {
    const { upstream, proxy } = await setup();
    const res = await send(`${proxy.url}/v1/chat/completions`, {
      body: "{}",
      headers: { "content-type": "text/plain" },
    });
    expect(res.status).toBe(415);
    expect(upstream.requests).toHaveLength(0);
  });

  it("accepts a JSON content type with parameters", async () => {
    const { proxy } = await setup();
    const res = await send(`${proxy.url}/v1/chat/completions`, {
      body: "{}",
      headers: { "content-type": "Application/JSON; charset=utf-8" },
    });
    expect(res.status).toBe(200);
  });
});

describe("with a token", () => {
  it("accepts the token as a Bearer token or x-api-key", async () => {
    const { proxy } = await setup({ token: "tok" });
    for (const headers of [{ authorization: "Bearer tok" }, { "x-api-key": "tok" }]) {
      const res = await send(`${proxy.url}/v1/messages`, { body: "{}", headers });
      expect(res.status).toBe(200);
    }
  });

  it("rejects a missing or wrong token", async () => {
    const { upstream, proxy } = await setup({ token: "tok" });
    // Includes a longer token and a shorter one that share the real token's prefix.
    for (const headers of [
      {},
      { authorization: "Bearer nope" },
      { "x-api-key": "tokk" },
      { "x-api-key": "to" },
      { authorization: "Bearer " },
    ]) {
      const res = await send(`${proxy.url}/v1/chat/completions`, { body: "{}", headers });
      expect(res.status).toBe(401);
      expect(res.json()).toMatchObject({ error: { type: "authentication_error" } });
    }
    expect(upstream.requests).toHaveLength(0);
  });

  it("accepts any Host header, so LAN clients work", async () => {
    const { proxy } = await setup({ token: "tok" });
    const res = await send(`${proxy.url}/v1/chat/completions`, {
      body: "{}",
      headers: { host: "my-box.lan:8787", authorization: "Bearer tok" },
    });
    expect(res.status).toBe(200);
  });
});

describe("hostnameOf", () => {
  it.each([
    ["localhost:8787", "localhost"],
    ["LOCALHOST", "localhost"],
    ["127.0.0.1:1", "127.0.0.1"],
    ["[::1]:8787", "::1"],
    ["[::1]", "::1"],
    ["", ""],
  ])("%s → %s", (header, expected) => {
    expect(hostnameOf(header)).toBe(expected);
  });
});

describe("isLoopback", () => {
  it.each([
    ["127.0.0.1", true],
    ["127.1.2.3", true],
    ["localhost", true],
    ["::1", true],
    ["[::1]", true],
    ["0.0.0.0", false],
    ["::", false],
    ["192.168.1.10", false],
  ])("%s → %s", (host, expected) => {
    expect(isLoopback(host)).toBe(expected);
  });
});
