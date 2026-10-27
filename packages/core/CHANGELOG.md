# @switchkick/core

## 0.3.0

### Minor Changes

- [#28](https://github.com/eased-tech/switchkick/pull/28) [`0b88ffa`](https://github.com/eased-tech/switchkick/commit/0b88ffa0b83751f5f7d6b6eb36b099788d87ba4f) Thanks [@anuragit15](https://github.com/anuragit15)! - Local mode now makes one Jev call per message when a client retries a request. A request that repeats the conversation its session last decided, within 5 minutes, gets the same tier and is logged with `reason: retry`. Before, each retry was decided again: one Codex turn made 6 Jev calls, and in `ratchet` mode a retry could raise the session's tier partway through a turn. `planRoute` takes a new optional `conversation` fingerprint, `SessionState` has an optional `decided` field, and `RETRY_WINDOW_MS` is exported.
  
  Codex's `session-id` header now names the session, as Claude Code's session id already did. Codex subagents send their parent's id, so they inherit the parent's tier instead of starting a session of their own and costing a Jev call. The header only counts on requests from Codex (an `originator` starting with `codex`, or an `x-codex-window-id` header), since other clients may use `session-id` for something other than one conversation.

- [#25](https://github.com/eased-tech/switchkick/pull/25) [`f84a012`](https://github.com/eased-tech/switchkick/commit/f84a01279fc35d950634db09251448b5c43081ce) Thanks [@anuragit15](https://github.com/anuragit15)! - Local mode's default `policy.accept.fast` is now 0.80 (it was 0.85), chosen with a new set of 206 labelled prompts for `switchkick eval`. Simple requests that Jev is 80–85% sure of now go to the fast tier instead of balanced. Configs that set `accept.fast` keep their value. The tuning guide at https://eased-tech.github.io/switchkick/guides/tuning/ shows the numbers, and notes that `accept.frontier` has no effect.

## 0.2.0

No changes in this release.
