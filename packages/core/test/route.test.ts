import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  type JevVerdict,
  type Policy,
  planRoute,
  RETRY_WINDOW_MS,
  type Routed,
  type RouteInput,
  type RoutePlan,
  type SessionState,
  SessionStore,
  type Tier,
} from "../src/index.js";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

function verdictFor(tier: Tier, extra: Partial<JevVerdict> = {}): JevVerdict {
  const probabilities = { fast: 0, balanced: 0, frontier: 0, [tier]: 1 };
  return { probabilities, sensitive: 0, selfRouting: 0, ...extra };
}

function input(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    turn: "human",
    text: "add a test for the parser",
    root: null,
    firstMessage: false,
    pin: null,
    headerTier: null,
    envTier: null,
    now: NOW,
    ...overrides,
  };
}

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    tier: "balanced",
    provisional: false,
    trusted: false,
    lastSeenAt: NOW - MINUTE,
    root: null,
    ...overrides,
  };
}

function done(plan: RoutePlan): Routed {
  if (plan.kind !== "done") throw new Error("expected a final decision, but Jev was asked");
  return { decision: plan.decision, session: plan.session };
}

function ask(plan: RoutePlan, verdict: JevVerdict | null): Routed | null {
  if (plan.kind !== "ask") throw new Error("expected Jev to be asked");
  return plan.complete(verdict);
}

