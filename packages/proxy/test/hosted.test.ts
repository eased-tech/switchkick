import { once } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AppOptions,
  createApp,
  type HostedRoute,
  JEV_ROUTER_MODEL,
  jevRouterPlugin,
  prepareHostedBody,
  validatePlugin,
} from "../src/index.js";
import {
  eventually,
  memoryLog,
  open,
  type ProxyServer,
  send,
  startProxy,
  startUpstream,
  type Upstream,
  type UpstreamHandler,
} from "./helpers.js";

const ROUTE = { tier: "balanced", model: "test/fallback-model", effort: "high" } as const;
const HOSTED: HostedRoute = { plugin: { id: "jev-router", cost_tier: "low" } };
const fixtures = new URL("./fixtures/", import.meta.url);

let upstream: Upstream | undefined;
let proxy: ProxyServer | undefined;

afterEach(async () => {
  await proxy?.close();
  await upstream?.close();
  proxy = upstream = undefined;
});

async function setup(handler: UpstreamHandler, options: Partial<AppOptions> = {}) {
  const log = memoryLog();
  upstream = await startUpstream(handler);
  proxy = await startProxy({
    apiKey: "sk-test",
    route: ROUTE,
    hosted: HOSTED,
    upstreamBaseUrl: upstream.baseUrl,
    log,
    ...options,
  });
  return { upstream, proxy, log };
}

function json(status: number, body: unknown): UpstreamHandler {
  return (_req, res) => {
    res.writeHead(status, { "content-type": "application/json", "x-generation-id": "gen-1" });
    res.end(JSON.stringify(body));
  };
}

function sentBody(upstream: Upstream, index = 0): Record<string, unknown> {
  return JSON.parse(upstream.requests[index]?.body ?? "null");
}

describe("jev-router plugin validation", () => {
  it.each([
    ["an unknown field", { id: "jev-router", cost_tier: "low", allowed_model: ["x"] }],
    ["an unknown cost tier", { id: "jev-router", cost_tier: "ultra" }],
    ["another plugin id", { id: "web" }],
    ["an empty pattern", { id: "jev-router", models: [""] }],
    ["a pattern over 1,024 characters", { id: "jev-router", models: ["x".repeat(1025)] }],
    [
      "more than 1,024 patterns",
      { id: "jev-router", excluded_models: Array.from({ length: 1025 }, (_, i) => `m/${i}`) },
    ],
  ])("rejects %s", (_name, plugin) => {
    expect(() => validatePlugin(plugin)).toThrow(/Invalid jev-router plugin/);
  });

  it("refuses to build the app with an invalid plugin, before any network call", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() =>
      createApp({
        apiKey: "sk-test",
        route: ROUTE,
        hosted: { plugin: { id: "jev-router", cost_tier: "turbo" } as never },
        fetch,
      }),
    ).toThrow(/cost_tier/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves empty lists out of the plugin built from config", () => {
    expect(
      jevRouterPlugin({ cost_tier: "high", models: [], excluded_models: ["openai/*"] }),
    ).toEqual({ id: "jev-router", cost_tier: "high", excluded_models: ["openai/*"] });
  });
});

