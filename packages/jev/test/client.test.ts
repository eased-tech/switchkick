import { describe, expect, it, vi } from "vitest";
import { createJevClient, type DecideRequest, MAX_SESSION_ID_CHARS } from "../src/index.js";
import request from "./fixtures/decisions-live.request.json" with { type: "json" };
import live from "./fixtures/decisions-live.response.json" with { type: "json" };

const DECIDE = {
  state: request.state,
  questions: request.questions,
} as unknown as DecideRequest;

function respond(status: number, body: unknown) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

/** A fetch that never answers, but rejects when its signal aborts, as real fetch does. */
function hanging() {
  return vi.fn<typeof fetch>(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  );
}

describe("createJevClient", () => {
  it("posts the documented request shape and returns a validated response", async () => {
    const fetch = respond(200, live);
    const client = createJevClient({
      apiKey: "sk-test",
      fetch,
      headers: { "X-OpenRouter-Title": "switchkick" },
    });
    const result = await client.decide({ ...DECIDE, sessionId: "s".repeat(300) });
    expect(result).toMatchObject({ ok: true, response: { answers: live.answers } });

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(headers["X-OpenRouter-Title"]).toBe("switchkick");
    const sent = JSON.parse(String(init?.body));
    expect(sent).toEqual({
      model: "typesafe/jev-1.14",
      state: request.state,
      questions: request.questions,
      session_id: "s".repeat(MAX_SESSION_ID_CHARS),
    });
  });

  it("uses the configured model and base URL", async () => {
    const fetch = respond(200, live);
    const client = createJevClient({
      apiKey: "k",
      fetch,
      model: "~typesafe/jev-latest",
      baseUrl: "http://127.0.0.1:9/api/alpha/",
    });
    await client.decide(DECIDE);
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9/api/alpha/decisions");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).model).toBe("~typesafe/jev-latest");
  });

  it("returns HTTP errors as values, quoting the error envelope", async () => {
    const client = createJevClient({
      apiKey: "k",
      fetch: respond(429, { error: { code: 429, message: "slow down" } }),
    });
    expect(await client.decide(DECIDE)).toMatchObject({
      ok: false,
      error: { kind: "http", status: 429, message: "slow down" },
    });
  });

  it("falls back to the status when the error body isn't JSON", async () => {
    const client = createJevClient({ apiKey: "k", fetch: respond(502, "<html>bad gateway") });
    expect(await client.decide(DECIDE)).toMatchObject({
      ok: false,
      error: { kind: "http", status: 502, message: "HTTP 502" },
    });
  });

  it("reports a malformed answer as invalid_response", async () => {
    const answers = { ...live.answers, team: { type: "choice" } };
    const client = createJevClient({ apiKey: "k", fetch: respond(200, { ...live, answers }) });
    expect(await client.decide(DECIDE)).toMatchObject({
      ok: false,
      error: { kind: "invalid_response", message: "bad answers.team" },
    });
  });

  it("reports a non-JSON success body as invalid_response", async () => {
    const client = createJevClient({ apiKey: "k", fetch: respond(200, "not json") });
    expect(await client.decide(DECIDE)).toMatchObject({
      ok: false,
      error: { kind: "invalid_response" },
    });
  });

  it("reports network failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const client = createJevClient({ apiKey: "k", fetch });
    expect(await client.decide(DECIDE)).toMatchObject({
      ok: false,
      error: { kind: "network", message: "TypeError: fetch failed" },
    });
  });

  it("times out at the deadline and aborts the request", async () => {
    const fetch = hanging();
    const client = createJevClient({ apiKey: "k", fetch, deadlineMs: 100 });
    const started = performance.now();
    const result = await client.decide(DECIDE);
    const elapsed = performance.now() - started;
    expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
    expect(elapsed).toBeLessThan(150);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("meets the deadline even when fetch ignores the abort signal", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    const client = createJevClient({ apiKey: "k", fetch, deadlineMs: 1000 });
    const started = performance.now();
    const result = await client.decide({ ...DECIDE, deadlineMs: 80 });
    expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
    expect(performance.now() - started).toBeLessThan(130);
  });

  it("stops promptly when the caller aborts", async () => {
    const fetch = hanging();
    const client = createJevClient({ apiKey: "k", fetch, deadlineMs: 5000 });
    const controller = new AbortController();
    const pending = client.decide({ ...DECIDE, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    expect(await pending).toMatchObject({ ok: false, error: { kind: "aborted" } });
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("warms the connection with an unauthenticated HEAD, and never throws", async () => {
    const fetch = respond(404, "");
    const client = createJevClient({ apiKey: "sk-test", fetch, baseUrl: "http://x/api/alpha///" });
    await client.warm?.();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("http://x/api/alpha/decisions");
    expect(init?.method).toBe("HEAD");
    expect(init?.headers).toBeUndefined();

    const failing = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      createJevClient({ apiKey: "k", fetch: failing }).warm?.(),
    ).resolves.toBeUndefined();
  });

  it("doesn't call Jev at all when the caller has already aborted", async () => {
    const fetch = respond(200, live);
    const client = createJevClient({ apiKey: "k", fetch });
    const result = await client.decide({ ...DECIDE, signal: AbortSignal.abort() });
    expect(result).toMatchObject({ ok: false, error: { kind: "aborted" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
