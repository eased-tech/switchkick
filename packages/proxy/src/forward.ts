import { parseTierTag, type Tier } from "@switchkick/core";
import type { Context, Handler } from "hono";
import type { Effort } from "./config.js";
import { applyEffort } from "./effort.js";
import { type ApiFormat, type ErrorKind, errorBody, UPSTREAM_PATHS } from "./formats.js";
import {
  COST_TIER_FOR,
  type HostedRoute,
  JEV_ROUTER_MODEL,
  prepareHostedBody,
  withoutRouterPlugin,
} from "./hosted.js";
import { headerTier, type LocalRouter, TIER_HEADER } from "./local.js";
import type { DecisionLog, DecisionLogEntry } from "./log.js";
import { createScanner, routerDecision } from "./metadata.js";
import { analyzeTurn } from "./turns.js";

/** Where a request goes in static mode: one tier, one model, and optionally an effort. */
export interface StaticRoute {
  tier: Tier;
  model: string;
  /** Replaces the client's reasoning effort when set. */
  effort?: Effort;
}

export interface ForwardOptions {
  apiKey: string;
  /** Where requests go in static mode, and in hosted mode when the router is unavailable. */
  route: StaticRoute;
  /** Set for hosted mode: OpenRouter's Jev router picks the model. */
  hosted: HostedRoute | null;
  /** Set for local mode: switchkick asks Jev and applies its own policy. */
  local: LocalRouter | null;
  /**
   * `SWITCHKICK_TIER`: the tier for every request in local mode, or the router's matching
   * `cost_tier` in hosted mode.
   */
  envTier: Tier | null;
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

function upstreamHeaders(c: Context, options: ForwardOptions, metadata: boolean): Headers {
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
  // Asks OpenRouter to report the router's decision in the response.
  if (metadata) headers.set("x-openrouter-metadata", "enabled");
  return headers;
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) headers.set(name, value);
  });
  return headers;
}

/** Failure codes meaning OpenRouter was reachable but too slow, rather than unreachable. */
const TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT"]);

/**
 * The first error code in a fetch failure's cause chain. fetch rejects with a bare
 * `TypeError: fetch failed`; the reason (`ECONNREFUSED`, `UND_ERR_HEADERS_TIMEOUT`, ...) is
 * nested in `cause`, sometimes inside an AggregateError.
 */
export function failureCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    const errors = (current as { errors?: unknown }).errors;
    current = (current as { cause?: unknown }).cause ?? (Array.isArray(errors) ? errors[0] : null);
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The longest upstream error message quoted back to the client. */
const MAX_QUOTED_ERROR = 500;

/** The message from an OpenRouter error body, which the client sees inside switchkick's error. */
async function upstreamMessage(upstream: Response): Promise<string> {
  let text: string;
  try {
    text = await upstream.text();
  } catch {
    return `HTTP ${upstream.status}`;
  }
  let message: unknown;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isPlainObject(parsed) && isPlainObject(parsed.error)) message = parsed.error.message;
  } catch {
    // Not JSON; fall through.
  }
  const result = typeof message === "string" && message.trim() !== "" ? message.trim() : null;
  if (result === null) return `HTTP ${upstream.status}`;
  return result.length > MAX_QUOTED_ERROR ? `${result.slice(0, MAX_QUOTED_ERROR)}…` : result;
}

/**
 * Pipes `body` through unchanged, calling `onChunk` with each chunk after it is passed on and
 * `onDone` exactly once: when the body ends, fails, or the client cancels it. Cancelling also
 * cancels the upstream body.
 */
function tap(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void,
  onDone: (outcome: "end" | "error" | "cancel") => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let done = false;
  const finish = (outcome: "end" | "error" | "cancel") => {
    if (done) return;
    done = true;
    onDone(outcome);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (error) {
        finish("error");
        controller.error(error);
        return;
      }
      if (result.done) {
        finish("end");
        controller.close();
        return;
      }
      controller.enqueue(result.value);
      onChunk(result.value);
    },
    cancel(reason) {
      finish("cancel");
      return reader.cancel(reason);
    },
  });
}

/**
 * Handles one client request: rewrite it for the routing mode, forward it to the matching
 * OpenRouter endpoint, and stream the response back byte for byte.
 *
 * - **Static:** `model` becomes the tier's model, with its effort if set.
 * - **Local:** the local router picks the tier (or a pinned or trusted model) first; then as static.
 * - **Hosted:** `model` becomes the Jev router, with the plugin entry added. The response is read
 *   on its way through for the router's decision, and the log line is written when it ends. If
 *   the router is unavailable (503), the request is retried once in static mode. Its 400 and 404
 *   errors are rewritten to explain which setting to check.
 */