describe("prepareHostedBody", () => {
  it("routes to the Jev router and adds the plugin, without touching the client's body", () => {
    const body = { model: "gpt-x", messages: [], plugins: [{ id: "web" }] };
    const copy = structuredClone(body);
    expect(prepareHostedBody(body, HOSTED)).toEqual({
      body: { model: JEV_ROUTER_MODEL, messages: [], plugins: [{ id: "web" }, HOSTED.plugin] },
      warnings: [],
    });
    expect(body).toEqual(copy);
  });

  it("replaces a jev-router entry the client sent, so the config's exclusions always apply", () => {
    const body = { plugins: [{ id: "jev-router", cost_tier: "high" }] };
    expect(prepareHostedBody(body, HOSTED)).toEqual({
      body: { model: JEV_ROUTER_MODEL, plugins: [HOSTED.plugin] },
      warnings: ["client_router_plugin_replaced"],
    });
  });

  it("refuses plugins that aren't an array", () => {
    expect(prepareHostedBody({ plugins: { id: "web" } }, HOSTED)).toMatchObject({
      param: "plugins",
    });
  });

  it("strips reasoning settings the router rejects and keeps the effort hint", () => {
    const body = { reasoning: { effort: "high", max_tokens: 1024, mode: "pro", summary: "auto" } };
    expect(prepareHostedBody(body, HOSTED)).toEqual({
      body: {
        model: JEV_ROUTER_MODEL,
        plugins: [HOSTED.plugin],
        reasoning: { effort: "high", summary: "auto" },
      },
      warnings: ["reasoning_max_tokens_stripped", "reasoning_mode_pro_stripped"],
    });
  });

  it("drops reasoning entirely when nothing else is left in it", () => {
    const prepared = prepareHostedBody({ reasoning: { max_tokens: 1024 } }, HOSTED);
    expect(prepared).not.toHaveProperty("body.reasoning");
  });

  it("leaves other reasoning modes alone", () => {
    const prepared = prepareHostedBody({ reasoning: { mode: "standard" } }, HOSTED);
    expect(prepared).toEqual({
      body: { model: JEV_ROUTER_MODEL, plugins: [HOSTED.plugin], reasoning: { mode: "standard" } },
      warnings: [],
    });
  });

  it("refuses them instead when configured to", () => {
    const prepared = prepareHostedBody(
      { reasoning: { max_tokens: 1024 } },
      { ...HOSTED, unsupportedReasoning: "reject" },
    );
    expect(prepared).toMatchObject({ param: "reasoning" });
    expect((prepared as { error: string }).error).toContain("reasoning.max_tokens");
  });
});

interface Meta {
  status: number;
  headers: Record<string, string>;
  request: Record<string, unknown>;
}

const HOSTED_FIXTURES = ["chat", "responses", "messages"].flatMap((format) =>
  ["json", "stream"].map((mode) => ({
    name: `hosted-${format}-${mode}`,
    path: format === "chat" ? "/chat/completions" : `/${format}`,
    ext: mode === "stream" ? "sse" : "json",
  })),
);

