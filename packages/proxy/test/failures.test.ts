import { afterEach, describe, expect, it } from "vitest";
import { failureCode } from "../src/forward.js";
import { memoryLog, type ProxyServer, send, startProxy, startUpstream } from "./helpers.js";

/** The shape Node's fetch rejects with: a bare TypeError, the reason nested in `cause`. */
function fetchFailed(cause: unknown): TypeError {
  return new TypeError("fetch failed", { cause });
}

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("failureCode", () => {
  it("finds the code in the cause", () => {
    expect(
      failureCode(fetchFailed(coded("Headers Timeout Error", "UND_ERR_HEADERS_TIMEOUT"))),
    ).toBe("UND_ERR_HEADERS_TIMEOUT");
  });

  it("looks inside an AggregateError, as with failed IPv4/IPv6 connection attempts", () => {
    const aggregate = new AggregateError([coded("connect ECONNREFUSED ::1:443", "ECONNREFUSED")]);
    expect(failureCode(fetchFailed(aggregate))).toBe("ECONNREFUSED");
  });

  it("returns null when there is no code", () => {
    expect(failureCode(new Error("boom"))).toBeNull();
  });
});

let proxy: ProxyServer | undefined;

afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
});

async function failWith(error: unknown) {
  const log = memoryLog();
  proxy = await startProxy({
    apiKey: "sk-test",
    route: { tier: "balanced", model: "test/model" },
    fetch: async () => {
      throw error;
    },
    log,
  });
  const chat = await send(`${proxy.url}/v1/chat/completions`, { body: "{}" });
  const messages = await send(`${proxy.url}/v1/messages`, { body: "{}" });
  return { chat, messages, log };
}

describe("upstream failures", () => {
  it.each(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT"])(
    "answers %s with 504",
    async (code) => {
      const { chat, messages, log } = await failWith(fetchFailed(coded("timeout", code)));
      expect(chat.status).toBe(504);
      expect(chat.json()).toMatchObject({
        error: { type: "server_error", code: "upstream_timeout" },
      });
      expect(messages.json()).toMatchObject({ type: "error", error: { type: "timeout_error" } });
      expect(log.entries[0]).toMatchObject({ status: 504, error: "upstream_timeout", cause: code });
    },
  );

  it.each(["ECONNREFUSED", "ENOTFOUND", "ECONNRESET"])("answers %s with 502", async (code) => {
    const { chat, log } = await failWith(fetchFailed(coded("network", code)));
    expect(chat.status).toBe(502);
    expect((chat.json() as { error: { message: string } }).error.message).toContain(code);
    expect(log.entries[0]).toMatchObject({
      status: 502,
      error: "upstream_unreachable",
      cause: code,
    });
  });

  it("reports a real refused connection by its code", async () => {
    const dead = await startUpstream(() => {});
    const baseUrl = dead.baseUrl;
    await dead.close();
    const log = memoryLog();
    proxy = await startProxy({
      apiKey: "sk-test",
      route: { tier: "balanced", model: "test/model" },
      upstreamBaseUrl: baseUrl,
      log,
    });
    const res = await send(`${proxy.url}/v1/chat/completions`, { body: "{}" });
    expect(res.status).toBe(502);
    expect(log.entries[0]?.cause).toBe("ECONNREFUSED");
  });
});
