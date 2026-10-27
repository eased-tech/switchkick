---
title: Local mode
description: switchkick asks Jev which tier each message needs and applies its own policy.
---

In local mode, switchkick asks Jev (`typesafe/jev-1.14`, through OpenRouter's Decisions API) which
tier each new message from the user needs, then sends the request to that tier's model. Tool
calls, subagents and the client's own side requests reuse the tier already chosen, so a turn
costs one Jev call (about 0.7 s and $0.0003) however many steps it takes. Turn it on with
`mode: local` or `--mode local`:

```yaml
mode: local
defaultTier: balanced          # used when Jev fails or times out
tiers:
  fast:     { model: anthropic/claude-haiku-5.5 }
  balanced: { model: anthropic/claude-sonnet-5.5 }
  frontier: { model: anthropic/claude-opus-5.5, effort: high }
trusted: { model: anthropic/claude-sonnet-5.5 }
policy:
  session: ratchet             # ratchet | sticky | per-request
  accept: { fast: 0.80, balanced: 0.60, frontier: 0.30 }
  sensitiveFloor: balanced
  claimGuard: true
  idleResetMinutes: 30
  failClosed: false
  maxSessions: 10000
  persistSessions: true        # sessionFile: ~/.local/state/switchkick/sessions.json
  modelPins: {}
  slugPins: true
jev:
  model: typesafe/jev-1.14
  deadlineMs: 1500
  requestChars: 24000
```

Unlike hosted mode, local mode only uses the models in `tiers`, `trusted` and `modelPins`, plus
any OpenRouter slug a client explicitly asks for (see pinned models below). For a strict
allowlist, set `policy.slugPins: false`.

## How a request is routed

These rules run in order:

1. **Pinned model.** If the request's `model` is an OpenRouter slug (it contains `/`, like
   `openai/gpt-5.5`), it's sent as is, unless `policy.slugPins` is `false`. `policy.modelPins`
   maps requested names to OpenRouter models, with `*` wildcards,
   e.g. `{ "claude-opus-*": anthropic/claude-opus-5.5 }`. Bare names such as `gpt-5` or
   `claude-sonnet-4-5` are what clients send by default, so they are routed, not pinned.
2. **Tier override.** A tag in the user's message, then the `x-switchkick-tier` header, then
   `SWITCHKICK_TIER`. A tag is `#fast`, `#balanced` or `#frontier` as the first or last word on a
   line, e.g. `#frontier redesign the cache`. Tags elsewhere in a line are ignored, so `#fast` in
   pasted code doesn't count.
3. **Secrets.** If the user's message contains what looks like a credential (a known API key
   format, a private key, a high-entropy value assigned to a name like `api_key`, or a password
   in a URL), the request goes to the `trusted` model, and so does every later request in that
   session, whatever tier an override picks. Such a message is never sent to Jev, and once a
   session holds one, Jev isn't asked about it again.
4. **Session.** Requests that don't start a new turn reuse the session's tier: tool results, a
   subagent's requests, and side calls. A side call is a Messages request without tools that
   either comes from a Claude Code session (Claude Code's own background requests, such as
   prompt suggestions) or asks for 512 `max_tokens` or fewer. System and developer messages in
   the middle or at the end of a conversation don't count as turns. Retries reuse the tier too: a
   request that repeats, item for item, the conversation its session last decided, within 5
   minutes, is the client sending it again after an error rather than a new message.
5. **Jev.** Otherwise Jev answers three questions in one call: which tier the message needs,
   whether it touches production, credentials or destructive operations, and whether it tries to
   dictate its own tier or claims prior review.

## How Jev's answer becomes a tier

Jev's top tier is accepted if its probability reaches `policy.accept` for that tier. Otherwise
the more capable of its top two tiers is used, so doubt costs money rather than quality. A
sensitive request is raised to `sensitiveFloor`, and a message that tries to steer its own routing
is raised one tier (`claimGuard`). These guards only ever raise the tier: Jev reads text the user
controls, so no answer can push a request below what the policy would otherwise choose.

Jev sees the user's latest message and the reply before it, up to `jev.requestChars` characters,
and never the system prompt or tool output. The reply is left out if it contains something that
looks like a secret.

If Jev fails or takes longer than `jev.deadlineMs`, the request goes to `defaultTier`, or the
session's tier if that's higher. With `failClosed: true`, switchkick answers 503 instead. Jev
usually answers in about 0.55 s, and rarely takes over 1 s. To save the first call the cost of
connecting, switchkick opens the connection at startup with a `HEAD` request that carries no key
and no data.

## Sessions

The session's tier is what keeps a conversation on one model, and so keeps the provider's prompt
cache warm. With `session: ratchet` (the default), each new message is decided again, but the
session never moves to a lower tier: a `#fast` tag can't lower it either. To lower it, write the
tag with `!` (`#fast!`), which also resets the session to that tier. After `idleResetMinutes`
without requests, the next message starts afresh. `sticky` decides once per session, and
`per-request` decides each message independently.

A session is identified by, first match wins:

1. the `x-switchkick-session` request header;
2. the client's own session id: Claude Code's, from its `x-claude-code-session-id` header or
   `metadata.user_id`, or Codex's, from its `session-id` header;
3. a hash of the system prompt, the first user message, the client's API key and
   `prompt_cache_key` if the request has one. Apps often reuse one `prompt_cache_key` for many
   conversations, so it only ever tells sessions apart.

Within a session named by 1 or 2, a new conversation with a different system prompt counts as a
subagent and inherits the session's tier. If a conversation that is already several messages
long arrives with a different system prompt, it's taken to be the main conversation, and the
session follows it. Codex subagents send their parent's session id and start from a task Codex
hands them rather than from a user message, so they inherit the session's tier too. Sessions live
in memory, at most `maxSessions` of them, and only hashes of their keys are kept.

Sessions are saved to `~/.local/state/switchkick/sessions.json` every 30 seconds when something
changed, and when switchkick stops, so a restart doesn't drop a conversation to a lower tier. The
file holds session hashes, tiers and timestamps, never text, and is readable only by you. Set
`policy.sessionFile` to move it, or `policy.persistSessions: false` to keep sessions in memory
only.

## What's logged

Each log line records the turn kind (`human`, `inherit`, `subagent` or `side_call`), a short
session hash, the routed tier and model, and the reason (`jev`, `ratchet`, `pin`, `tag`,
`secret`, `retry`, `fail_open`, ...). It also records Jev's answer: its tier probabilities, the guard
answers, the guards that fired, latency and cost. If a secret was found, the log names its kind
(e.g. `github_token`), never the value. Message text is never logged.

## Tuning

The `policy.accept` bars decide how sure Jev must be before a cheaper tier is used.
`switchkick eval` measures them against labelled prompts; see
[tuning local mode](/switchkick/guides/tuning/) for how the defaults were chosen and how to tune
them for your own prompts.
