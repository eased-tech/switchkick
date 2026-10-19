import { createHash } from "node:crypto";
import {
  type Guard,
  isTier,
  jevState,
  type Policy,
  planRoute,
  ROUTING_QUESTIONS,
  type RouteDecision,
  readVerdict,
  SessionStore,
  type Tier,
} from "@switchkick/core";
import type { DecideFailure, JevClient } from "@switchkick/jev";
import type { TierTargetConfig } from "./config.js";
import type { ApiFormat } from "./formats.js";
import { analyzeTurn } from "./turns.js";

/** Settings for local mode, where switchkick asks Jev which tier each human turn needs. */
export interface LocalRoute {
  jev: JevClient;
  policy: Policy;
  tiers: Record<Tier, TierTargetConfig>;
  /** Where every request goes once a session has shown a secret. */
  trusted: TierTargetConfig;
  /** Requested-model patterns (`*` wildcards) mapped to the OpenRouter model to pin. */
  modelPins?: Record<string, string>;
  /** Characters of conversation text Jev sees. */
  requestChars?: number;
  maxSessions?: number;
  /** Clock, for tests. */
  now?: () => number;
  /** Called when a Jev call fails, e.g. to warn about a bad key. */
  onJevError?: (failure: DecideFailure) => void;
}

/** The request header that overrides the tier of a single request. */
export const TIER_HEADER = "x-switchkick-tier";
/** The request header that names the session a request belongs to. */
export const SESSION_HEADER = "x-switchkick-session";

/** What the decision log records about a Jev call. Never any of the text Jev saw. */
export type JevLog =
  | {
      /** The dated model that answered. */
      model: string;
      /** Jev's tier after the guards, before the session's ratchet. */
      tier: Tier;
      /** The accepted pick before the guards. */
      pick: Tier;
      guards: Guard[];
      probabilities: Record<Tier, number>;
      sensitive: number;
      selfRouting: number;
      latencyMs: number;
      cost: number | null;
    }
  | {
      error: DecideFailure["kind"];
      status?: number;
      message?: string;
      latencyMs: number;
    };

export interface LocalLogFields {
  tier: Tier | null;
  model: string;
  effort: string | null;
  reason: string;
  turn: RouteDecision["turn"];
  /** A short hash identifying the session, so its requests can be grouped. */
  session: string;
  /** The kind of secret found in this request's message, never the secret. */
  secret?: string;
  idleReset?: true;
  /** Null when Jev wasn't asked. */
  jev: JevLog | null;
}

export type LocalResult =
  | { ok: true; model: string; effort?: TierTargetConfig["effort"]; log: LocalLogFields }
  | {
      /** `policy.failClosed` refused the request after Jev failed. Nothing was sent upstream. */
      ok: false;
      log: Omit<LocalLogFields, "model" | "effort">;
      failure: DecideFailure;
    };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Compiles `*` wildcard patterns, matching the whole requested model name. */
function compilePins(pins: Record<string, string>): [RegExp, string][] {
  return Object.entries(pins).map(([pattern, model]) => {
    const source = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return [new RegExp(`^${source}$`), model];
  });
}

