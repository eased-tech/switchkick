---
title: Clients
description: Pointing Claude Code, Codex and OpenAI SDK apps at switchkick.
---

switchkick listens on `http://127.0.0.1:8787` and accepts the three APIs coding agents and SDKs
speak:

| Client API | Endpoint | Typical setting |
|---|---|---|
| OpenAI Chat Completions | `POST /v1/chat/completions` | `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` |
| OpenAI Responses | `POST /v1/responses` | `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` |
| Anthropic Messages | `POST /v1/messages` | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` |

The client's API key is ignored; switchkick sends its own OpenRouter key upstream. Responses come
back unchanged, streaming included.

`switchkick setup` wires each client it finds, or the ones named with `--client`.
`switchkick env <openai|claude|codex>` prints the environment for one shell instead:
`eval "$(switchkick env claude)"`.

## Claude Code

setup sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000`
in the `env` of `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR`). A cap you already set is kept.
To do it by hand, set `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` and any `ANTHROPIC_AUTH_TOKEN`
(switchkick ignores it).

Claude Code asks for up to 128,000 output tokens per request, and OpenRouter refuses requests
(402) whose maximum cost the account's credit, or the key's limit, can't cover. That's why setup
sets the cap, and `switchkick doctor --live` sends a request with the same cap to check it's
affordable.

Anthropic doesn't support other models in Claude Code, so use the `claude-only`
[preset](/switchkick/routing/static/#presets) with it. setup does this whenever Claude Code is a
client, and choosing `multi-provider` for it shows a warning.

## Codex

setup adds `model_provider = "switchkick"` and a `[model_providers.switchkick]` table to
`~/.codex/config.toml` (`$CODEX_HOME`). The rest of the file, comments included, is left as it was;
switchkick parses the result and refuses to write it if anything else would change.

Codex sends no output cap, so OpenRouter prices each Codex request at the model's full output
limit. A key with little credit left refuses them all; `doctor --live` checks for this.

## OpenAI SDK apps

There's nothing to edit: setup prints `OPENAI_BASE_URL` and `OPENAI_API_KEY`. Any value works as
the key, unless you set `SWITCHKICK_TOKEN` (see
[access](/switchkick/reference/logging/#attribution-and-access)).

Two things differ from OpenAI's Responses API, because OpenRouter's is stateless:
`previous_response_id` is rejected with a 400, and `store: true` is sent as `false`.

## Endpoints switchkick answers itself

- `GET /v1/models` lists the models requests are routed to, in OpenAI's shape, or in Anthropic's
  when the request has an `anthropic-version` header. `GET /v1/models/{id}` retrieves one.
- `POST /v1/messages/count_tokens` returns an **estimate**, because OpenRouter has no
  token-counting endpoint. It's tuned to overcount, typically by 10–40%, so a client tracking its
  context window compacts a little early rather than overflowing. The response carries
  `x-switchkick-token-estimate: true`.
- `GET /healthz` answers when the proxy is up.
