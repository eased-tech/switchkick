import { request } from "node:http";
import { DEFAULT_POLICY, type Policy, type Tier } from "@switchkick/core";
import {
  createJevClient,
  type DecideRequest,
  type DecideResult,
  type JevClient,
} from "@switchkick/jev";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AppOptions, type LocalRoute, SESSION_HEADER, TIER_HEADER } from "../src/index.js";
import {
  eventually,
  memoryLog,
  type ProxyServer,
  send,
  startProxy,
  startUpstream,
  type Upstream,
} from "./helpers.js";

const TIERS_CONFIG = {
  fast: { model: "test/fast" },
  balanced: { model: "test/balanced" },
  frontier: { model: "test/frontier", effort: "high" },
} as const;
const TRUSTED = { model: "test/trusted" };
const STATIC = { tier: "balanced", model: "test/balanced" } as const;
const SECRET = `ghp_${"aB3dE5fG7h".repeat(4)}`;
const MINUTE = 60_000;

let upstream: Upstream | undefined;
let proxy: ProxyServer | undefined;

afterEach(async () => {
  await proxy?.close();
  await upstream?.close();
  proxy = upstream = undefined;
});

function answer(
  tier: Tier,
  extra: { sensitive?: number; selfRouting?: number } = {},
): DecideResult {
  return {
    ok: true,
    latencyMs: 7,
    response: {
      model: "typesafe/jev-1.14-20261014",
      answers: {
        tier: { type: "choice", choice: tier, probabilities: { [tier]: 1 }, confidence: 1 },
        sensitive: { type: "noul", noul: extra.sensitive ?? 0 },
        self_routing: { type: "noul", noul: extra.selfRouting ?? 0 },
      },
      usage: { input_tokens: 120, output_tokens: 0, cost: 0.000005 },
    },
  };
}

/** A Jev stand-in that answers from a queue of tiers (or results) and records each request. */
function fakeJev(...answers: (Tier | DecideResult)[]): JevClient & { calls: DecideRequest[] } {
  const calls: DecideRequest[] = [];
  return {
    calls,
    async decide(request) {
      calls.push(request);
      const next = answers.length > 1 ? answers.shift() : answers[0];
      if (next === undefined) throw new Error("fake Jev has no answer");
      return typeof next === "string" ? answer(next) : next;
    },
  };
}

async function setup(
  local: Partial<LocalRoute> & Pick<LocalRoute, "jev">,
  extra: Partial<AppOptions> = {},
) {
  const log = memoryLog();
  upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  proxy = await startProxy({
    apiKey: "sk-test",
    route: STATIC,
    upstreamBaseUrl: upstream.baseUrl,
    log,
    local: { policy: DEFAULT_POLICY, tiers: TIERS_CONFIG, trusted: TRUSTED, ...local },
    ...extra,
  });
  return { upstream, proxy, log };
}

/** Sends a request and returns the model switchkick sent upstream. */
async function routed(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await send(`${proxy?.url}${path}`, { body: JSON.stringify(body), headers });
  expect(res.status).toBe(200);
  return JSON.parse(upstream?.requests.at(-1)?.body ?? "{}") as Record<string, unknown>;
}

// Claude Code-shaped Messages requests: a bare `claude-*` model, tools, and a session id in
// `metadata.user_id`.
const CLAUDE_SESSION = "user_abc_account_def_session_0b1c2d3e-aaaa-bbbb-cccc-0123456789ab";
function claudeCode(messages: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 32000,
    system: [{ type: "text", text: "You are Claude Code." }],
    tools: [{ name: "Bash", input_schema: { type: "object" } }],
    metadata: { user_id: CLAUDE_SESSION },
    messages,
    ...overrides,
  };
}
const toolUse = (id: string) => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }],
});
const toolResult = (id: string) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: "a.ts b.ts" }],
});

