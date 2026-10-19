# switchkick

> **Status: pre-alpha.** Static mode (one configured tier) and hosted mode (OpenRouter's Jev
> router picks the model) work. Local mode, where switchkick asks Jev itself, is not built yet.

switchkick is a local proxy for coding agents and OpenAI/Anthropic SDK apps. It accepts
OpenAI Chat Completions, OpenAI Responses and Anthropic Messages requests, sends them through
[OpenRouter](https://openrouter.ai), and uses Jev, TypeSafe's decision model, to choose a model
for each human turn. One `OPENROUTER_API_KEY` covers both the routing decision and the model call.

Routing modes:

- **hosted**: OpenRouter's `typesafe/jev-router` chooses the model.
- **local** (planned): switchkick asks Jev directly and applies its own thresholds and guards.
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
> restriction. If you need a strict allowlist, use local mode once it lands, or static mode.
>
> Without any lists, the router can choose models from any provider, including for Anthropic
> Messages requests from Claude Code. With `cost_tier: low` and a trivial prompt it picked a
> non-Anthropic model. For Claude Code, set `models: [anthropic/*]`, and list the providers you
> want to rule out in `excluded_models`.

Patterns are exact slugs (`anthropic/claude-sonnet-5.5`, which matches every dated revision),
dated revisions, case-sensitive wildcards (`anthropic/*`, `*flash*`) or family aliases
(`~anthropic/claude-opus-latest`). Each list takes up to 1,024 patterns of up to 1,024 characters,
and 65,536 characters in total. switchkick checks these limits when it starts.

What switchkick does to each request:

- `model` becomes `typesafe/jev-router`, and a `jev-router` plugin entry built from `hosted` is
  added. Other plugins the client sends are kept; a `jev-router` entry of its own is replaced.
- `reasoning.effort` passes through as a hint. A tier's `effort` setting doesn't apply, because
  the router picks the effort. The router rejects `reasoning.max_tokens` and
  `reasoning.mode: "pro"`, so switchkick strips them and notes it in the log. With
  `unsupportedReasoning: reject` it answers 400 instead.

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

## Development

```sh
pnpm install
pnpm check
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
