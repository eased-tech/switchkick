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
      // Haiku 5.5 accepts every effort level switchkick allows.
      route: { tier: "fast", model: "anthropic/claude-haiku-5.5", effort: "low" },
      log,
    });
  });

  afterAll(() => proxy.close());

  it("streams Chat Completions", { timeout: 30_000 }, async () => {
    const res = await send(`${proxy.url}/v1/chat/completions`, {
      body: JSON.stringify({
        model: "ignored-by-static-mode",
        stream: true,
        max_tokens: 2048,
        reasoning: { max_tokens: 1024 },
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
        max_tokens: 2048,
        messages: [{ role: "user", content: PROMPT }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ type: "message", model: "anthropic/claude-haiku-5.5" });
  });

  it("streams Responses", { timeout: 30_000 }, async () => {
    const res = await send(`${proxy.url}/v1/responses`, {
      body: JSON.stringify({
        stream: true,
        store: true,
        max_output_tokens: 2048,
        input: [{ type: "message", role: "user", content: PROMPT }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toContain('"type":"response.completed"');
  });

  it("estimates at least as many input tokens as OpenRouter bills", {
    timeout: 30_000,
  }, async () => {
    // Mixed prose and code, like a coding agent's context.
    const content = `${"Refactor this function so it handles empty input. ".repeat(20)}
function parse(input) {
  return input.split(",").map((part) => part.trim()).filter(Boolean);
}
${"const value = compute(items[index], options?.flag ?? false);\n".repeat(30)}`;
    const body = { max_tokens: 2048, messages: [{ role: "user", content }] };
    const estimate = await send(`${proxy.url}/v1/messages/count_tokens`, {
      body: JSON.stringify(body),
    });
    const real = await send(`${proxy.url}/v1/messages`, { body: JSON.stringify(body) });
    const estimated = (estimate.json() as { input_tokens: number }).input_tokens;
    const billed = (real.json() as { usage: { input_tokens: number } }).usage.input_tokens;
    expect(estimated).toBeGreaterThanOrEqual(billed);
    expect(estimated).toBeLessThan(billed * 2);
  });

  it("logs a generation id for each call", () => {
    expect(log.entries).toHaveLength(4);
    for (const entry of log.entries) expect(entry.generationId).toMatch(/^gen-/);
  });
});