describe("local mode", () => {
  it("routes a human turn to Jev's tier and logs the decision without any prompt text", async () => {
    const jev = fakeJev("frontier");
    const { log } = await setup({ jev });
    const sent = await routed(
      "/v1/messages",
      claudeCode([{ role: "user", content: "redesign the cache" }]),
    );
    expect(sent.model).toBe("test/frontier");
    expect(sent.output_config).toEqual({ effort: "high" });

    expect(jev.calls).toHaveLength(1);
    expect(jev.calls[0]?.state).toEqual({ latest_user_message: "redesign the cache" });
    expect(Object.keys(jev.calls[0]?.questions ?? {})).toEqual([
      "tier",
      "sensitive",
      "self_routing",
    ]);

    await eventually(() => expect(log.entries).toHaveLength(1));
    const entry = log.entries[0];
    expect(entry).toMatchObject({
      mode: "local",
      tier: "frontier",
      model: "test/frontier",
      effort: "high",
      reason: "jev",
      turn: "human",
      requestedModel: "claude-sonnet-4-5-20250929",
      status: 200,
      jev: {
        model: "typesafe/jev-1.14-20261014",
        tier: "frontier",
        pick: "frontier",
        guards: [],
        probabilities: { fast: 0, balanced: 0, frontier: 1 },
        latencyMs: 7,
        cost: 0.000005,
      },
    });
    expect(entry?.session).toMatch(/^[0-9a-f]{12}$/);
    expect(jev.calls[0]?.sessionId).toBe(entry?.session);
    expect(JSON.stringify(entry)).not.toContain("redesign");
  });

  it("makes exactly one Jev call for a tool loop of many steps", async () => {
    const jev = fakeJev("balanced");
    const { log } = await setup({ jev });
    const messages: unknown[] = [{ role: "user", content: "fix the failing test" }];
    const models: unknown[] = [(await routed("/v1/messages", claudeCode(messages))).model];
    for (let step = 1; step <= 6; step++) {
      messages.push(toolUse(`t${step}`), toolResult(`t${step}`));
      models.push((await routed("/v1/messages", claudeCode(messages))).model);
    }
    expect(jev.calls).toHaveLength(1);
    expect(new Set(models)).toEqual(new Set(["test/balanced"]));
    await eventually(() => expect(log.entries).toHaveLength(7));
    expect(log.entries.slice(1).every((e) => e.reason === "inherit" && e.jev === null)).toBe(true);
  });

  it("lets a subagent inherit the session's tier", async () => {
    const jev = fakeJev("frontier", "fast");
    const { log } = await setup({ jev });
    await routed("/v1/messages", claudeCode([{ role: "user", content: "plan the migration" }]));
    // Same Claude Code session, its own system prompt and first message.
    const sent = await routed(
      "/v1/messages",
      claudeCode([{ role: "user", content: "Find every caller of migrate()" }], {
        system: [{ type: "text", text: "You are a file search specialist." }],
      }),
    );
    expect(sent.model).toBe("test/frontier");
    expect(jev.calls).toHaveLength(1);
    await eventually(() =>
      expect(log.entries[1]).toMatchObject({ reason: "subagent", turn: "subagent" }),
    );
  });

  it("replays a captured Claude Code 2.1 run: one Jev call, side call and subagent inherit", async () => {
    // The request sequence Claude Code 2.1.303 sent for "list the files, then have a subagent
    // count README lines", reduced to its shape.
    const jev = fakeJev("frontier", "fast");
    const { log } = await setup({ jev });
    const headers = { "x-claude-code-session-id": "e88e3442-0000-4000-8000-000000000000" };
    const reminder = { role: "system", content: [{ type: "text", text: "<context>" }] };
    const main = (messages: unknown[]) =>
      claudeCode(messages, { metadata: undefined, model: "claude-opus-5-5" });
    const agent = (messages: unknown[]) =>
      claudeCode(messages, {
        metadata: undefined,
        model: "claude-opus-5-5",
        system: [{ type: "text", text: "You are a general-purpose agent." }],
      });
    const prompt = { role: "user", content: "list the files, then have a subagent count lines" };
    const send = (body: unknown) =>
      routed("/v1/messages", body, headers).then((sent) => sent.model);

    // A tool-less side request races the first main request.
    const side = {
      model: "claude-opus-5-5",
      max_tokens: 128000,
      system: [{ type: "text", text: "Suggest a follow-up." }],
      messages: [{ role: "user", content: "<conversation summary>" }],
    };
    const models = await Promise.all([send(side), send(main([prompt, reminder]))]);
    models.push(await send(main([prompt, reminder, toolUse("t1"), toolResult("t1")])));
    const task = { role: "user", content: "Count the lines in README.md" };
    models.push(await send(agent([task, reminder])));
    models.push(await send(agent([task, reminder, toolUse("a1"), toolResult("a1"), reminder])));
    models.push(
      await send(
        main([prompt, reminder, toolUse("t1"), toolResult("t1"), toolUse("t2"), toolResult("t2")]),
      ),
    );

    expect(jev.calls).toHaveLength(1);
    expect(jev.calls[0]?.state).toEqual({ latest_user_message: prompt.content });
    expect(models.slice(1)).toEqual(Array(5).fill("test/frontier"));
    await eventually(() => expect(log.entries).toHaveLength(6));
    const turns = log.entries.map((e) => e.turn).sort();
    expect(turns).toEqual(["human", "inherit", "inherit", "inherit", "side_call", "subagent"]);
  });

  it("routes side calls without asking Jev", async () => {
    const jev = fakeJev("frontier");
    await setup({ jev });
    const sent = await routed("/v1/messages", {
      model: "claude-haiku-4-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "Summarize this conversation in five words." }],
    });
    expect(sent.model).toBe("test/balanced");
    expect(jev.calls).toHaveLength(0);
  });

  it("allows a downgrade once the session has been idle past idleResetMinutes", async () => {
    let now = 1_800_000_000_000;
    const jev = fakeJev("frontier", "fast", "fast");
    await setup({ jev, now: () => now });
    const first = [{ role: "user", content: "rewrite the scheduler" }];
    expect((await routed("/v1/messages", claudeCode(first))).model).toBe("test/frontier");

    const second = [
      ...first,
      { role: "assistant", content: "Done." },
      { role: "user", content: "rename x" },
    ];
    now += 5 * MINUTE;
    expect((await routed("/v1/messages", claudeCode(second))).model).toBe("test/frontier");

    const third = [
      ...second,
      { role: "assistant", content: "Renamed." },
      { role: "user", content: "and y" },
    ];
    now += 31 * MINUTE;
    expect((await routed("/v1/messages", claudeCode(third))).model).toBe("test/fast");
  });

  it("latches a session that shows a secret to the trusted model, and never sends it to Jev", async () => {
    const jev = fakeJev("frontier");
    const { log } = await setup({ jev });
    const history: unknown[] = [{ role: "user", content: `deploy with ${SECRET} please` }];
    expect((await routed("/v1/messages", claudeCode(history))).model).toBe("test/trusted");
    history.push(
      { role: "assistant", content: "Deployed." },
      { role: "user", content: "now the docs" },
    );
    expect((await routed("/v1/messages", claudeCode(history))).model).toBe("test/trusted");
    history.push(toolUse("t1"), toolResult("t1"));
    expect((await routed("/v1/messages", claudeCode(history))).model).toBe("test/trusted");

    expect(jev.calls).toHaveLength(0);
    await eventually(() => expect(log.entries).toHaveLength(3));
    expect(log.entries[0]).toMatchObject({ reason: "secret", secret: "github_token" });
    expect(JSON.stringify(log.entries)).not.toContain(SECRET);
  });

  it("doesn't let a #fast tag lower a ratcheted session, but #fast! does", async () => {
    const jev = fakeJev("frontier");
    await setup({ jev });
    const history: unknown[] = [{ role: "user", content: "design the plugin API" }];
    expect((await routed("/v1/messages", claudeCode(history))).model).toBe("test/frontier");
    history.push(
      { role: "assistant", content: "Here it is." },
      { role: "user", content: "#fast fix the typo" },
    );
    expect((await routed("/v1/messages", claudeCode(history))).model).toBe("test/frontier");
    history.push(
      { role: "assistant", content: "Fixed." },
      { role: "user", content: "#fast! and another" },
    );
    expect((await routed("/v1/messages", claudeCode(history))).model).toBe("test/fast");
    expect(jev.calls).toHaveLength(1);
  });

  it("gives sessions with the same first message but different system prompts their own keys", async () => {
    const jev = fakeJev("fast", "frontier");
    const { log } = await setup({ jev });
    const chat = (system: string) => ({
      model: "gpt-5",
      messages: [
        { role: "system", content: system },
        { role: "user", content: "hello" },
      ],
    });
    await Promise.all([
      routed("/v1/chat/completions", chat("You are a poet.")),
      routed("/v1/chat/completions", chat("You are a SQL expert.")),
    ]);
    const models = upstream?.requests.map((r) => JSON.parse(r.body).model);
    expect(new Set(models)).toEqual(new Set(["test/fast", "test/frontier"]));
    expect(jev.calls).toHaveLength(2);
    await eventually(() => expect(log.entries).toHaveLength(2));
    expect(log.entries[0]?.session).not.toBe(log.entries[1]?.session);
  });

  it("follows the main conversation even if another one named the session first", async () => {
    const jev = fakeJev("fast", "frontier");
    await setup({ jev });
    // A stray request with its own system prompt claims the Claude Code session first.
    await routed(
      "/v1/messages",
      claudeCode([{ role: "user", content: "classify this" }], {
        system: [{ type: "text", text: "You are a classifier." }],
      }),
    );
    const main = [
      { role: "user", content: "start the feature" },
      { role: "assistant", content: "Started." },
      { role: "user", content: "now the hard part" },
    ];
    expect((await routed("/v1/messages", claudeCode(main))).model).toBe("test/frontier");
    expect(jev.calls).toHaveLength(2);
  });

  it("never sends a secret quoted in the previous reply to Jev", async () => {
    const jev = fakeJev("fast");
    await setup({ jev });
    await routed(
      "/v1/messages",
      claudeCode([
        { role: "user", content: "what's in .env?" },
        { role: "assistant", content: `It sets OPENAI_API_KEY=sk-proj-${"aB3dE5fG7h".repeat(4)}` },
        { role: "user", content: "ok, deploy" },
      ]),
    );
    expect(jev.calls[0]?.state).toEqual({ latest_user_message: "ok, deploy" });
  });

  it("only uses prompt_cache_key to tell sessions apart, never to join them", async () => {
    const jev = fakeJev("frontier", "fast");
    const { log } = await setup({ jev });
    const chat = (content: string) => ({
      model: "gpt-5",
      prompt_cache_key: "my-app",
      messages: [{ role: "user", content }],
    });
    expect((await routed("/v1/chat/completions", chat(`use ${SECRET}`))).model).toBe(
      "test/trusted",
    );
    expect((await routed("/v1/chat/completions", chat("plan a refactor"))).model).toBe(
      "test/frontier",
    );
    expect((await routed("/v1/chat/completions", chat("rename a file"))).model).toBe("test/fast");
    await eventually(() => expect(log.entries).toHaveLength(3));
    expect(new Set(log.entries.map((e) => e.session)).size).toBe(3);
  });

  it("keeps clients with different API keys in different sessions", async () => {
    const jev = fakeJev("fast");
    const { log } = await setup({ jev });
    const body = { model: "gpt-5", messages: [{ role: "user", content: "hello" }] };
    await routed("/v1/chat/completions", body, { authorization: "Bearer client-a" });
    await routed("/v1/chat/completions", body, { authorization: "Bearer client-a" });
    await routed("/v1/chat/completions", body, { "x-api-key": "client-b" });
    await eventually(() => expect(log.entries).toHaveLength(3));
    const [a1, a2, b] = log.entries.map((e) => e.session);
    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
    expect(JSON.stringify(log.entries)).not.toContain("client-");
  });

  it("uses the x-switchkick-session header as the session key", async () => {
    const jev = fakeJev("frontier");
    await setup({ jev });
    const headers = { [SESSION_HEADER]: "my-session" };
    await routed("/v1/responses", { input: "plan a big refactor" }, headers);
    // A different conversation, but the same named session and system prompt: a new human turn
    // that can only ratchet up.
    await routed("/v1/responses", { input: "something else" }, headers);
    expect(jev.calls).toHaveLength(1);
  });

  it("decides an inherited request from its turn's message after a restart", async () => {
    const jev = fakeJev("fast");
    const { log } = await setup({ jev });
    await routed("/v1/responses", {
      input: [
        { type: "message", role: "user", content: "list the files" },
        { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "a b" },
      ],
    });
    expect(jev.calls[0]?.state).toEqual({ latest_user_message: "list the files" });
    await eventually(() =>
      expect(log.entries[0]).toMatchObject({ reason: "jev", turn: "inherit" }),
    );
  });

  describe("hard rules", () => {
    it("sends an OpenRouter slug through as a pin, but routes bare client model names", async () => {
      const jev = fakeJev("fast");
      await setup({ jev });
      const pinned = await routed("/v1/chat/completions", {
        model: "openai/gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(pinned.model).toBe("openai/gpt-5.5");
      expect(jev.calls).toHaveLength(0);
      const bare = await routed("/v1/messages", claudeCode([{ role: "user", content: "hi" }]));
      expect(bare.model).toBe("test/fast");
      expect(jev.calls).toHaveLength(1);
    });

    it("routes OpenRouter slugs too when slugPins is off, so only configured models are used", async () => {
      const jev = fakeJev("fast");
      await setup({ jev, slugPins: false, modelPins: { "openai/*": "test/pinned" } });
      const chat = (model: string) => ({ model, messages: [{ role: "user", content: "hi" }] });
      expect((await routed("/v1/chat/completions", chat("x-ai/grok-5"))).model).toBe("test/fast");
      expect((await routed("/v1/chat/completions", chat("openai/gpt-5.5"))).model).toBe(
        "test/pinned",
      );
    });

    it("maps requested models through modelPins", async () => {
      const jev = fakeJev("fast");
      const { log } = await setup({
        jev,
        modelPins: { "claude-opus-*": "anthropic/claude-opus-5.5" },
      });
      const sent = await routed(
        "/v1/messages",
        claudeCode([{ role: "user", content: "hi" }], { model: "claude-opus-4-5-20251101" }),
      );
      expect(sent.model).toBe("anthropic/claude-opus-5.5");
      expect(jev.calls).toHaveLength(0);
      await eventually(() => expect(log.entries[0]).toMatchObject({ reason: "pin", tier: null }));
    });

    it("honours the tier header without asking Jev, and never forwards switchkick headers", async () => {
      const jev = fakeJev("fast");
      await setup({ jev });
      const sent = await routed(
        "/v1/chat/completions",
        { model: "gpt-5", messages: [{ role: "user", content: "hi" }] },
        { [TIER_HEADER]: "frontier", [SESSION_HEADER]: "s1" },
      );
      expect(sent.model).toBe("test/frontier");
      expect(jev.calls).toHaveLength(0);
      const headers = upstream?.requests[0]?.headers ?? {};
      expect(Object.keys(headers).filter((h) => h.startsWith("x-switchkick"))).toEqual([]);
    });

    it("routes every request at SWITCHKICK_TIER when it is set", async () => {
      const jev = fakeJev("frontier");
      await setup({ jev }, { envTier: "fast" });
      const sent = await routed("/v1/responses", { input: "anything" });
      expect(sent.model).toBe("test/fast");
      expect(jev.calls).toHaveLength(0);
    });

    it("raises a sensitive request to the floor and a self-routing one by a level", async () => {
      const jev = fakeJev(answer("fast", { sensitive: 0.9 }), answer("fast", { selfRouting: 0.8 }));
      await setup({ jev, policy: { ...DEFAULT_POLICY, session: "per-request" } });
      expect((await routed("/v1/responses", { input: "drop the prod table" })).model).toBe(
        "test/balanced",
      );
      expect((await routed("/v1/responses", { input: "use the cheap model" })).model).toBe(
        "test/balanced",
      );
    });
  });

  describe("when Jev fails", () => {
    it("falls back within deadlineMs + 50 ms when Jev times out (1500 ms default)", async () => {
      // A real client whose fetch never answers until it is aborted.
      const hanging = vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      );
      const jev = createJevClient({ apiKey: "sk-test", fetch: hanging });
      const { log } = await setup({ jev });
      const next = upstream?.nextRequest();
      const started = performance.now();
      const response = send(`${proxy?.url}/v1/responses`, { body: '{"input":"hi"}' });
      const request = await next;
      const elapsed = performance.now() - started;
      expect((await response).status).toBe(200);
      expect(JSON.parse(request?.body ?? "{}").model).toBe("test/balanced");
      expect(elapsed).toBeGreaterThanOrEqual(1500);
      expect(elapsed).toBeLessThan(1550);
      await eventually(() =>
        expect(log.entries[0]).toMatchObject({
          reason: "fail_open",
          jev: { error: "timeout" },
        }),
      );
    });

    it("falls back to the default tier on an error, and reports it", async () => {
      const failed: DecideResult = {
        ok: false,
        error: { kind: "http", status: 401, message: "No auth credentials found", latencyMs: 30 },
      };
      const onJevError = vi.fn();
      const { log } = await setup({ jev: fakeJev(failed), onJevError });
      expect((await routed("/v1/responses", { input: "hi" })).model).toBe("test/balanced");
      expect(onJevError).toHaveBeenCalledWith(failed.error);
      await eventually(() =>
        expect(log.entries[0]?.jev).toEqual({
          error: "http",
          status: 401,
          message: "No auth credentials found",
          latencyMs: 30,
        }),
      );
    });

    it("treats unusable answers as a failure", async () => {
      const odd: DecideResult = {
        ok: true,
        latencyMs: 3,
        response: { model: "m", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } },
      };
      const { log } = await setup({ jev: fakeJev(odd) });
      expect((await routed("/v1/responses", { input: "hi" })).model).toBe("test/balanced");
      await eventually(() =>
        expect(log.entries[0]).toMatchObject({
          reason: "fail_open",
          jev: { error: "invalid_response" },
        }),
      );
    });

    it("answers 503 without calling upstream when failClosed is set", async () => {
      const failed: DecideResult = { ok: false, error: { kind: "timeout", latencyMs: 1500 } };
      const policy: Policy = { ...DEFAULT_POLICY, failClosed: true };
      const { log } = await setup({ jev: fakeJev(failed), policy });
      const res = await send(`${proxy?.url}/v1/messages`, {
        body: JSON.stringify(claudeCode([{ role: "user", content: "hi" }])),
      });
      expect(res.status).toBe(503);
      expect(res.json()).toMatchObject({ type: "error", error: { type: "overloaded_error" } });
      expect(upstream?.requests).toHaveLength(0);
      await eventually(() =>
        expect(log.entries[0]).toMatchObject({
          status: 503,
          error: "jev_unavailable",
          reason: "fail_closed",
        }),
      );
    });

    it("stops waiting for Jev when the client disconnects", async () => {
      let aborted = false;
      const jev: JevClient = {
        decide: (request) =>
          new Promise((resolve) => {
            request.signal?.addEventListener("abort", () => {
              aborted = true;
              resolve({ ok: false, error: { kind: "aborted", latencyMs: 1 } });
            });
          }),
      };
      const { log } = await setup({ jev });
      const req = request(`${proxy?.url}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      req.on("error", () => {});
      req.end('{"input":"hi"}');
      await eventually(() => expect(log.entries).toHaveLength(0));
      await new Promise((resolve) => setTimeout(resolve, 50));
      req.destroy();
      await eventually(() => expect(aborted).toBe(true));
      await eventually(() =>
        expect(log.entries[0]).toMatchObject({ status: 499, error: "client_closed" }),
      );
      expect(upstream?.requests).toHaveLength(0);
    });
  });

  it("lists the tier and trusted models on /v1/models", async () => {
    await setup({ jev: fakeJev("fast") });
    const res = await send(`${proxy?.url}/v1/models`, { method: "GET" });
    const ids = (res.json() as { data: { id: string }[] }).data.map((m) => m.id);
    expect(ids).toEqual(["test/fast", "test/balanced", "test/frontier", "test/trusted"]);
  });
});

describe("hosted mode tier overrides", () => {
  const HOSTED = { plugin: { id: "jev-router" as const, cost_tier: "medium" as const } };

  async function hostedSetup(extra: Partial<AppOptions> = {}) {
    const log = memoryLog();
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    proxy = await startProxy({
      apiKey: "sk-test",
      route: STATIC,
      hosted: HOSTED,
      upstreamBaseUrl: upstream.baseUrl,
      log,
      ...extra,
    });
    return log;
  }

  const plugin = () =>
    (JSON.parse(upstream?.requests.at(-1)?.body ?? "{}").plugins as { cost_tier: string }[])[0];

  it("maps a tag in the turn's message to the router's cost tier, for every step of the turn", async () => {
    const log = await hostedSetup();
    const messages: unknown[] = [{ role: "user", content: "#frontier redesign it" }];
    await routed("/v1/chat/completions", { messages });
    expect(plugin()?.cost_tier).toBe("high");
    messages.push(
      { role: "assistant", tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    );
    await routed("/v1/chat/completions", { messages });
    expect(plugin()?.cost_tier).toBe("high");
    await eventually(() =>
      expect(log.entries[0]).toMatchObject({ costTier: "high", reason: "tag" }),
    );
  });

  it("maps the tier header and SWITCHKICK_TIER", async () => {
    await hostedSetup({ envTier: "fast" });
    await routed("/v1/responses", { input: "hi" }, { [TIER_HEADER]: "balanced" });
    expect(plugin()?.cost_tier).toBe("medium");
    await routed("/v1/responses", { input: "hi" });
    expect(plugin()?.cost_tier).toBe("low");
  });

  it("leaves the configured cost tier alone without an override", async () => {
    const log = await hostedSetup();
    await routed("/v1/responses", { input: "hi" });
    expect(plugin()?.cost_tier).toBe("medium");
    await eventually(() => expect(log.entries[0]).toMatchObject({ reason: "hosted" }));
  });
});
