# switchkick

> **Status: pre-alpha.** All three routing modes work: static (one configured tier), hosted
> (OpenRouter's Jev router picks the model) and local (switchkick asks Jev and applies its own
> policy). The acceptance thresholds in local mode are untuned starting values.

switchkick is a local proxy for coding agents and OpenAI/Anthropic SDK apps. It accepts
OpenAI Chat Completions, OpenAI Responses and Anthropic Messages requests, sends them through
[OpenRouter](https://openrouter.ai), and uses Jev, TypeSafe's decision model, to choose a model
for each human turn. One `OPENROUTER_API_KEY` covers both the routing decision and the model call.

Routing modes:

- **hosted**: OpenRouter's `typesafe/jev-router` chooses the model.
- **local**: switchkick asks Jev directly and applies its own thresholds and guards.
- **static**: a fixed tier. This is also the fallback when Jev is unavailable.

## Usage

```sh
pnpm install && pnpm build
OPENROUTER_API_KEY=sk-or-... node packages/proxy/dist/cli.js serve --tier balanced
```

Instead of setting `OPENROUTER_API_KEY` each time, you can store the key once in the OS
credential store, which switchkick checks next:

```sh
security add-generic-password -s switchkick -a openrouter -w          # macOS Keychain
secret-tool store --label=switchkick service switchkick account openrouter   # Linux
```

Where neither exists, put `OPENROUTER_API_KEY=...` in `~/.config/switchkick/env` and
`chmod 600` it; switchkick refuses to read the file if other users can. At startup switchkick
says which source it used, never the key.

Then point a client at `http://127.0.0.1:8787`:

| Client API | Endpoint | Typical setting |
|---|---|---|
| OpenAI Chat Completions | `POST /v1/chat/completions` | `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` |
| OpenAI Responses | `POST /v1/responses` | `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` |
| Anthropic Messages | `POST /v1/messages` | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` |

switchkick also answers two endpoints itself:

- `GET /v1/models` lists the model requests are routed to, in OpenAI's shape, or in Anthropic's
  when the request has an `anthropic-version` header. `GET /v1/models/{id}` retrieves it.
- `POST /v1/messages/count_tokens` returns an **estimate**, because OpenRouter has no
  token-counting endpoint. It's tuned to overcount, typically by 10–40%, so a client tracking its
  context window compacts a little early rather than overflowing. The response carries
  `x-switchkick-token-estimate: true`.

The client's API key is ignored; switchkick sends its own OpenRouter key upstream. In
static mode the request's `model` is replaced with the tier's model:

| Tier | Model |
|---|---|
| `fast` | `anthropic/claude-haiku-5.5` |
| `balanced` | `anthropic/claude-sonnet-5.5` |
| `frontier` | `anthropic/claude-opus-5.5` |

To change the models or other settings, write a config file at `~/.config/switchkick/config.yaml`
(or pass `--config`, or set `SWITCHKICK_CONFIG`). Every key is optional:

```yaml
# yaml-language-server: $schema=https://eased-tech.github.io/switchkick/schema/v1.json
mode: static
defaultTier: balanced
tiers:
  frontier: { model: anthropic/claude-opus-5.5, effort: xhigh }
attribution: true
server: { host: 127.0.0.1, port: 8787, maxBodyBytes: 20mb }
log: { enabled: true, file: ~/.local/state/switchkick/decisions.jsonl, maxBytes: 50mb }
```

A tier set in the file replaces the built-in one. A tier's `effort` (`low`, `medium`, `high`,
`xhigh` or `max`) replaces whatever reasoning effort the client sent. It's sent as
`reasoning.effort` to Chat Completions and Responses, and as `output_config.effort` to Messages.
Without one, the client's own setting passes through. Command-line flags override the file. The
schema is in [`schema/v1.json`](schema/v1.json); unknown keys are rejected so typos don't go
unnoticed.

Responses come back unchanged, streaming included. Two things differ from OpenAI's Responses
API, because OpenRouter's is stateless: `previous_response_id` is rejected with a 400, and
`store: true` is sent as `false`.

## Hosted mode

In hosted mode, OpenRouter's Jev router (`typesafe/jev-router`) chooses the model and reasoning
effort for each request. Turn it on with `mode: hosted` in the config file or `--mode hosted`:

```yaml
mode: hosted
defaultTier: balanced         # used if the router is unavailable
hosted:
  cost_tier: medium           # low | medium | high
  models: [anthropic/*]       # a preference, not a restriction (see below)
  excluded_models: []         # models the router must never pick
  unsupportedReasoning: strip # or reject
```

> **`models` is a preference, not an allowlist.** If none of the listed models is in the router's
> pool, the router ignores the list and picks from everything. Only `excluded_models` is a hard
> restriction. If you need a strict allowlist, use local mode or static mode.
>
> Without any lists, the router can choose models from any provider, including for Anthropic
> Messages requests from Claude Code. With `cost_tier: low` and a trivial prompt it picked a
> non-Anthropic model. For Claude Code, set `models: [anthropic/*]`, and list the providers you
> want to rule out in `excluded_models`.

Patterns are exact slugs (`anthropic/claude-sonnet-5.5`, which matches every dated revision),
dated revisions, case-sensitive wildcards (`anthropic/*`, `"*flash*"`) or family aliases
(`~anthropic/claude-opus-latest`). Quote a pattern that starts with `*`, since YAML otherwise
reads it as an alias. Each list takes up to 1,024 patterns of up to 1,024 characters,
and 65,536 characters in total. switchkick checks these limits when it starts.

What switchkick does to each request:

- `model` becomes `typesafe/jev-router`, and a `jev-router` plugin entry built from `hosted` is
  added. Other plugins the client sends are kept; a `jev-router` entry of its own is replaced.
- `reasoning.effort` passes through as a hint. A tier's `effort` setting doesn't apply, because
  the router picks the effort. The router rejects `reasoning.max_tokens` and
  `reasoning.mode: "pro"`, so switchkick strips them and notes it in the log. With
  `unsupportedReasoning: reject` it answers 400 instead.

A tier override sets the router's `cost_tier` for a request: `fast` → `low`, `balanced` →
`medium`, `frontier` → `high`. Overrides come from a `#fast`, `#balanced` or `#frontier` tag in the
user's latest message (it applies to every step of that turn), the `x-switchkick-tier` request
header, or `SWITCHKICK_TIER` (every request), in that order. See [local mode](#local-mode) for the
tag syntax.

How errors are handled:

| Router response | What the client gets |
|---|---|
| 503, router unavailable | switchkick retries once in static mode on `defaultTier`, and the client gets that response. |
| 404 | No model was left to choose: `excluded_models` ruled out every candidate, or the account has no router access. switchkick says so in a 404. |
| 400 | OpenRouter's message, with a pointer to the `hosted` settings. |

Every log line in hosted mode records the model that served the request (`servedModel`), and the
router's decision when OpenRouter reports one (`router`). That covers the resolved models in
fallback order, the candidates with estimated costs, and the reason. It's written when the response
ends, streaming included. OpenRouter doesn't report the decision on cache hits.

## Local mode

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
  accept: { fast: 0.85, balanced: 0.60, frontier: 0.30 }
  sensitiveFloor: balanced
  claimGuard: true
  idleResetMinutes: 30
  failClosed: false
  maxSessions: 10000
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

### How a request is routed

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
   session, whatever tier an override picks. Such a message is never sent to Jev, and once a session
   holds one, Jev isn't asked about it again.
4. **Session.** Requests that don't start a new turn reuse the session's tier: tool results, a
   subagent's requests, and side calls. A side call is a Messages request without tools that
   either comes from a Claude Code session (Claude Code's own background requests, such as
   prompt suggestions) or asks for 512 `max_tokens` or fewer. System and developer messages in
   the middle or at the end of a conversation don't count as turns.
5. **Jev.** Otherwise Jev answers three questions in one call: which tier the message needs, whether
   it touches production, credentials or destructive operations, and whether it tries to dictate
   its own tier or claims prior review.

Jev's top tier is accepted if its probability reaches `policy.accept` for that tier. Otherwise
the more capable of its top two tiers is used. A sensitive request is raised to `sensitiveFloor`, and
a message that tries to steer its own routing is raised one tier (`claimGuard`). These guards
only ever raise the tier. Jev sees the user's latest message and the reply before it, up to
`jev.requestChars` characters, and never the system prompt or tool output. The reply is left out
if it contains something that looks like a secret.

If Jev fails or takes longer than `jev.deadlineMs`, the request goes to `defaultTier`, or the
session's tier if that's higher. With `failClosed: true`, switchkick answers 503 instead.

### Sessions

The session's tier is what keeps a conversation on one model, and so keeps the provider's
prompt cache warm. With `session: ratchet` (the default), each new message is decided again, but
the session never moves to a lower tier: a `#fast` tag can't lower it either. To lower it, write
the tag with `!` (`#fast!`), which also resets the session to that tier. After
`idleResetMinutes` without requests, the next message starts afresh. `sticky` decides once per
session, and `per-request` decides each message independently.

A session is identified by, first match wins:

1. the `x-switchkick-session` request header;
2. Claude Code's session id, from its `x-claude-code-session-id` header or `metadata.user_id`;
3. a hash of the system prompt, the first user message, the client's API key and
   `prompt_cache_key` if the request has one. Apps often reuse one `prompt_cache_key` for many
   conversations, so it only ever tells sessions apart.

Within a session named by 1 or 2, a new conversation with a different system prompt counts as a
subagent and inherits the session's tier. If a conversation that is already several messages long
arrives with a different system prompt, it's taken to be the main conversation, and the session
follows it. Sessions live in memory, at most `maxSessions` of them, and only hashes of their keys
are kept.

### Claude Code

Point Claude Code at switchkick with `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` and any
`ANTHROPIC_API_KEY` (switchkick ignores it). Claude Code asks for up to 128,000 output tokens per
request, and OpenRouter refuses requests (402) whose maximum cost the account's credit can't
cover. If you see that, set `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, e.g. to `32000`.

### What's logged

Each log line records the turn kind (`human`, `inherit`, `subagent` or `side_call`), a short
session hash, the routed tier and model, and the reason (`jev`, `ratchet`, `pin`, `tag`,
`secret`, `fail_open`, ...). It also records Jev's answer: its tier probabilities, the guard
answers, the guards that fired, latency and cost. If a secret was found, the log names its kind
(e.g. `github_token`), never the value. Message text is never logged.

## Errors and logging

If OpenRouter can't be reached, switchkick answers 502; if it's reachable but doesn't start
responding within Node's 5-minute limit, 504. Both say why (e.g. `ECONNREFUSED`,
`UND_ERR_HEADERS_TIMEOUT`), and so does the decision log. A stream that stalls for 5 minutes after
it has started is cut off; by then the status has been sent, so the client sees a truncated
stream.

Each request adds one line to a decision log at `~/.local/state/switchkick/decisions.jsonl`
(`--log-file` to move it, `--no-log` to turn it off). The log records the routing decision,
status and OpenRouter generation id, never prompt or response text.

## Attribution and access

By default, requests carry OpenRouter's [app attribution](https://openrouter.ai/docs/app-attribution)
headers (`HTTP-Referer: https://github.com/eased-tech/switchkick`, `X-OpenRouter-Title:
switchkick`). That counts switchkick's usage, summed across all users, in OpenRouter's public app
rankings. Nothing identifying you is sent. To opt out, pass `--no-attribution` or set
`SWITCHKICK_ATTRIBUTION=off`.

switchkick listens on `127.0.0.1` only by default. To listen on another address, set
`SWITCHKICK_TOKEN`; clients must then send that token as their API key.

`SWITCHKICK_TIER` routes every request at one tier: in static mode it's the tier (below
`--tier`), in local mode it skips Jev, and in hosted mode it sets the matching `cost_tier`.

## Development

```sh
pnpm install
pnpm check
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