/** Serializes work per key, so one session's requests are planned one at a time. */
function keyedQueue() {
  const tails = new Map<string, Promise<void>>();
  return async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    let release = () => {};
    const tail = previous.then(() => new Promise<void>((resolve) => (release = resolve)));
    tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

/** The request's tier header, if it names a tier. */
export function headerTier(value: string | undefined): Tier | null {
  const tier = value?.trim().toLowerCase();
  return isTier(tier) ? tier : null;
}

export interface LocalRequest {
  format: ApiFormat;
  body: Record<string, unknown>;
  header(name: string): string | undefined;
  signal: AbortSignal;
}

export interface LocalRouter {
  route(request: LocalRequest): Promise<LocalResult>;
  /** Sessions currently remembered. */
  readonly sessions: SessionStore;
}

/**
 * Local mode. For each request: work out the turn and session, apply the hard rules, ask Jev
 * when a human turn needs a decision, and remember the session's tier.
 *
 * Sessions are keyed, first match wins, by the `x-switchkick-session` header, Claude Code's session
 * id, or a hash of `prompt_cache_key`, the system prompt, the first user message and the client's
 * API key. Only hashes are kept.
 */
export function createLocalRouter(options: LocalRoute, envTier: Tier | null = null): LocalRouter {
  const sessions = new SessionStore(options.maxSessions);
  const pins = compilePins(options.modelPins ?? {});
  const now = options.now ?? Date.now;
  const requestChars = options.requestChars ?? 24_000;
  const serialize = keyedQueue();

  const pinFor = (requested: unknown): string | null => {
    if (typeof requested !== "string" || requested === "") return null;
    for (const [pattern, model] of pins) if (pattern.test(requested)) return model;
    return requested.includes("/") ? requested : null;
  };

  return {
    sessions,
    async route({ format, body, header, signal }) {
      const info = analyzeTurn(format, body);
      const named = header(SESSION_HEADER)?.trim() || info.clientSession;
      const credential = header("authorization") ?? header("x-api-key") ?? "";
      const key = sha256(
        named
          ? `named\0${named}`
          : `derived\0${info.cacheKey ?? ""}\0${info.system}\0${info.firstUser}\0${sha256(credential)}`,
      );
      const sessionId = key.slice(0, 12);
      // With a named session, the system prompt tells the main conversation from subagents.
      const root = named ? sha256(info.system).slice(0, 16) : null;

      return serialize(key, async () => {
        const plan = planRoute(
          {
            turn: info.turn,
            text: info.text,
            root,
            firstMessage: info.humanMessages === 1,
            pin: pinFor(body.model),
            headerTier: headerTier(header(TIER_HEADER)),
            envTier,
            now: now(),
          },
          sessions.get(key),
          options.policy,
        );

        let jev: JevLog | null = null;
        let failure: DecideFailure | null = null;
        let routed: ReturnType<Extract<typeof plan, { kind: "ask" }>["complete"]>;
        if (plan.kind === "done") {
          routed = plan;
        } else {
          const result = await options.jev.decide({
            state: jevState(plan.text, info.previous, requestChars),
            questions: ROUTING_QUESTIONS,
            sessionId,
            signal,
          });
          const verdict = result.ok ? readVerdict(result.response.answers) : null;
          if (result.ok && verdict === null) {
            failure = {
              kind: "invalid_response",
              message: "unexpected answers",
              latencyMs: result.latencyMs,
            };
          } else if (!result.ok) {
            failure = result.error;
          }
          if (failure) {
            jev = {
              error: failure.kind,
              ...("status" in failure ? { status: failure.status } : {}),
              ...(failure.kind === "http" ? { message: failure.message } : {}),
              latencyMs: failure.latencyMs,
            };
            if (failure.kind !== "aborted") options.onJevError?.(failure);
          }
          routed = plan.complete(verdict);
          if (result.ok && verdict && routed?.decision.jev) {
            jev = {
              model: result.response.model,
              ...routed.decision.jev,
              probabilities: verdict.probabilities,
              sensitive: verdict.sensitive,
              selfRouting: verdict.selfRouting,
              latencyMs: result.latencyMs,
              cost: result.response.usage.cost ?? null,
            };
          }
        }

        if (routed === null) {
          const log = {
            tier: null,
            reason: "fail_closed",
            turn: info.turn,
            session: sessionId,
            jev,
          };
          return { ok: false, log, failure: failure as DecideFailure };
        }
        if (routed.session) sessions.set(key, routed.session);
        const { decision } = routed;
        const target =
          decision.target === "pin"
            ? { model: decision.model as string }
            : decision.target === "trusted"
              ? options.trusted
              : options.tiers[decision.tier as Tier];
        return {
          ok: true,
          model: target.model,
          ...(target.effort ? { effort: target.effort } : {}),
          log: {
            tier: decision.tier,
            model: target.model,
            effort: target.effort ?? null,
            reason: decision.reason,
            turn: decision.turn,
            session: sessionId,
            ...(decision.secret ? { secret: decision.secret } : {}),
            ...(decision.idleReset ? { idleReset: true as const } : {}),
            jev,
          },
        };
      });
    },
  };
}
