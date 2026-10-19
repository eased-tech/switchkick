import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { estimateInputTokens } from "../src/index.js";
import {
  memoryLog,
  type ProxyServer,
  send,
  startProxy,
  startUpstream,
  type Upstream,
} from "./helpers.js";

const MODEL = "anthropic/claude-sonnet-5.5";
const ANTHROPIC = { "anthropic-version": "2023-06-01" };

let upstream: Upstream | undefined;
let proxy: ProxyServer | undefined;
const log = memoryLog();

afterEach(async () => {
  await proxy?.close();
  await upstream?.close();
  proxy = upstream = undefined;
  log.entries.length = 0;
});

async function setup(token: string | null = null) {
  upstream = await startUpstream((_req, res) => {
    res.end("{}");
  });
  proxy = await startProxy({
    apiKey: "sk-test",
    route: { tier: "balanced", model: MODEL },
    upstreamBaseUrl: upstream.baseUrl,
    token,
    log,
  });
  return { upstream, proxy };
}

describe("GET /v1/models", () => {
  it("lists the routed model in OpenAI's shape", async () => {
    const { proxy } = await setup();
    const res = await send(`${proxy.url}/v1/models`, { method: "GET", headers: {} });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({
      object: "list",
      data: [{ id: MODEL, object: "model", created: 0, owned_by: "anthropic" }],
    });
  });

  it("lists it in Anthropic's shape for Anthropic clients", async () => {
    const { proxy } = await setup();
    const res = await send(`${proxy.url}/v1/models`, { method: "GET", headers: ANTHROPIC });
    expect(res.json()).toEqual({
      data: [{ type: "model", id: MODEL, display_name: MODEL, created_at: "1970-01-01T00:00:00Z" }],
      has_more: false,
      first_id: MODEL,
      last_id: MODEL,
    });
  });

  it("retrieves a model whose id contains a slash", async () => {
    const { proxy } = await setup();
    const res = await send(`${proxy.url}/v1/models/${MODEL}`, { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ id: MODEL, object: "model" });
  });

  it("returns 404 for a model it doesn't serve", async () => {
    const { proxy } = await setup();
    const res = await send(`${proxy.url}/v1/models/openai/gpt-5`, {
      method: "GET",
      headers: ANTHROPIC,
    });
    expect(res.status).toBe(404);
    expect(res.json()).toMatchObject({ type: "error", error: { type: "not_found_error" } });
  });

  it("applies the Host check and the token", async () => {
    const { proxy } = await setup();
    const res = await send(`${proxy.url}/v1/models`, {
      method: "GET",
      headers: { host: "attacker.example" },
    });
    expect(res.status).toBe(403);
    await proxy.close();
    await upstream?.close();
    const guarded = await setup("tok");
    expect((await send(`${guarded.proxy.url}/v1/models`, { method: "GET" })).status).toBe(401);
    const ok = await send(`${guarded.proxy.url}/v1/models`, {
      method: "GET",
      headers: { authorization: "Bearer tok" },
    });
    expect(ok.status).toBe(200);
  });

  it("calls neither OpenRouter nor the decision log", async () => {
    const { upstream, proxy } = await setup();
    await send(`${proxy.url}/v1/models`, { method: "GET" });
    expect(upstream.requests).toHaveLength(0);
    expect(log.entries).toHaveLength(0);
  });
});

describe("POST /v1/messages/count_tokens", () => {
  it("answers locally with an estimate and never calls OpenRouter", async () => {
    const { upstream, proxy } = await setup();
    const meta = JSON.parse(
      readFileSync(new URL("./fixtures/messages-json.meta.json", import.meta.url), "utf8"),
    );
    const res = await send(`${proxy.url}/v1/messages/count_tokens`, {
      headers: ANTHROPIC,
      body: JSON.stringify(meta.request),
    });
    expect(res.status).toBe(200);
    expect(res.headers["x-switchkick-token-estimate"]).toBe("true");
    // OpenRouter reported 12 input tokens for this exact request.
    expect((res.json() as { input_tokens: number }).input_tokens).toBeGreaterThanOrEqual(12);
    expect(upstream.requests).toHaveLength(0);
    expect(log.entries).toHaveLength(0);
  });

  it("rejects invalid JSON in the Anthropic envelope", async () => {
    const { proxy } = await setup();
    const res = await send(`${proxy.url}/v1/messages/count_tokens`, { body: "{nope" });
    expect(res.status).toBe(400);
    expect(res.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
  });
});

describe("estimateInputTokens", () => {
  const text = (content: string) => ({ messages: [{ role: "user", content }] });

  it("grows with the text and counts multi-byte characters by their UTF-8 size", () => {
    const ascii = estimateInputTokens(text("a".repeat(300)));
    const cjk = estimateInputTokens(text("語".repeat(300)));
    expect(ascii).toBeGreaterThanOrEqual(100);
    expect(cjk).toBeGreaterThanOrEqual(300);
  });

  it("counts an image at a fixed cost however it is encoded", () => {
    const image = (data: string) => ({
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
        },
      ],
    });
    expect(estimateInputTokens(image("x".repeat(2_000_000)))).toBe(estimateInputTokens(image("x")));
    expect(estimateInputTokens(image("x"))).toBeGreaterThanOrEqual(1600);
  });

  it("adds the hidden tool-use prompt when tools are present", () => {
    const base = text("hi");
    const withTools = { ...base, tools: [{ name: "t", input_schema: { type: "object" } }] };
    expect(estimateInputTokens(withTools) - estimateInputTokens(base)).toBeGreaterThan(400);
  });

  it("includes the system prompt", () => {
    expect(estimateInputTokens({ system: "s".repeat(3000), messages: [] })).toBeGreaterThanOrEqual(
      1000,
    );
  });
});
