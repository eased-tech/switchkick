import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  eventually,
  memoryLog,
  open,
  type ProxyServer,
  startProxy,
  startUpstream,
  type Upstream,
} from "./helpers.js";

const ROUTE = { tier: "balanced", model: "test/routed-model" } as const;

let upstream: Upstream | undefined;
let proxy: ProxyServer | undefined;

afterEach(async () => {
  await proxy?.close();
  await upstream?.close();
  proxy = upstream = undefined;
});

describe("client disconnect", () => {
  it("aborts the upstream request while waiting for response headers", async () => {
    upstream = await startUpstream(() => {
      // Never respond, like a model that is slow to start.
    });
    const log = memoryLog();
    proxy = await startProxy({
      apiKey: "sk-test",
      route: ROUTE,
      upstreamBaseUrl: upstream.baseUrl,
      log,
    });

    const req = httpRequest(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    req.on("error", () => {});
    const received = upstream.nextRequest();
    req.end("{}");
    const upstreamReq = await received;
    req.destroy();

    expect(await upstreamReq.closed).toEqual({ finished: false });
    await eventually(() =>
      expect(log.entries).toEqual([
        expect.objectContaining({ status: 499, error: "client_closed" }),
      ]),
    );
  });

  it("aborts the upstream stream when the client goes away mid-response", async () => {
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: ping\ndata: {}\n\n");
      // Keep the stream open, like a long generation.
    });
    proxy = await startProxy({
      apiKey: "sk-test",
      route: ROUTE,
      upstreamBaseUrl: upstream.baseUrl,
    });

    const { res } = await open(`${proxy.url}/v1/messages`, { body: '{"stream":true}' });
    await once(res, "data");
    res.destroy();

    const upstreamReq = upstream.requests[0];
    expect(await upstreamReq?.closed).toEqual({ finished: false });
  });
});
