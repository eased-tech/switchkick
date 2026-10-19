import { afterEach, describe, expect, it } from "vitest";
import { type AppOptions, ATTRIBUTION } from "../src/index.js";
import {
  eventually,
  memoryLog,
  type ProxyServer,
  send,
  startProxy,
  startUpstream,
  type Upstream,
  type UpstreamHandler,
} from "./helpers.js";

const ROUTE = { tier: "balanced", model: "test/routed-model" } as const;
const PROMPT = "a secret prompt that must never be logged";

let upstream: Upstream | undefined;
let proxy: ProxyServer | undefined;

afterEach(async () => {
  await proxy?.close();
  await upstream?.close();
  proxy = upstream = undefined;
});

const ok: UpstreamHandler = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json", "x-generation-id": "gen-abc" });
  res.end("{}");
};

async function setup(handler: UpstreamHandler = ok, options: Partial<AppOptions> = {}) {
  upstream = await startUpstream(handler);
  proxy = await startProxy({
    apiKey: "sk-server",
    route: ROUTE,
    upstreamBaseUrl: upstream.baseUrl,
    ...options,
  });
  return { upstream, proxy };
}

function sentBody(upstream: Upstream): Record<string, unknown> {
  return JSON.parse(upstream.requests[0]?.body ?? "null");
}

describe("upstream request", () => {
  it("replaces client credentials and forwards only known headers", async () => {
    const { upstream, proxy } = await setup();
    await send(`${proxy.url}/v1/messages`, {
      body: "{}",
      headers: {
        authorization: "Bearer client-key",
        "x-api-key": "client-key",
        cookie: "session=1",
        "accept-encoding": "x-client-encoding",
        "x-custom": "1",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "beta-a, beta-b",
        "x-anthropic-beta": "beta-b,beta-c",
      },
    });

    const headers = upstream.requests[0]?.headers ?? {};
    expect(headers.authorization).toBe("Bearer sk-server");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers["x-custom"]).toBeUndefined();
    expect(headers["accept-encoding"]).not.toContain("x-client-encoding");
    expect(headers.host).toBe(new URL(upstream.baseUrl).host);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-beta"]).toBe("beta-a, beta-b");
    expect(headers["x-anthropic-beta"]).toBe("beta-a,beta-b,beta-c");
    expect(headers["http-referer"]).toBe(ATTRIBUTION["HTTP-Referer"]);
    expect(headers["x-openrouter-title"]).toBe(ATTRIBUTION["X-OpenRouter-Title"]);
  });

  it("omits attribution headers when attribution is off", async () => {
    const { upstream, proxy } = await setup(ok, { attribution: false });
    await send(`${proxy.url}/v1/chat/completions`, { body: "{}" });
    const headers = upstream.requests[0]?.headers ?? {};
    expect(headers["http-referer"]).toBeUndefined();
    expect(headers["x-openrouter-title"]).toBeUndefined();
  });

  it("attributes to the project's permanent URL", () => {
    // OpenRouter keys the app page on this URL. Changing it starts a new page with no history.
    expect(ATTRIBUTION).toEqual({
      "HTTP-Referer": "https://github.com/eased-tech/switchkick",
      "X-OpenRouter-Title": "switchkick",
    });
  });

  it("rewrites the model and leaves the rest of the body alone", async () => {
    const { upstream, proxy } = await setup();
    const body = { model: "gpt-5", stream: false, temperature: 0.2, messages: [{ role: "user" }] };
    await send(`${proxy.url}/v1/chat/completions`, { body: JSON.stringify(body) });
    expect(sentBody(upstream)).toEqual({ ...body, model: ROUTE.model });
  });

  it("forwards the query string", async () => {
    const { upstream, proxy } = await setup();
    await send(`${proxy.url}/v1/messages?beta=true`, { body: "{}" });
    expect(upstream.requests[0]?.url).toBe("/api/v1/messages?beta=true");
  });
});

describe("upstream response", () => {
  it("passes errors through with their status, body and retry headers", async () => {
    const body = '{"error":{"code":429,"message":"slow down"}}';
    const { proxy } = await setup((_req, res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "3" });
      res.end(body);
    });
    const res = await send(`${proxy.url}/v1/chat/completions`, { body: "{}" });
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("3");
    expect(res.body.toString()).toBe(body);
  });

  it("drops upstream cookies", async () => {
    const { proxy } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "cf=1" });
      res.end("{}");
    });
    const res = await send(`${proxy.url}/v1/chat/completions`, { body: "{}" });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});

