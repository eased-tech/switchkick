import { once } from "node:events";
import {
  type ClientRequest,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import {
  type AppOptions,
  createApp,
  type DecisionLog,
  type DecisionLogEntry,
} from "../src/index.js";

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function shut(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
  /** Resolves when the upstream response closes; `finished` is false if it closed early. */
  closed: Promise<{ finished: boolean }>;
}

export interface Upstream {
  baseUrl: string;
  requests: RecordedRequest[];
  /** Resolves with the next request the upstream receives. */
  nextRequest(): Promise<RecordedRequest>;
  close(): Promise<void>;
}

export type UpstreamHandler = (req: RecordedRequest, res: ServerResponse) => void | Promise<void>;

/** A stand-in for OpenRouter that records every request it receives. */
export async function startUpstream(handler: UpstreamHandler): Promise<Upstream> {
  const requests: RecordedRequest[] = [];
  const waiters: ((req: RecordedRequest) => void)[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const recorded: RecordedRequest = {
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
      closed: new Promise((resolve) => {
        res.on("close", () => resolve({ finished: res.writableFinished }));
      }),
    };
    requests.push(recorded);
    waiters.shift()?.(recorded);
    await handler(recorded, res);
  });
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    requests,
    nextRequest: () => new Promise((resolve) => waiters.push(resolve)),
    close: () => shut(server),
  };
}

export interface ProxyServer {
  url: string;
  close(): Promise<void>;
}

/** The real switchkick app on a real socket, so disconnects behave as they do in production. */
export async function startProxy(options: AppOptions): Promise<ProxyServer> {
  const server = createAdaptorServer({ fetch: createApp(options).fetch }) as Server;
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, close: () => shut(server) };
}

export interface SendOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

/** Starts a request and resolves once response headers arrive. Defaults to a JSON POST. */
export async function open(
  url: string,
  options: SendOptions = {},
): Promise<{ req: ClientRequest; res: IncomingMessage }> {
  const req = httpRequest(url, {
    method: options.method ?? "POST",
    headers: { "content-type": "application/json", ...options.headers },
  });
  const response = once(req, "response") as Promise<[IncomingMessage]>;
  req.end(options.body);
  const [res] = await response;
  return { req, res };
}

export interface SendResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  json(): unknown;
}

/** Sends a request with exact control over headers and returns the raw response bytes. */
export async function send(url: string, options: SendOptions = {}): Promise<SendResult> {
  const { res } = await open(url, options);
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  return {
    status: res.statusCode ?? 0,
    headers: res.headers,
    body,
    json: () => JSON.parse(body.toString("utf8")),
  };
}

/** A decision log that keeps entries in memory. */
export function memoryLog(): DecisionLog & { entries: DecisionLogEntry[] } {
  const entries: DecisionLogEntry[] = [];
  return { entries, write: (entry) => entries.push(entry) };
}

/** Polls until `check` passes, for effects that land after the response (log writes). */
export async function eventually(check: () => void, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
