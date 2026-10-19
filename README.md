# switchkick

> **Status: pre-alpha.** Nothing is usable yet.

switchkick is a local proxy for coding agents and OpenAI/Anthropic SDK apps. It accepts
OpenAI Chat Completions, OpenAI Responses and Anthropic Messages requests, sends them through
[OpenRouter](https://openrouter.ai), and uses Jev, TypeSafe's decision model, to choose a model
for each human turn. One `OPENROUTER_API_KEY` covers both the routing decision and the model call.

Planned routing modes:

- **hosted**: OpenRouter's `typesafe/jev-router` chooses the model.
- **local**: switchkick asks Jev directly and applies its own thresholds and guards.
- **static**: a fixed tier. This is also the fallback when Jev is unavailable.

## Development

```sh
pnpm install
pnpm check
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
