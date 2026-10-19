import { DEFAULT_POLICY } from "@switchkick/core";
import { createJevClient } from "@switchkick/jev";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventually, memoryLog, type ProxyServer, send, startProxy } from "./helpers.js";

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

describe.skipIf(!apiKey)("live OpenRouter, hosted mode", () => {
  const log = memoryLog();
  let proxy: ProxyServer;

  beforeAll(async () => {
    proxy = await startProxy({
      apiKey: apiKey ?? "",
      route: { tier: "fast", model: "anthropic/claude-haiku-5.5" },
      hosted: {
        plugin: { id: "jev-router", cost_tier: "low", models: ["anthropic/*"] },
      },
      log,
    });
  });

  afterAll(() => proxy.close());

  const resolvedModels = () => {
    const entry = log.entries.at(-1);
    expect(entry).toMatchObject({ mode: "hosted", status: 200 });
    expect(entry?.servedModel).toMatch(/^anthropic\//);
    return entry?.router?.resolvedModels;
  };

  it("logs the router's resolved models for a Chat Completions stream", {
    timeout: 30_000,
  }, async () => {
    const res = await send(`${proxy.url}/v1/chat/completions`, {
      body: JSON.stringify({
        stream: true,
        max_tokens: 256,
        messages: [{ role: "user", content: PROMPT }],
      }),
    });
    expect(res.status).toBe(200);
    await eventually(() => expect(log.entries).toHaveLength(1));
    expect(resolvedModels()?.[0]).toMatch(/^anthropic\//);
  });

  it("logs them for Messages with a thinking budget, as Claude Code sends", {
    timeout: 30_000,
  }, async () => {
    const res = await send(`${proxy.url}/v1/messages`, {
      headers: { "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        max_tokens: 2048,
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [{ role: "user", content: PROMPT }],
      }),
    });
    expect(res.status).toBe(200);
    await eventually(() => expect(log.entries).toHaveLength(2));
    expect(resolvedModels()?.[0]).toMatch(/^anthropic\//);
  });

  it("logs them for a Responses stream, from response.completed", {
    timeout: 30_000,
  }, async () => {
    const res = await send(`${proxy.url}/v1/responses`, {
      body: JSON.stringify({
        stream: true,
        max_output_tokens: 256,
        reasoning: { effort: "low", max_tokens: 128 },
        input: [{ type: "message", role: "user", content: PROMPT }],
      }),
    });
    expect(res.status).toBe(200);
    await eventually(() => expect(log.entries).toHaveLength(3));
    expect(resolvedModels()?.[0]).toMatch(/^anthropic\//);
    expect(log.entries.at(-1)?.warnings).toEqual(["reasoning_max_tokens_stripped"]);
  });
});

describe.skipIf(!apiKey)("live OpenRouter, local mode", () => {
  const log = memoryLog();
  let proxy: ProxyServer;
  const haiku = { model: "anthropic/claude-haiku-5.5" };

  beforeAll(async () => {
    proxy = await startProxy({
      apiKey: apiKey ?? "",
      route: { tier: "balanced", ...haiku },
      // Every tier on Haiku keeps the test cheap; the log still shows Jev's choice.
      local: {
        jev: createJevClient({ apiKey: apiKey ?? "" }),
        policy: DEFAULT_POLICY,
        tiers: { fast: haiku, balanced: haiku, frontier: haiku },
        trusted: haiku,
      },
      log,
    });
  });

  afterAll(() => proxy.close());

  it("asks Jev once per human turn and logs its answer", { timeout: 30_000 }, async () => {
    const messages: unknown[] = [{ role: "user", content: PROMPT }];
    const res = await send(`${proxy.url}/v1/chat/completions`, {
      body: JSON.stringify({ model: "gpt-5", max_tokens: 256, messages }),
    });
    expect(res.status).toBe(200);
    await eventually(() => expect(log.entries).toHaveLength(1));
    const entry = log.entries[0];
    expect(entry).toMatchObject({
      mode: "local",
      reason: expect.stringMatching(/^(jev|fail_open)$/),
    });
    // A timeout is possible on a slow network; anything else means the wire format drifted.
    if (entry?.reason === "jev") {
      expect(entry.jev).toMatchObject({ model: expect.stringMatching(/^typesafe\/jev-1\.14/) });
    } else {
      expect(entry?.jev).toMatchObject({ error: "timeout" });
    }
  });
});