describe("hosted mode", () => {
  it.each(HOSTED_FIXTURES)(
    "returns $name byte for byte and logs the router's decision",
    async ({ name, path, ext }) => {
      const meta = JSON.parse(readFileSync(new URL(`${name}.meta.json`, fixtures), "utf8")) as Meta;
      const recorded = readFileSync(new URL(`${name}.${ext}`, fixtures));
      const text = recorded.toString("utf8");
      // Read straight from the recording, independently of the parser under test.
      const servedModel = /"model":"([^"]+)"/.exec(text)?.[1];
      const resolved = JSON.parse(/"resolved_models":(\[[^\]]*\])/.exec(text)?.[1] ?? "null");
      expect(resolved).toHaveLength(1);

      const { upstream, proxy, log } = await setup((_req, res) => {
        res.writeHead(meta.status, meta.headers);
        // Byte-sized pieces at the start split events and characters; then larger ones.
        for (let i = 0; i < 64; i++) res.write(recorded.subarray(i, i + 1));
        const cuts = [64, 1000, Math.floor(recorded.length / 2) + 3, recorded.length];
        for (let i = 0; i < cuts.length - 1; i++)
          res.write(recorded.subarray(cuts[i], cuts[i + 1]));
        res.end();
      });
      const { model: _model, plugins: _plugins, ...client } = meta.request;

      const res = await send(`${proxy.url}/v1${path}`, { body: JSON.stringify(client) });

      expect(res.status).toBe(meta.status);
      expect(res.body.equals(recorded)).toBe(true);
      const sent = upstream.requests[0];
      expect(JSON.parse(sent?.body ?? "")).toEqual(meta.request);
      expect(sent?.headers["x-openrouter-metadata"]).toBe("enabled");
      await eventually(() => expect(log.entries).toHaveLength(1));
      expect(log.entries[0]).toMatchObject({
        mode: "hosted",
        tier: null,
        model: JEV_ROUTER_MODEL,
        costTier: "low",
        status: 200,
        servedModel,
        router: {
          resolvedModels: resolved,
          reason: expect.any(String),
          pipeline: "default",
          version: expect.any(String),
          candidates: [
            {
              model: resolved[0],
              effort: expect.any(String),
              tier: expect.any(String),
              estimatedCost: expect.any(Number),
            },
          ],
        },
      });
      expect(log.entries[0]).not.toHaveProperty("error");
      expect(JSON.stringify(log.entries[0])).not.toContain("Reply with exactly");
    },
  );

  it("logs the served model when the response has no router metadata, as on a cache hit", async () => {
    const { proxy, log } = await setup(json(200, { model: "vendor/served", choices: [] }));
    await send(`${proxy.url}/v1/chat/completions`, { body: "{}" });
    await eventually(() =>
      expect(log.entries[0]).toMatchObject({ servedModel: "vendor/served", router: null }),
    );
  });

  it("warns when the router ignored the configured models list", async () => {
    const metadata = {
      pipeline: [{ name: "jev-router", data: { list_fallback: "models_ignored" } }],
    };
    const { proxy, log } = await setup(json(200, { model: "m", openrouter_metadata: metadata }));
    await send(`${proxy.url}/v1/chat/completions`, { body: '{"store":true}' });
    await eventually(() =>
      expect(log.entries[0]).toMatchObject({
        router: { listFallback: "models_ignored" },
        warnings: ["models_ignored"],
      }),
    );
  });

  it("notes stripped reasoning settings in the log", async () => {
    const { upstream, proxy, log } = await setup(json(200, {}));
    await send(`${proxy.url}/v1/responses`, {
      body: JSON.stringify({ store: true, reasoning: { effort: "low", max_tokens: 512 } }),
    });
    expect(sentBody(upstream).reasoning).toEqual({ effort: "low" });
    expect(sentBody(upstream).store).toBe(false);
    await eventually(() =>
      expect(log.entries[0]?.warnings).toEqual([
        "store_rewritten",
        "reasoning_max_tokens_stripped",
      ]),
    );
  });

  it("refuses unsupported reasoning settings without calling OpenRouter when configured to", async () => {
    const { upstream, proxy, log } = await setup(json(200, {}), {
      hosted: { ...HOSTED, unsupportedReasoning: "reject" },
    });
    const res = await send(`${proxy.url}/v1/chat/completions`, {
      body: JSON.stringify({ reasoning: { mode: "pro" } }),
    });
    expect(res.status).toBe(400);
    expect(res.json()).toMatchObject({ error: { param: "reasoning" } });
    expect(upstream.requests).toHaveLength(0);
    expect(log.entries[0]).toMatchObject({ status: 400, error: "invalid_request" });
  });

  it("doesn't apply the fallback tier's effort: the router picks the effort", async () => {
    const { upstream, proxy } = await setup(json(200, {}));
    await send(`${proxy.url}/v1/messages`, { body: "{}" });
    expect(sentBody(upstream)).not.toHaveProperty("output_config");
  });

  it("lists the router as the only model", async () => {
    const { proxy } = await setup(json(200, {}));
    const res = await send(`${proxy.url}/v1/models`, { method: "GET" });
    expect(res.json()).toMatchObject({ data: [{ id: JEV_ROUTER_MODEL }] });
  });
});

