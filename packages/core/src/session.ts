import type { Tier } from "./tier.js";

/** What switchkick remembers about one conversation. */
export interface SessionState {
  /** The session's tier. Null until a human turn has been decided. */
  tier: Tier | null;
  /** The tier came from a fallback rather than a decision, so `sticky` mode decides again. */
  provisional: boolean;
  /** A secret was seen: every request goes to the trusted model from now on. */
  trusted: boolean;
  /** Milliseconds since the epoch. */
  lastSeenAt: number;
  /**
   * Identifies the conversation that started the session, when the client names the session
   * itself. Requests in the same session from a different conversation are subagents.
   */
  root: string | null;
}

export const DEFAULT_MAX_SESSIONS = 10_000;

/** In-memory session states, evicting the least recently used beyond `maxSessions`. */
export class SessionStore {
  readonly #sessions = new Map<string, SessionState>();
  readonly #max: number;

  constructor(maxSessions = DEFAULT_MAX_SESSIONS) {
    this.#max = Math.max(1, maxSessions);
  }

  get size(): number {
    return this.#sessions.size;
  }

  get(key: string): SessionState | null {
    const state = this.#sessions.get(key);
    if (state === undefined) return null;
    this.#sessions.delete(key);
    this.#sessions.set(key, state);
    return state;
  }

  set(key: string, state: SessionState): void {
    this.#sessions.delete(key);
    this.#sessions.set(key, state);
    while (this.#sessions.size > this.#max) {
      const oldest = this.#sessions.keys().next().value as string;
      this.#sessions.delete(oldest);
    }
  }
}
