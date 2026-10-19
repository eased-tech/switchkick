import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  open,
  type ProxyServer,
  send,
  startProxy,
  startUpstream,
  type Upstream,
} from "./helpers.js";

const ROUTE = { tier: "fast", model: "test/routed-model" } as const;
const fixtures = new URL("./fixtures/", import.meta.url);

interface Meta {
  status: number;
  headers: Record<string, string>;
  request: Record<string, unknown>;
}

const FIXTURES = ["chat", "responses", "messages"].flatMap((format) =>
  ["json", "stream"].flatMap((mode) =>
    ["", "hosted-"].map((prefix) => ({
      name: `${prefix}${format}-${mode}`,
      path: format === "chat" ? "/chat/completions" : `/${format}`,
      ext: mode === "stream" ? "sse" : "json",
    })),
  ),
);

let upstream: Upstream | undefined;
let proxy: ProxyServer | undefined;

afterEach(async () => {
  await proxy?.close();
  await upstream?.close();
  proxy = upstream = undefined;
});

describe("pass-through", () => {
  it.each(FIXTURES)("returns $name byte for byte", async ({ name, path, ext }) => {
    const meta = JSON.parse(readFileSync(new URL(`${name}.meta.json`, fixtures), "utf8")) as Meta;
    const recorded = readFileSync(new URL(`${name}.${ext}`, fixtures));

    upstream = await startUpstream((_req, res) => {
      res.writeHead(meta.status, meta.headers);
      // Split at odd byte offsets so chunk boundaries fall mid-event and mid-character.
      const cuts = [0, 7, Math.floor(recorded.length / 2) + 3, recorded.length];
      for (let i = 0; i < cuts.length - 1; i++) res.write(recorded.subarray(cuts[i], cuts[i + 1]));
      res.end();
    });
    proxy = await startProxy({
      apiKey: "sk-test",
      route: ROUTE,
      upstreamBaseUrl: upstream.baseUrl,
    });

    const res = await send(`${proxy.url}/v1${path}`, { body: JSON.stringify(meta.request) });

    expect(res.status).toBe(meta.status);
    expect(res.headers["content-type"]).toBe(meta.headers["content-type"]);
    expect(res.headers["x-generation-id"]).toBe("gen-REDACTED");
    expect(res.body.equals(recorded)).toBe(true);

    const [sent] = upstream.requests;
    expect(sent?.url).toBe(`/api/v1${path}`);
    expect(JSON.parse(sent?.body ?? "")).toEqual({ ...meta.request, model: ROUTE.model });
  });

  it("streams events as they arrive instead of buffering the response", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    upstream = await startUpstream(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"n":1}\n\n');
      await gate;
      res.end('data: {"n":2}\n\ndata: [DONE]\n\n');
    });
    proxy = await startProxy({
      apiKey: "sk-test",
      route: ROUTE,
      upstreamBaseUrl: upstream.baseUrl,
    });

    const { res } = await open(`${proxy.url}/v1/chat/completions`, {
      body: JSON.stringify({ stream: true, messages: [] }),
    });
    const chunks = res[Symbol.asyncIterator]();
    const first = await chunks.next();
    expect(String(first.value)).toBe('data: {"n":1}\n\n');

    release();
    let rest = "";
    for (let next = await chunks.next(); !next.done; next = await chunks.next()) {
      rest += String(next.value);
    }
    expect(rest).toBe('data: {"n":2}\n\ndata: [DONE]\n\n');
  });

  it("decompresses a gzipped upstream body and drops the encoding headers", async () => {
    const json = JSON.stringify({ id: "gen-1", choices: [] });
    upstream = await startUpstream((_req, res) => {
      const gz = gzipSync(json);
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": gz.length,
      });
      res.end(gz);
    });
    proxy = await startProxy({
      apiKey: "sk-test",
      route: ROUTE,
      upstreamBaseUrl: upstream.baseUrl,
    });

    const res = await send(`${proxy.url}/v1/chat/completions`, { body: "{}" });

    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body.toString("utf8")).toBe(json);
  });
});
