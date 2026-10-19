import { afterEach, describe, expect, it } from "vitest";
import { applyEffort } from "../src/effort.js";
import { type ProxyServer, send, startProxy, startUpstream, type Upstream } from "./helpers.js";

describe("applyEffort", () => {
  it("sets reasoning.effort on Chat Completions and drops conflicting fields", () => {
    const body: Record<string, unknown> = {
      reasoning_effort: "minimal",
      reasoning: { max_tokens: 4000, exclude: true },
    };
    applyEffort("chat", body, "high");
    expect(body).toEqual({ reasoning: { effort: "high", exclude: true } });
  });

  it("sets reasoning.effort on Responses and keeps the summary setting", () => {
    const body: Record<string, unknown> = { reasoning: { effort: "low", summary: "auto" } };
    applyEffort("responses", body, "xhigh");
    expect(body).toEqual({ reasoning: { effort: "xhigh", summary: "auto" } });
  });

  it("sets output_config.effort on Messages and leaves thinking alone", () => {
    const body: Record<string, unknown> = {
      thinking: { type: "enabled", budget_tokens: 2048 },
      output_config: { effort: "low", task_budget: { type: "tokens", total: 50000 } },
    };
    applyEffort("messages", body, "max");
    expect(body).toEqual({
      thinking: { type: "enabled", budget_tokens: 2048 },
      output_config: { effort: "max", task_budget: { type: "tokens", total: 50000 } },
    });
  });

  it("creates the reasoning object when the client sent none", () => {
    const body: Record<string, unknown> = { reasoning: null };
    applyEffort("chat", body, "low");
    expect(body).toEqual({ reasoning: { effort: "low" } });
  });
});

let upstream: Upstream | undefined;
let proxy: ProxyServer | undefined;

afterEach(async () => {
  await proxy?.close();
  await upstream?.close();
  proxy = upstream = undefined;
});

describe("forwarding with a tier effort", () => {
  async function sentBody(effort: "high" | undefined, path: string, body: unknown) {
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const route = { tier: "frontier", model: "test/model", ...(effort ? { effort } : {}) } as const;
    proxy = await startProxy({ apiKey: "sk-test", route, upstreamBaseUrl: upstream.baseUrl });
    await send(`${proxy.url}${path}`, { body: JSON.stringify(body) });
    return JSON.parse(upstream.requests[0]?.body ?? "{}");
  }

  it("overrides the client's effort", async () => {
    const body = await sentBody("high", "/v1/messages", { output_config: { effort: "low" } });
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("passes the client's effort through when the tier sets none", async () => {
    const body = await sentBody(undefined, "/v1/chat/completions", { reasoning_effort: "low" });
    expect(body).toEqual({ model: "test/model", reasoning_effort: "low" });
  });
});
