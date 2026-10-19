import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryLog, type ProxyServer, send, startProxy } from "./helpers.js";

// Calls the real OpenRouter API through the proxy. Skipped unless OPENROUTER_API_KEY is set; each
// run costs a fraction of a cent.
const apiKey = process.env.OPENROUTER_API_KEY;
const PROMPT = "Reply with exactly: ok";

describe.skipIf(!apiKey)("live OpenRouter", () => {
  const log = memoryLog();
  let proxy: ProxyServer;

  beforeAll(async () => {
    proxy = await startProxy({
      apiKey: apiKey ?? "",
      route: { tier: "fast", model: "anthropic/claude-haiku-4.5" },
      log,
    });
  });

  afterAll(() => proxy.close());

  it("streams Chat Completions", { timeout: 30_000 }, async () => {
    const res = await send(`${proxy.url}/v1/chat/completions`, {
      body: JSON.stringify({
        model: "ignored-by-static-mode",
        stream: true,
        max_tokens: 16,
        messages: [{ role: "user", content: PROMPT }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body.toString("utf8").trimEnd()).toMatch(/data: \[DONE\]$/);
  });

  it("returns Anthropic Messages JSON", { timeout: 30_000 }, async () => {
    const res = await send(`${proxy.url}/v1/messages`, {
      headers: { "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-ignored",
        max_tokens: 16,
        messages: [{ role: "user", content: PROMPT }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ type: "message", model: "anthropic/claude-haiku-4.5" });
  });

  it("streams Responses", { timeout: 30_000 }, async () => {
    const res = await send(`${proxy.url}/v1/responses`, {
      body: JSON.stringify({
        stream: true,
        store: true,
        max_output_tokens: 16,
        input: [{ type: "message", role: "user", content: PROMPT }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toContain('"type":"response.completed"');
  });

  it("logs a generation id for each call", () => {
    expect(log.entries).toHaveLength(3);
    for (const entry of log.entries) expect(entry.generationId).toMatch(/^gen-/);
  });
});
