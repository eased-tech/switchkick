# switchkick

> **Status: pre-alpha.** Static mode works: every request goes to one configured tier. Jev
> routing is not built yet.

switchkick is a local proxy for coding agents and OpenAI/Anthropic SDK apps. It accepts
OpenAI Chat Completions, OpenAI Responses and Anthropic Messages requests, sends them through
[OpenRouter](https://openrouter.ai), and uses Jev, TypeSafe's decision model, to choose a model
for each human turn. One `OPENROUTER_API_KEY` covers both the routing decision and the model call.

Planned routing modes:

- **hosted**: OpenRouter's `typesafe/jev-router` chooses the model.
- **local**: switchkick asks Jev directly and applies its own thresholds and guards.
- **static**: a fixed tier. This is also the fallback when Jev is unavailable.

## Usage

```sh
pnpm install && pnpm build
OPENROUTER_API_KEY=sk-or-... node packages/proxy/dist/cli.js serve --tier balanced
```

Then point a client at `http://127.0.0.1:8787`:

| Client API | Endpoint | Typical setting |
|---|---|---|
| OpenAI Chat Completions | `POST /v1/chat/completions` | `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` |
| OpenAI Responses | `POST /v1/responses` | `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` |
| Anthropic Messages | `POST /v1/messages` | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` |

The client's API key is ignored; switchkick sends its own `OPENROUTER_API_KEY` upstream. In
static mode the request's `model` is replaced with the tier's model:

| Tier | Model |
|---|---|
| `fast` | `anthropic/claude-haiku-5.5` |
| `balanced` | `anthropic/claude-sonnet-5.5` |
| `frontier` | `anthropic/claude-opus-5.5` |

Responses come back unchanged, streaming included. Two things differ from OpenAI's Responses
API, because OpenRouter's is stateless: `previous_response_id` is rejected with a 400, and
`store: true` is sent as `false`.

Each request adds one line to a decision log at `~/.local/state/switchkick/decisions.jsonl`
(`--log-file` to move it, `--no-log` to turn it off). The log records the routing decision,
status and OpenRouter generation id, never prompt or response text.

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
