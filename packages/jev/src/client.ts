import type { DecisionQuestion, DecisionState, DecisionsResponse } from "./types.js";
import { validateDecisionsResponse } from "./validate.js";

export interface DecideRequest {
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
  /** Overrides the client's default deadline for this call. */
  deadlineMs?: number;
  /** Sent as `session_id` (truncated to 256 characters), to help match calls up when debugging. */
  sessionId?: string;
  /** Aborts the call, e.g. when the client that caused it disconnects. */
  signal?: AbortSignal;
}

export type DecideFailure =
  | { kind: "timeout"; latencyMs: number }
  | { kind: "aborted"; latencyMs: number }
  | { kind: "http"; status: number; message: string; latencyMs: number }
  | { kind: "network"; message: string; latencyMs: number }
  | { kind: "invalid_response"; message: string; latencyMs: number };

/**
 * The result of one Jev call. Failures are values, not exceptions, so callers must decide
 * how to fail open (the routing policy falls back to a static tier).
 */
export type DecideResult =
  | { ok: true; response: DecisionsResponse; latencyMs: number }
  | { ok: false; error: DecideFailure };

/** Everything outside this package talks to Jev through this interface. */
export interface JevClient {
  decide(request: DecideRequest): Promise<DecideResult>;
}

export interface JevClientOptions {
  apiKey: string;
  /** Pin a dated version for stable thresholds; the `~typesafe/jev-latest` alias can move. */
  model?: string;
  baseUrl?: string;
  deadlineMs?: number;
  /** Extra request headers, e.g. OpenRouter app attribution. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export const DEFAULT_JEV_MODEL = "typesafe/jev-1.14";
export const DEFAULT_DECISIONS_BASE_URL = "https://openrouter.ai/api/alpha";
/** Above Jev's measured p95 (about 1.2 s), so slow calls fail open rather than common ones. */
export const DEFAULT_DEADLINE_MS = 1500;
/** The Decisions API rejects longer `session_id` values. */
export const MAX_SESSION_ID_CHARS = 256;

const MAX_ERROR_CHARS = 300;

function errorMessage(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message.trim() !== "") {
      return message.trim().slice(0, MAX_ERROR_CHARS);
    }
  } catch {
    // Not JSON; fall through.
  }
  return `HTTP ${status}`;
}

/**
 * A {@link JevClient} that calls `POST {baseUrl}/decisions` with plain `fetch`.
 *
 * Every call settles within its deadline, even if `fetch` ignores the abort signal: the result is
 * a race between the call and a timer. Errors are returned, never thrown.
 */
export function createJevClient(options: JevClientOptions): JevClient {
  const model = options.model ?? DEFAULT_JEV_MODEL;
  const url = `${(options.baseUrl ?? DEFAULT_DECISIONS_BASE_URL).replace(/\/+$/, "")}/decisions`;
  const doFetch = options.fetch ?? fetch;

  return {
    async decide(request) {
      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);
      const deadlineMs = request.deadlineMs ?? options.deadlineMs ?? DEFAULT_DEADLINE_MS;
      const controller = new AbortController();
      const onAbort = () => controller.abort(request.signal?.reason);
      if (request.signal?.aborted) return { ok: false, error: { kind: "aborted", latencyMs: 0 } };
      request.signal?.addEventListener("abort", onAbort, { once: true });

      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<DecideResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort(new Error("deadline"));
          resolve({ ok: false, error: { kind: "timeout", latencyMs: elapsed() } });
        }, deadlineMs);
      });
      const aborted = new Promise<DecideResult>((resolve) => {
        controller.signal.addEventListener("abort", () => {
          if (request.signal?.aborted) {
            resolve({ ok: false, error: { kind: "aborted", latencyMs: elapsed() } });
          }
        });
      });

      const call = async (): Promise<DecideResult> => {
        const names = Object.keys(request.questions);
        const body: Record<string, unknown> = {
          model,
          state: request.state,
          questions: request.questions,
        };
        if (request.sessionId) body.session_id = request.sessionId.slice(0, MAX_SESSION_ID_CHARS);
        let res: Response;
        let text: string;
        try {
          res = await doFetch(url, {
            method: "POST",
            headers: {
              ...options.headers,
              authorization: `Bearer ${options.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          text = await res.text();
        } catch (error) {
          return {
            ok: false,
            error: { kind: "network", message: String(error), latencyMs: elapsed() },
          };
        }
        if (!res.ok) {
          return {
            ok: false,
            error: {
              kind: "http",
              status: res.status,
              message: errorMessage(text, res.status),
              latencyMs: elapsed(),
            },
          };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return {
            ok: false,
            error: { kind: "invalid_response", message: "not JSON", latencyMs: elapsed() },
          };
        }
        const valid = validateDecisionsResponse(parsed, names);
        if (!valid.ok) {
          return {
            ok: false,
            error: {
              kind: "invalid_response",
              message: `bad ${valid.problems.join(", ")}`,
              latencyMs: elapsed(),
            },
          };
        }
        return { ok: true, response: valid.response, latencyMs: elapsed() };
      };

      try {
        return await Promise.race([call(), deadline, aborted]);
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
