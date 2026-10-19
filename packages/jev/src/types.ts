/**
 * Wire types for OpenRouter's Decisions API: `POST https://openrouter.ai/api/alpha/decisions`.
 *
 * Verified against the OpenRouter API reference on 2026-10-19 (see docs/adr/0001-jev-transport.md).
 * The endpoint is alpha, so nothing outside this package should depend on these shapes directly.
 */

/** Plain text, structured JSON, or a mixed array (strings and images) describing the situation. */
export type DecisionState = string | Record<string, unknown> | DecisionStatePart[];

export type DecisionStatePart =
  | string
  | Record<string, unknown>
  | { type: "image_url"; image_url: { url: string } };

/** Free-form guidance. Jev accepts a string, an object, or an array. */
export type Guidance = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
  type: "noul";
  instructions: Guidance;
  criteria?: { true?: Guidance; false?: Guidance };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: Guidance;
  /** Option name → description. */
  criteria: Record<string, Guidance> | null;
}

export interface ScoreQuestion {
  type: "score";
  instructions: Guidance;
  /** Ordered levels; index 0 is the lowest. */
  criteria: Guidance[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface DecisionsRequest {
  /** e.g. `typesafe/jev-1.14` or the moving alias `~typesafe/jev-latest`. */
  model: string;
  state: DecisionState;
  /** Keyed by a caller-chosen question name; answers come back under the same keys. */
  questions: Record<string, DecisionQuestion>;
  session_id?: string;
  user?: string;
}

export interface NoulAnswer {
  type: "noul";
  /** Probability that the statement is true. Noul answers carry no `confidence`. */
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted level index. */
  score: number;
  confidence?: number;
  /** Level index (as a string) → probability. */
  probabilities?: Record<string, number>;
  legend?: Record<string, Guidance>;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionsResponse {
  /** Prefixed `gen-dec-`. */
  id?: string;
  /** The resolved, dated model id, e.g. `typesafe/jev-1.13-20260917`. */
  model: string;
  provider?: string;
  answers: Record<string, DecisionAnswer>;
  usage: { input_tokens: number; output_tokens: number; cost?: number };
}
