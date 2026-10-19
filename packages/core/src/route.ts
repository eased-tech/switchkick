import { type Guard, type Policy, tierFromVerdict } from "./policy.js";
import type { JevVerdict } from "./questions.js";
import { findSecret } from "./secrets.js";
import type { SessionState } from "./session.js";
import { parseTierTag } from "./tags.js";
import { maxTier, type Tier, TOP_TIER, tierRank } from "./tier.js";

/**
 * - `human`: the request answers a new message from the user.
 * - `inherit`: a step inside a turn, e.g. returning a tool result.
 * - `side_call`: a small request the client makes on its own, e.g. generating a title.
 */
export type TurnKind = "human" | "inherit" | "side_call";

/** Where an override came from: a tag in the message, a request header, or the environment. */
export type OverrideSource = "tag" | "header" | "env";

export interface RouteInput {
  turn: TurnKind;
  /**
   * The latest human message. For `inherit` requests, the message that started the turn; it is
   * only read when the session has no tier yet, e.g. after a restart.
   */
  text: string | null;
  /** Identifies the request's conversation within a session; see {@link SessionState.root}. */
  root: string | null;
  /**
   * The request's conversation holds exactly one human message. With a different {@link root},
   * such a request is a subagent starting work; a longer conversation is the main one.
   */
  firstMessage: boolean;
  /** The OpenRouter model the client pinned, already resolved; null when not pinned. */
  pin: string | null;
  /** From the `x-switchkick-tier` header. Applies to every request that carries it. */
  headerTier: Tier | null;
  /** From `SWITCHKICK_TIER`. Applies to every request. */
  envTier: Tier | null;
  /** Milliseconds since the epoch. */
  now: number;
}

/**
 * Why a request went where it did:
 * - `pin`: the client asked for a specific model.
 * - `tag`, `header`, `env`: a tier override.
 * - `secret`: the session holds a secret, so the request goes to the trusted model.
 * - `inherit`, `subagent`, `side_call`: no new human turn; the session's tier applies.
 * - `sticky`: `sticky` mode keeps the session's first decision.
 * - `ratchet_max`: the session is already at the top tier, so Jev wasn't asked.
 * - `jev`: Jev's answer, after thresholds and guards.
 * - `ratchet`: Jev or an override chose lower than the session's tier, which was kept.
 * - `fail_open`: Jev failed or timed out.
 */
export type RouteReason =
  | "pin"
  | OverrideSource
  | "secret"
  | "inherit"
  | "subagent"
  | "side_call"
  | "sticky"
  | "ratchet_max"
  | "jev"
  | "ratchet"
  | "fail_open";

export interface RouteDecision {
  /** Send to the tier's model, the trusted model, or the pinned model. */
  target: "tier" | "trusted" | "pin";
  /** The routed tier. Null for pins. */
  tier: Tier | null;
  /** The pinned model, for `target: "pin"`. */
  model?: string;
  reason: RouteReason;
  /** The request's turn kind, with subagents told apart from other inherited requests. */
  turn: TurnKind | "subagent";
  /** The kind of secret found in this request's message, if any. */
  secret: string | null;
  /** Jev's own result, when it was asked and answered. */
  jev?: { tier: Tier; pick: Tier; guards: Guard[] };
  /** The session was idle long enough to start afresh. */
  idleReset?: true;
}

export interface Routed {
  decision: RouteDecision;
  /** The session's new state, or null if there is nothing to remember. */
  session: SessionState | null;
}

/**
 * The outcome of planning: either final, or waiting on Jev. `complete` takes Jev's verdict, or
 * null when Jev failed, and returns null only when `failClosed` refuses the request.
 */
export type RoutePlan =
  | ({ kind: "done" } & Routed)
  | {
      kind: "ask";
      /** The message Jev should judge. Never contains a detected secret. */
      text: string;
      complete(verdict: JevVerdict | null): Routed | null;
    };

/**
 * Routes one request. Hard rules come first, in order: a pinned model, a tier override (tag,
 * header, environment), the secret latch, then the session. Jev is asked only when a human turn
 * still needs a decision, and never about a message that contains a secret.
 */
