import type { Tier } from "@switchkick/core";
import type { Context, Handler } from "hono";
import type { Effort } from "./config.js";
import { applyEffort } from "./effort.js";
import { type ApiFormat, type ErrorKind, errorBody, UPSTREAM_PATHS } from "./formats.js";
import type { DecisionLog, DecisionLogEntry } from "./log.js";

/** Where a request goes in static mode: one tier, one model, and optionally an effort. */
export interface StaticRoute {
  tier: Tier;
  model: string;
  /** Replaces the client's reasoning effort when set. */
  effort?: Effort;
}

export interface ForwardOptions {
  apiKey: string;
  route: StaticRoute;
  /** e.g. `https://openrouter.ai/api/v1`. */
  upstreamBaseUrl: string;
  fetch: typeof fetch;
  log: DecisionLog;
  /** Send the {@link ATTRIBUTION} headers. Users can opt out. */
  attribution: boolean;
}

/**
 * OpenRouter app attribution: requests carrying these headers count toward switchkick's public
 * app page and rankings, in aggregate across all users. The URL is the app's permanent id, so
 * changing it starts a new app page.
 */
export const ATTRIBUTION = {
  "HTTP-Referer": "https://github.com/eased-tech/switchkick",
  "X-OpenRouter-Title": "switchkick",
} as const;

/**
 * Client headers passed upstream. Everything else is dropped: client credentials, cookies, and
 * `accept-encoding` (fetch negotiates its own compression and decompresses the body).
 */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "user-agent",
  "anthropic-version",
  "anthropic-beta",
  "x-anthropic-beta",
];

/**
 * Upstream headers not passed back. fetch has already decompressed and de-chunked the body,
 * so the original framing headers would describe bytes the client never receives.
 */
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "set-cookie",
]);

function upstreamHeaders(c: Context, options: ForwardOptions): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = c.req.header(name);
    if (value !== undefined) headers.set(name, value);
  }
  // OpenRouter documents `x-anthropic-beta` for passing Anthropic betas; whether it reads the
  // standard `anthropic-beta` is undocumented, so send the union under both names.
  const betas = [c.req.header("anthropic-beta"), c.req.header("x-anthropic-beta")]
    .flatMap((v) => v?.split(",") ?? [])
    .map((v) => v.trim())
    .filter((v) => v !== "");
  if (betas.length > 0) headers.set("x-anthropic-beta", [...new Set(betas)].join(","));
  headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${options.apiKey}`);
  if (options.attribution) {
    for (const [name, value] of Object.entries(ATTRIBUTION)) headers.set(name, value);
  }
  return headers;
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) headers.set(name, value);
  });
  return headers;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Handles one client request in static mode: rewrite `model`, forward to the matching OpenRouter
 * endpoint, and stream the response back byte for byte.
 */
export function forward(format: ApiFormat, options: ForwardOptions): Handler {
  const { route, log } = options;

  return async (c) => {
    const started = performance.now();
    const entry: DecisionLogEntry = {
      ts: new Date().toISOString(),
      format,
      stream: false,
      mode: "static",
      tier: route.tier,
      requestedModel: null,
      model: route.model,
      effort: route.effort ?? null,
      reason: "static",
      status: 0,
      generationId: null,
      upstreamMs: null,
    };
    const fail = (status: 400 | 502, kind: ErrorKind, message: string, param?: string) => {
      log.write({ ...entry, status, error: kind });
      return c.json(errorBody(format, kind, message, param), status);
    };

    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return fail(400, "invalid_request", "The request body is not valid JSON.");
    }
    if (!isPlainObject(body)) {
      return fail(400, "invalid_request", "The request body must be a JSON object.");
    }
    entry.stream = body.stream === true;
    if (typeof body.model === "string") entry.requestedModel = body.model;
    body.model = route.model;
    if (route.effort) applyEffort(format, body, route.effort);

    if (format === "responses") {
      // OpenRouter's Responses API is stateless and rejects both of these with a 400.
      if (body.previous_response_id != null) {
        return fail(
          400,
          "invalid_request",
          "previous_response_id is not supported: OpenRouter's Responses API is stateless. " +
            "Send the full conversation in `input` instead.",
          "previous_response_id",
        );
      }
      if (body.store === true) {
        body.store = false;
        entry.warnings = ["store_rewritten"];
      }
    }

    const signal = c.req.raw.signal;
    const search = new URL(c.req.url).search;
    let upstream: Response;
    try {
      upstream = await options.fetch(
        `${options.upstreamBaseUrl}${UPSTREAM_PATHS[format]}${search}`,
        {
          method: "POST",
          headers: upstreamHeaders(c, options),
          body: JSON.stringify(body),
          signal,
        },
      );
    } catch {
      if (signal.aborted) {
        log.write({ ...entry, status: 499, error: "client_closed" });
        // Nobody is listening; this response is never sent.
        return new Response(null, { status: 499 });
      }
      return fail(502, "upstream_unreachable", "Could not reach OpenRouter.");
    }

    log.write({
      ...entry,
      status: upstream.status,
      generationId: upstream.headers.get("x-generation-id"),
      upstreamMs: Math.round(performance.now() - started),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream),
    });
  };
}