describe("hosted mode errors", () => {
  it("retries once in static mode when the router is unavailable", async () => {
    let calls = 0;
    const { upstream, proxy, log } = await setup((_req, res) => {
      calls++;
      if (calls === 1)
        return json(503, { error: { code: 503, message: "unavailable" } })(_req, res);
      return json(200, { model: ROUTE.model })(_req, res);
    });

    const res = await send(`${proxy.url}/v1/chat/completions`, {
      body: JSON.stringify({ model: "client", plugins: [{ id: "web" }, { id: "jev-router" }] }),
    });

    expect(res.status).toBe(200);
    expect(upstream.requests).toHaveLength(2);
    expect(sentBody(upstream, 1)).toEqual({
      model: ROUTE.model,
      plugins: [{ id: "web" }],
      reasoning: { effort: "high" },
    });
    expect(upstream.requests[1]?.headers["x-openrouter-metadata"]).toBeUndefined();
    await eventually(() => expect(log.entries).toHaveLength(1));
    expect(log.entries[0]).toMatchObject({
      mode: "hosted",
      fallback: "static",
      reason: "router_unavailable",
      tier: ROUTE.tier,
      model: ROUTE.model,
      effort: "high",
      status: 200,
      servedModel: ROUTE.model,
      router: null,
    });
  });

  it("retries only once, passing a second 503 through", async () => {
    const body = { error: { code: 503, message: "still unavailable" } };
    const { upstream, proxy, log } = await setup(json(503, body));
    const res = await send(`${proxy.url}/v1/chat/completions`, { body: "{}" });
    expect(res.status).toBe(503);
    expect(res.json()).toEqual(body);
    expect(upstream.requests).toHaveLength(2);
    await eventually(() =>
      expect(log.entries).toEqual([expect.objectContaining({ status: 503, fallback: "static" })]),
    );
  });

  it("explains a 404 by naming the config key", async () => {
    const { proxy, log } = await setup(
      json(404, { error: { code: 404, message: "No eligible models" } }),
    );
    const chat = await send(`${proxy.url}/v1/chat/completions`, { body: "{}" });
    const messages = await send(`${proxy.url}/v1/messages`, { body: "{}" });

    expect(chat.status).toBe(404);
    const message = (chat.json() as { error: { message: string } }).error.message;
    expect(message).toContain("No eligible models");
    expect(message).toContain("hosted.excluded_models");
    expect(chat.json()).toMatchObject({ error: { code: "router_no_model" } });
    expect(messages.json()).toMatchObject({ type: "error", error: { type: "not_found_error" } });
    expect(log.entries[0]).toMatchObject({ status: 404, error: "router_no_model" });
  });

  it("surfaces a 400 with OpenRouter's message and a pointer to the config", async () => {
    const { upstream, proxy, log } = await setup(
      json(400, { error: { code: "bad_request", message: "Unknown plugin field: foo" } }),
    );
    const res = await send(`${proxy.url}/v1/responses`, { body: "{}" });
    expect(res.status).toBe(400);
    const message = (res.json() as { error: { message: string } }).error.message;
    expect(message).toContain("Unknown plugin field: foo");
    expect(message).toContain("`hosted`");
    expect(upstream.requests).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ status: 400, error: "router_rejected" });
  });

  it("passes other errors through unchanged", async () => {
    const body = { error: { code: 429, message: "slow down" } };
    const { proxy } = await setup(json(429, body));
    const res = await send(`${proxy.url}/v1/chat/completions`, { body: "{}" });
    expect(res.status).toBe(429);
    expect(res.json()).toEqual(body);
  });

  it("logs once, as client_closed, when the client goes away mid-stream", async () => {
    const { upstream, proxy, log } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"model":"vendor/served"}\n\n');
      // Keep the stream open, like a long generation.
    });

    const { res } = await open(`${proxy.url}/v1/chat/completions`, { body: '{"stream":true}' });
    await once(res, "data");
    res.destroy();

    expect(await upstream.requests[0]?.closed).toEqual({ finished: false });
    await eventually(() => expect(log.entries).toHaveLength(1));
    expect(log.entries[0]).toMatchObject({
      status: 200,
      error: "client_closed",
      servedModel: "vendor/served",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(log.entries).toHaveLength(1);
  });

  it("logs stream_failed when OpenRouter drops the stream", async () => {
    const { proxy, log } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"model":"vendor/served"}\n\n');
      setTimeout(() => res.destroy(), 20);
    });
    const { res } = await open(`${proxy.url}/v1/chat/completions`, { body: '{"stream":true}' });
    res.on("error", () => {});
    res.resume();
    await eventually(() => expect(log.entries).toHaveLength(1));
    expect(log.entries[0]).toMatchObject({ error: "stream_failed" });
  });
});
