import type { DecisionQuestion, DecisionState, DecisionsResponse } from "./types.js";

export interface DecideRequest {
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
  /** Overrides the client's default deadline for this call. */
  deadlineMs?: number;
  sessionId?: string;
}

export type DecideFailure =
  | { kind: "timeout"; latencyMs: number }
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
}

export const DEFAULT_JEV_MODEL = "typesafe/jev-1.14";
export const DEFAULT_DECISIONS_BASE_URL = "https://openrouter.ai/api/alpha";
