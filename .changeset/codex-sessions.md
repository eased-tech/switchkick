---
"switchkick": patch
"@switchkick/core": minor
---

Local mode now makes one Jev call per message when a client retries a request. A request that repeats the conversation its session last decided, within 5 minutes, gets the same tier and is logged with `reason: retry`. Before, each retry was decided again: one Codex turn made 6 Jev calls, and in `ratchet` mode a retry could raise the session's tier partway through a turn. `planRoute` takes a new optional `conversation` fingerprint, `SessionState` has an optional `decided` field, and `RETRY_WINDOW_MS` is exported.

Codex's `session-id` header now names the session, as Claude Code's session id already did. Codex subagents send their parent's id, so they inherit the parent's tier instead of starting a session of their own and costing a Jev call. The header only counts on requests from Codex (an `originator` starting with `codex`, or an `x-codex-window-id` header), since other clients may use `session-id` for something other than one conversation.