describe("planRoute", () => {
  it("asks Jev about a new human turn and starts a session", () => {
    const plan = planRoute(input(), null, DEFAULT_POLICY);
    expect(plan).toMatchObject({ kind: "ask", text: "add a test for the parser" });
    expect(ask(plan, verdictFor("fast"))).toEqual({
      decision: {
        target: "tier",
        tier: "fast",
        reason: "jev",
        turn: "human",
        secret: null,
        jev: { tier: "fast", pick: "fast", guards: [] },
      },
      session: { tier: "fast", provisional: false, trusted: false, lastSeenAt: NOW, root: null },
    });
  });

  it("lets inherited requests reuse the session's tier without asking Jev", () => {
    const routed = done(planRoute(input({ turn: "inherit" }), session(), DEFAULT_POLICY));
    expect(routed.decision).toMatchObject({ tier: "balanced", reason: "inherit" });
    expect(routed.session?.lastSeenAt).toBe(NOW);
  });

  it("decides an inherited request from its turn's message when there is no session", () => {
    const plan = planRoute(input({ turn: "inherit" }), null, DEFAULT_POLICY);
    expect(ask(plan, verdictFor("frontier"))?.decision).toMatchObject({
      tier: "frontier",
      reason: "jev",
      turn: "inherit",
    });
  });

  it("treats a new conversation in a named session as a subagent", () => {
    const prior = session({ tier: "frontier", root: "main" });
    const routed = done(
      planRoute(input({ root: "explorer", firstMessage: true }), prior, DEFAULT_POLICY),
    );
    expect(routed.decision).toMatchObject({
      tier: "frontier",
      reason: "subagent",
      turn: "subagent",
    });
    expect(routed.session).toMatchObject({ tier: "frontier", root: "main" });
  });

  it("follows the longer conversation when another one claimed the session first", () => {
    const prior = session({ tier: "balanced", root: "stray" });
    const plan = planRoute(input({ root: "main", firstMessage: false }), prior, DEFAULT_POLICY);
    const routed = ask(plan, verdictFor("frontier"));
    expect(routed?.decision).toMatchObject({ tier: "frontier", reason: "jev", turn: "human" });
    expect(routed?.session?.root).toBe("main");
  });

  it("routes side calls at the session's tier, and doesn't start a session for them", () => {
    const routed = done(planRoute(input({ turn: "side_call" }), null, DEFAULT_POLICY));
    expect(routed).toEqual({
      decision: {
        target: "tier",
        tier: "balanced",
        reason: "side_call",
        turn: "side_call",
        secret: null,
      },
      session: null,
    });
  });

  describe("hard rules", () => {
    it("send a pinned model through, ahead of everything else", () => {
      const routed = done(
        planRoute(input({ pin: "openai/gpt-5.5", headerTier: "fast" }), session(), DEFAULT_POLICY),
      );
      expect(routed.decision).toMatchObject({ target: "pin", model: "openai/gpt-5.5", tier: null });
      expect(routed.session?.tier).toBe("balanced");
    });

    it("let a tag choose the tier without asking Jev", () => {
      const routed = done(
        planRoute(input({ text: "#frontier plan the migration" }), null, DEFAULT_POLICY),
      );
      expect(routed.decision).toMatchObject({ tier: "frontier", reason: "tag" });
    });

    it("prefer a tag over the header, and the header over the environment", () => {
      const both = input({ text: "rename it #fast", headerTier: "frontier", envTier: "balanced" });
      expect(done(planRoute(both, null, DEFAULT_POLICY)).decision.reason).toBe("tag");
      const header = input({ headerTier: "frontier", envTier: "fast" });
      expect(done(planRoute(header, null, DEFAULT_POLICY)).decision).toMatchObject({
        tier: "frontier",
        reason: "header",
      });
      expect(
        done(planRoute(input({ envTier: "fast" }), null, DEFAULT_POLICY)).decision,
      ).toMatchObject({
        tier: "fast",
        reason: "env",
      });
    });

    it("raise an inherited request with a header override, without changing the session", () => {
      const routed = done(
        planRoute(input({ turn: "inherit", headerTier: "frontier" }), session(), DEFAULT_POLICY),
      );
      expect(routed.decision).toMatchObject({ tier: "frontier", reason: "header" });
      expect(routed.session?.tier).toBe("balanced");
    });

    it("send a message with a secret to the trusted model, latch the session, and keep it from Jev", () => {
      const text = `deploy with token ghp_${"aB3dE5fG7h".repeat(4)}`;
      const routed = done(planRoute(input({ text }), session(), DEFAULT_POLICY));
      expect(routed.decision).toMatchObject({
        target: "trusted",
        tier: "balanced",
        reason: "secret",
        secret: "github_token",
      });
      expect(routed.session?.trusted).toBe(true);

      const next = planRoute(input({ text: "now explain it" }), routed.session, DEFAULT_POLICY);
      expect(done(next).decision).toMatchObject({
        target: "trusted",
        reason: "secret",
        secret: null,
      });
      const tool = planRoute(input({ turn: "inherit" }), routed.session, DEFAULT_POLICY);
      expect(done(tool).decision.target).toBe("trusted");
    });

    it("keep the trusted model even when an override picks the tier", () => {
      const prior = session({ trusted: true });
      const routed = done(planRoute(input({ text: "#frontier go" }), prior, DEFAULT_POLICY));
      expect(routed.decision).toMatchObject({ target: "trusted", tier: "frontier", reason: "tag" });
    });
  });

  describe("session modes", () => {
    it("ratchet: a lower decision keeps the session's tier", () => {
      const plan = planRoute(input(), session({ tier: "balanced" }), DEFAULT_POLICY);
      const routed = ask(plan, verdictFor("fast"));
      expect(routed?.decision).toMatchObject({
        tier: "balanced",
        reason: "ratchet",
        jev: { tier: "fast" },
      });
    });

    it("ratchet: a higher decision raises the session", () => {
      const routed = ask(planRoute(input(), session(), DEFAULT_POLICY), verdictFor("frontier"));
      expect(routed?.session?.tier).toBe("frontier");
    });

    it("ratchet: skips Jev once the session is at the top tier", () => {
      const routed = done(planRoute(input(), session({ tier: "frontier" }), DEFAULT_POLICY));
      expect(routed.decision).toMatchObject({ tier: "frontier", reason: "ratchet_max" });
    });

    it("ratchet: a #fast tag can't lower the session", () => {
      const prior = session({ tier: "frontier" });
      const routed = done(planRoute(input({ text: "#fast rename x" }), prior, DEFAULT_POLICY));
      expect(routed.decision).toMatchObject({ tier: "frontier", reason: "ratchet" });
    });

    it("ratchet: #fast! unpins the session and lowers it", () => {
      const prior = session({ tier: "frontier" });
      const routed = done(planRoute(input({ text: "#fast! rename x" }), prior, DEFAULT_POLICY));
      expect(routed.decision).toMatchObject({ tier: "fast", reason: "tag" });
      expect(routed.session?.tier).toBe("fast");
    });

    it("idle reset: after the idle window a human turn can go lower", () => {
      const prior = session({ tier: "frontier", lastSeenAt: NOW - 31 * MINUTE });
      const plan = planRoute(input(), prior, DEFAULT_POLICY);
      const routed = ask(plan, verdictFor("fast"));
      expect(routed?.decision).toMatchObject({ tier: "fast", reason: "jev", idleReset: true });
      expect(routed?.session?.tier).toBe("fast");
    });

    it("idle reset keeps the secret latch", () => {
      const prior = session({ trusted: true, lastSeenAt: NOW - 120 * MINUTE });
      const routed = done(planRoute(input(), prior, DEFAULT_POLICY));
      expect(routed.decision).toMatchObject({ target: "trusted", idleReset: true });
    });

    it("sticky: decides once and keeps it", () => {
      const policy: Policy = { ...DEFAULT_POLICY, session: "sticky" };
      const routed = done(planRoute(input(), session({ tier: "fast" }), policy));
      expect(routed.decision).toMatchObject({ tier: "fast", reason: "sticky" });
    });

    it("sticky: decides again after a fallback", () => {
      const policy: Policy = { ...DEFAULT_POLICY, session: "sticky" };
      const plan = planRoute(input(), session({ provisional: true }), policy);
      expect(ask(plan, verdictFor("fast"))?.decision.tier).toBe("fast");
    });

    it("per-request: each human turn stands alone", () => {
      const policy: Policy = { ...DEFAULT_POLICY, session: "per-request" };
      const plan = planRoute(input(), session({ tier: "frontier" }), policy);
      expect(ask(plan, verdictFor("fast"))?.decision).toMatchObject({
        tier: "fast",
        reason: "jev",
      });
    });
  });

  describe("retries", () => {
    const decided = (at = NOW - MINUTE) => session({ decided: { conversation: "c1", at } });

    it("remember the conversation Jev decided", () => {
      const routed = ask(
        planRoute(input({ conversation: "c1" }), null, DEFAULT_POLICY),
        verdictFor("fast"),
      );
      expect(routed?.session?.decided).toEqual({ conversation: "c1", at: NOW });
    });

    it("reuse the decision for the same conversation within the window, without asking Jev", () => {
      const prior = decided(NOW - RETRY_WINDOW_MS);
      const routed = done(planRoute(input({ conversation: "c1" }), prior, DEFAULT_POLICY));
      expect(routed.decision).toMatchObject({ tier: "balanced", reason: "retry" });
      expect(routed.session?.decided).toEqual({ conversation: "c1", at: NOW });
    });

    it("hold in every session mode, even per-request", () => {
      const policy: Policy = { ...DEFAULT_POLICY, session: "per-request" };
      const routed = done(planRoute(input({ conversation: "c1" }), decided(), policy));
      expect(routed.decision.reason).toBe("retry");
    });

    it("ask Jev again for another conversation, after the window, or without a fingerprint", () => {
      for (const [conversation, prior] of [
        ["c2", decided()],
        ["c1", decided(NOW - RETRY_WINDOW_MS - 1)],
        [null, decided()],
      ] as const) {
        expect(planRoute(input({ conversation }), prior, DEFAULT_POLICY).kind).toBe("ask");
      }
    });

    it("ask Jev again after a fallback, and don't remember the fallback as a decision", () => {
      const prior = session({ provisional: true, decided: { conversation: "c1", at: NOW } });
      const plan = planRoute(input({ conversation: "c1" }), prior, DEFAULT_POLICY);
      expect(ask(plan, null)?.session?.decided).toBeUndefined();
    });

    it("ask Jev again once an idle reset has cleared the session's tier", () => {
      const policy: Policy = { ...DEFAULT_POLICY, idleResetMs: MINUTE };
      const prior = session({
        lastSeenAt: NOW - 2 * MINUTE,
        decided: { conversation: "c1", at: NOW - 2 * MINUTE },
      });
      expect(planRoute(input({ conversation: "c1" }), prior, policy).kind).toBe("ask");
    });

    it("still apply overrides and the secret latch first", () => {
      const tagged = done(
        planRoute(input({ text: "#frontier go", conversation: "c1" }), decided(), DEFAULT_POLICY),
      );
      expect(tagged.decision).toMatchObject({ tier: "frontier", reason: "tag" });
      const latched = done(
        planRoute(
          input({ text: `use ghp_${"aB3dE5fG7h".repeat(4)}`, conversation: "c1" }),
          decided(),
          DEFAULT_POLICY,
        ),
      );
      expect(latched.decision).toMatchObject({ target: "trusted", reason: "secret" });
    });
  });

  describe("fail-open", () => {
    it("uses the default tier, marked provisional", () => {
      const routed = ask(planRoute(input(), null, DEFAULT_POLICY), null);
      expect(routed?.decision).toMatchObject({ tier: "balanced", reason: "fail_open" });
      expect(routed?.session?.provisional).toBe(true);
    });

    it("keeps the session's tier when it is higher", () => {
      const policy: Policy = { ...DEFAULT_POLICY, session: "per-request" };
      const routed = ask(planRoute(input(), session({ tier: "frontier" }), policy), null);
      expect(routed?.decision.tier).toBe("frontier");
    });

    it("refuses the request when failClosed is set", () => {
      const policy: Policy = { ...DEFAULT_POLICY, failClosed: true };
      expect(ask(planRoute(input(), null, policy), null)).toBeNull();
    });
  });
});

describe("SessionStore", () => {
  it("counts changes and lists sessions least recently used first", () => {
    const store = new SessionStore(2);
    const state = session();
    store.set("a", state);
    store.set("b", state);
    store.get("a");
    expect(store.entries().map(([key]) => key)).toEqual(["b", "a"]);
    store.set("c", state);
    expect(store.entries().map(([key]) => key)).toEqual(["a", "c"]);
    expect(store.version).toBe(3);
  });
});