export function forward(format: ApiFormat, options: ForwardOptions): Handler {
  const { route, log, hosted, local } = options;
  const staticFields = {
    tier: route.tier,
    model: route.model,
    effort: route.effort ?? null,
  } as const;

  return async (c) => {
    const started = performance.now();
    const entry: DecisionLogEntry = {
      ts: new Date().toISOString(),
      format,
      stream: false,
      mode: hosted ? "hosted" : local ? "local" : "static",
      ...(hosted ? { tier: null, model: JEV_ROUTER_MODEL, effort: null } : staticFields),
      requestedModel: null,
      reason: hosted ? "hosted" : "static",
      status: 0,
      generationId: null,
      upstreamMs: null,
      ...(hosted?.plugin.cost_tier ? { costTier: hosted.plugin.cost_tier } : {}),
    };
    const warnings: string[] = [];
    const write = (fields: Partial<DecisionLogEntry>) =>
      log.write({ ...entry, ...(warnings.length > 0 ? { warnings } : {}), ...fields });
    const fail = (
      status: 400 | 404 | 502 | 503 | 504,
      kind: ErrorKind,
      message: string,
      param?: string,
      cause?: string,
    ) => {
      write({ status, error: kind, ...(cause ? { cause } : {}) });
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
        warnings.push("store_rewritten");
      }
    }

    const client = body;
    const staticBody = (target: { model: string; effort?: Effort | undefined } = route) => {
      const rewritten = { ...client, model: target.model };
      if (target.effort) applyEffort(format, rewritten, target.effort);
      return rewritten;
    };

    const signal = c.req.raw.signal;
    const search = new URL(c.req.url).search;
    const call = (payload: Record<string, unknown>, metadata: boolean) =>
      options.fetch(`${options.upstreamBaseUrl}${UPSTREAM_PATHS[format]}${search}`, {
        method: "POST",
        headers: upstreamHeaders(c, options, metadata),
        body: JSON.stringify(payload),
        signal,
      });
    const unreachable = (error: unknown): Response => {
      if (signal.aborted) {
        write({ status: 499, error: "client_closed" });
        // Nobody is listening; this response is never sent.
        return new Response(null, { status: 499 });
      }
      const code = failureCode(error) ?? "unknown";
      if (TIMEOUT_CODES.has(code)) {
        return fail(
          504,
          "upstream_timeout",
          `OpenRouter did not respond in time (${code}).`,
          undefined,
          code,
        );
      }
      return fail(
        502,
        "upstream_unreachable",
        `Could not reach OpenRouter (${code}).`,
        undefined,
        code,
      );
    };
    const reply = (upstream: Response, upstreamBody: ReadableStream<Uint8Array> | null) =>
      new Response(upstreamBody, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders(upstream),
      });

    let target: { model: string; effort?: Effort | undefined } = route;
    if (local) {
      const routed = await local.route({ format, body, header: (n) => c.req.header(n), signal });
      Object.assign(entry, routed.log);
      if (!routed.ok) {
        if (signal.aborted) {
          write({ status: 499, error: "client_closed" });
          return new Response(null, { status: 499 });
        }
        return fail(
          503,
          "jev_unavailable",
          `Jev couldn't decide how to route this request (${routed.failure.kind}), and ` +
            "`policy.failClosed` is set in the switchkick config.",
        );
      }
      target = routed;
    }

    if (!hosted) {
      let upstream: Response;
      try {
        upstream = await call(staticBody(target), false);
      } catch (error) {
        return unreachable(error);
      }
      write({
        status: upstream.status,
        generationId: upstream.headers.get("x-generation-id"),
        upstreamMs: Math.round(performance.now() - started),
      });
      return reply(upstream, upstream.body);
    }

    // A tier override picks the router's matching cost tier.
    const tag = parseTierTag(analyzeTurn(format, body).text ?? "");
    const fromHeader = headerTier(c.req.header(TIER_HEADER));
    const override = tag
      ? { tier: tag.tier, source: "tag" }
      : fromHeader
        ? { tier: fromHeader, source: "header" }
        : options.envTier
          ? { tier: options.envTier, source: "env" }
          : null;
    let hostedRoute = hosted;
    if (override) {
      const costTier = COST_TIER_FOR[override.tier];
      hostedRoute = { ...hosted, plugin: { ...hosted.plugin, cost_tier: costTier } };
      Object.assign(entry, { costTier, reason: override.source });
    }
    const prepared = prepareHostedBody(body, hostedRoute);
    if ("error" in prepared) return fail(400, "invalid_request", prepared.error, prepared.param);
    warnings.push(...prepared.warnings);

    let upstream: Response;
    try {
      upstream = await call(prepared.body, true);
      if (upstream.status === 503) {
        // The router is unavailable. One retry in static mode keeps the client working.
        await upstream.body?.cancel().catch(() => {});
        Object.assign(entry, staticFields, { reason: "router_unavailable", fallback: "static" });
        upstream = await call(withoutRouterPlugin(staticBody()), false);
      }
    } catch (error) {
      return unreachable(error);
    }
    entry.status = upstream.status;
    entry.generationId = upstream.headers.get("x-generation-id");
    entry.upstreamMs = Math.round(performance.now() - started);

    if (entry.fallback === undefined && (upstream.status === 400 || upstream.status === 404)) {
      const detail = await upstreamMessage(upstream);
      if (upstream.status === 404) {
        return fail(
          404,
          "router_no_model",
          `OpenRouter's Jev router found no model it may use: ${detail}. Either ` +
            "`hosted.excluded_models` in the switchkick config excludes every model the request " +
            "could go to, or this OpenRouter account has no access to the router.",
        );
      }
      return fail(
        400,
        "router_rejected",
        `OpenRouter's Jev router rejected the request: ${detail}. If this is about the plugin ` +
          "or reasoning settings, check the `hosted` section of the switchkick config.",
      );
    }

    if (upstream.body === null) {
      write({ servedModel: null, router: null });
      return reply(upstream, null);
    }
    const scanner = createScanner(upstream.headers.get("content-type"));
    const tapped = tap(upstream.body, scanner.push, (outcome) => {
      const { servedModel, metadata } = scanner.finish();
      const router = routerDecision(metadata);
      // The router silently ignored `hosted.models`: none of them was in its pool.
      if (router?.listFallback === "models_ignored") warnings.push("models_ignored");
      let error: string | undefined;
      if (outcome === "cancel" || (outcome === "error" && signal.aborted)) error = "client_closed";
      else if (outcome === "error") error = "stream_failed";
      write({ servedModel, router, ...(error ? { error } : {}) });
    });
    return reply(upstream, tapped);
  };
}