export function planRoute(
  input: RouteInput,
  prior: SessionState | null,
  policy: Policy,
): RoutePlan {
  const { now } = input;
  let session: SessionState | null = prior ? { ...prior } : null;
  let turn: RouteDecision["turn"] = input.turn;
  if (
    turn === "human" &&
    session?.tier != null &&
    session.root !== null &&
    input.root !== null &&
    session.root !== input.root
  ) {
    // A new conversation in the session is a subagent. A conversation already several messages
    // long is the main one, so the session follows it, whichever conversation arrived first.
    if (input.firstMessage) turn = "subagent";
    else session = { ...session, root: input.root };
  }
  // An inherited request with nothing to inherit (e.g. after a restart) decides from the message
  // that started its turn.
  const deciding = turn === "human" || (turn === "inherit" && session?.tier == null);

  let idleReset = false;
  if (deciding && session?.tier != null && now - session.lastSeenAt > policy.idleResetMs) {
    session = { ...session, tier: null, provisional: false };
    idleReset = true;
  }

  const secret = deciding && input.text ? findSecret(input.text) : null;
  if (secret !== null) {
    session = { ...(session ?? newSession(now, input.root)), trusted: true };
  }
  const touched = session && { ...session, lastSeenAt: now, root: session.root ?? input.root };
  const base = { turn, secret, ...(idleReset ? { idleReset: true as const } : {}) };

  if (input.pin !== null) {
    return {
      kind: "done",
      decision: { ...base, target: "pin", tier: null, model: input.pin, reason: "pin" },
      session: touched,
    };
  }

  const tag = deciding && input.text ? parseTierTag(input.text) : null;
  const override =
    (tag && { tier: tag.tier, source: "tag" as const, force: tag.force }) ||
    (input.headerTier && { tier: input.headerTier, source: "header" as const, force: false }) ||
    (input.envTier && { tier: input.envTier, source: "env" as const, force: false }) ||
    null;
  const current = session?.tier ?? null;
  const target = session?.trusted ? "trusted" : "tier";

  if (!deciding) {
    // A step inside a turn: keep the session's tier, raised for this request by an override.
    let tier = current ?? policy.defaultTier;
    let reason: RouteReason = turn as "inherit" | "subagent" | "side_call";
    if (override) {
      const raised = policy.session === "ratchet" ? maxTier(tier, override.tier) : override.tier;
      if (raised !== tier || policy.session !== "ratchet") reason = override.source;
      tier = raised;
    }
    return { kind: "done", decision: { ...base, target, tier, reason }, session: touched };
  }

  const settle = (
    decided: Tier,
    reason: RouteReason,
    options: { provisional?: boolean; force?: boolean; jev?: RouteDecision["jev"] } = {},
  ): Routed => {
    let tier = decided;
    let why = reason;
    if (
      policy.session === "ratchet" &&
      !options.force &&
      current !== null &&
      tierRank(current) > tierRank(decided)
    ) {
      tier = current;
      why = "ratchet";
    }
    const next: SessionState = {
      ...(session ?? newSession(now, input.root)),
      tier,
      provisional: options.provisional ?? false,
      lastSeenAt: now,
    };
    next.root ??= input.root;
    return {
      decision: {
        ...base,
        target,
        tier,
        reason: why,
        ...(options.jev ? { jev: options.jev } : {}),
      },
      session: next,
    };
  };
  const done = (routed: Routed): RoutePlan => ({ kind: "done", ...routed });

  if (override) return done(settle(override.tier, override.source, { force: override.force }));
  // Never send a session holding a secret to Jev: its tier only matters for the log now.
  if (session?.trusted) {
    return done(settle(current ?? policy.defaultTier, "secret", { provisional: current === null }));
  }
  if (policy.session === "sticky" && current !== null && !session?.provisional) {
    return done(settle(current, "sticky"));
  }
  if (policy.session === "ratchet" && current === TOP_TIER) {
    return done(settle(current, "ratchet_max"));
  }

  return {
    kind: "ask",
    text: input.text ?? "",
    complete(verdict) {
      if (verdict === null) {
        if (policy.failClosed) return null;
        return settle(maxTier(policy.defaultTier, current ?? policy.defaultTier), "fail_open", {
          provisional: true,
        });
      }
      const result = tierFromVerdict(verdict, policy);
      return settle(result.tier, "jev", { jev: result });
    },
  };
}

function newSession(now: number, root: string | null): SessionState {
  return { tier: null, provisional: false, trusted: false, lastSeenAt: now, root };
}