describe("Responses API", () => {
  it("rejects previous_response_id without calling upstream", async () => {
    const { upstream, proxy } = await setup();
    const res = await send(`${proxy.url}/v1/responses`, {
      body: JSON.stringify({ previous_response_id: "resp_1", input: "hi" }),
    });
    expect(res.status).toBe(400);
    expect(res.json()).toMatchObject({
      error: { type: "invalid_request_error", param: "previous_response_id" },
    });
    expect(upstream.requests).toHaveLength(0);
  });

  it("passes a null previous_response_id through", async () => {
    const { upstream, proxy } = await setup();
    const res = await send(`${proxy.url}/v1/responses`, {
      body: JSON.stringify({ previous_response_id: null }),
    });
    expect(res.status).toBe(200);
    expect(sentBody(upstream)).toEqual({ previous_response_id: null, model: ROUTE.model });
  });

  it("rewrites store: true to false and records a warning", async () => {
    const log = memoryLog();
    const { upstream, proxy } = await setup(ok, { log });
    await send(`${proxy.url}/v1/responses`, { body: JSON.stringify({ store: true }) });
    expect(sentBody(upstream).store).toBe(false);
    expect(log.entries[0]?.warnings).toEqual(["store_rewritten"]);
  });

  it("leaves store alone when it isn't true", async () => {
    const { upstream, proxy } = await setup();
    await send(`${proxy.url}/v1/responses`, { body: JSON.stringify({ input: "hi" }) });
    expect(sentBody(upstream)).not.toHaveProperty("store");
  });
});

describe("switchkick errors", () => {
  it("rejects invalid JSON in the Anthropic envelope on /v1/messages", async () => {
    const { proxy } = await setup();
    const res = await send(`${proxy.url}/v1/messages`, { body: "{nope" });
    expect(res.status).toBe(400);
    expect(res.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
  });

  it("rejects a body that isn't a JSON object", async () => {
    const { proxy } = await setup();
    const res = await send(`${proxy.url}/v1/chat/completions`, { body: "[]" });
    expect(res.status).toBe(400);
    expect(res.json()).toMatchObject({ error: { type: "invalid_request_error" } });
  });

  it("rejects a body over the size limit", async () => {
    const { upstream, proxy } = await setup(ok, { maxBodyBytes: 100 });
    const res = await send(`${proxy.url}/v1/messages`, {
      body: JSON.stringify({ text: "x".repeat(200) }),
    });
    expect(res.status).toBe(413);
    expect(res.json()).toMatchObject({ type: "error", error: { type: "request_too_large" } });
    expect(upstream.requests).toHaveLength(0);
  });

  it("returns 502 when OpenRouter can't be reached", async () => {
    const dead = await startUpstream(ok);
    const baseUrl = dead.baseUrl;
    await dead.close();
    proxy = await startProxy({ apiKey: "sk-server", route: ROUTE, upstreamBaseUrl: baseUrl });
    const res = await send(`${proxy.url}/v1/chat/completions`, { body: "{}" });
    expect(res.status).toBe(502);
    expect(res.json()).toMatchObject({ error: { type: "server_error" } });
  });
});

describe("decision log", () => {
  it("records the routing decision and response metadata", async () => {
    const log = memoryLog();
    const { proxy } = await setup(ok, { log });
    await send(`${proxy.url}/v1/chat/completions`, {
      body: JSON.stringify({ model: "gpt-5", stream: true, messages: [{ content: PROMPT }] }),
    });
    expect(log.entries).toEqual([
      {
        ts: expect.any(String),
        format: "chat",
        stream: true,
        mode: "static",
        tier: "balanced",
        requestedModel: "gpt-5",
        model: ROUTE.model,
        effort: null,
        reason: "static",
        status: 200,
        generationId: "gen-abc",
        upstreamMs: expect.any(Number),
      },
    ]);
  });

  it("never records prompt text", async () => {
    const log = memoryLog();
    const { proxy } = await setup(ok, { log });
    for (const path of ["/v1/chat/completions", "/v1/responses", "/v1/messages"]) {
      await send(`${proxy.url}${path}`, {
        body: JSON.stringify({ messages: [{ content: PROMPT }], input: PROMPT, system: PROMPT }),
      });
    }
    await send(`${proxy.url}/v1/responses`, {
      body: JSON.stringify({ input: PROMPT, previous_response_id: "resp_1" }),
    });
    await eventually(() => expect(log.entries).toHaveLength(4));
    expect(JSON.stringify(log.entries)).not.toContain("secret prompt");
  });

  it("records switchkick's own errors", async () => {
    const log = memoryLog();
    const { proxy } = await setup(ok, { log });
    await send(`${proxy.url}/v1/messages`, { body: "{nope" });
    expect(log.entries[0]).toMatchObject({ status: 400, error: "invalid_request" });
  });
});
