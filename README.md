# switchkick

> **Status: pre-alpha.** All three routing modes work: static (one configured tier), hosted
> (OpenRouter's Jev router picks the model) and local (switchkick asks Jev and applies its own
> policy). Local mode's acceptance thresholds are tuned on a synthetic set of 206 labelled
> prompts; see [tuning local mode](https://eased-tech.github.io/switchkick/guides/tuning/).

switchkick is a local proxy for coding agents and OpenAI/Anthropic SDK apps. It accepts
OpenAI Chat Completions, OpenAI Responses and Anthropic Messages requests, sends them through
[OpenRouter](https://openrouter.ai), and uses Jev, TypeSafe's decision model, to choose a model
for each human turn. One `OPENROUTER_API_KEY` covers both the routing decision and the model call.

**Documentation: [eased-tech.github.io/switchkick](https://eased-tech.github.io/switchkick/)**

Routing modes:

- **[static](https://eased-tech.github.io/switchkick/routing/static/)**: a fixed tier. This is also the fallback when Jev is
  unavailable.
- **[hosted](https://eased-tech.github.io/switchkick/routing/hosted/)**: OpenRouter's `typesafe/jev-router` chooses the model.
- **[local](https://eased-tech.github.io/switchkick/routing/local/)**: switchkick asks Jev directly and applies its own thresholds
  and guards.

Clients don't change, apart from a base URL. Responses stream back byte for byte, and the
decision log records the routing decision and cost, never prompt or response text.

## Getting started

switchkick needs Node.js 22.18 or newer, or a [standalone build](https://eased-tech.github.io/switchkick/install/) (Homebrew,
binaries, Docker).

```sh
npm install -g switchkick
switchkick setup
switchkick doctor --live
```

`setup` stores your OpenRouter key in the OS credential store, writes
`~/.config/switchkick/config.yaml`, installs a launchd or systemd user service, and points Codex,
Claude Code or OpenAI SDK apps at switchkick, showing each change before it makes it.
`switchkick uninstall` puts every file back byte for byte. See
[getting started](https://eased-tech.github.io/switchkick/getting-started/) for the details.

To run it by hand instead:

```sh
OPENROUTER_API_KEY=sk-or-... switchkick serve --tier balanced
```

Then point a client at `http://127.0.0.1:8787` (`OPENAI_BASE_URL=http://127.0.0.1:8787/v1`, or
`ANTHROPIC_BASE_URL=http://127.0.0.1:8787`).

## Configuration

Every key is optional. Start the file with the schema line for completion in your editor:

```yaml
# yaml-language-server: $schema=https://eased-tech.github.io/switchkick/schema/v1.json
mode: local
preset: claude-only
```

The [configuration reference](https://eased-tech.github.io/switchkick/reference/configuration/)
lists every key. The schema is generated into [`schema/v1.json`](schema/v1.json); unknown keys are
rejected so typos don't go unnoticed.

## Commands

| Command | What it does |
|---|---|
| `switchkick serve` | Run the proxy in the foreground. |
| `switchkick setup` | Store the key, write the config, install the service, point clients at switchkick. |
| `switchkick doctor [--live]` | Check that everything is in place; exits 1 if not. |
| `switchkick uninstall [--purge]` | Undo `setup`. |
| `switchkick report` | Summarize the decision log: requests, spend, Jev latency. |
| `switchkick eval` | Measure local mode's routing against labelled prompts. |
| `switchkick env <openai\|claude\|codex>` | Print the environment for one shell. |

`switchkick <command> --help` lists each command's options, and the
[command reference](https://eased-tech.github.io/switchkick/reference/commands/) covers them in full.

## Attribution

By default, requests carry OpenRouter's [app attribution](https://openrouter.ai/docs/app-attribution)
headers (`HTTP-Referer: https://github.com/eased-tech/switchkick`, `X-OpenRouter-Title:
switchkick`). That counts switchkick's usage, summed across all users, in OpenRouter's public app
rankings. Nothing identifying you is sent. To opt out, pass `--no-attribution` or set
`SWITCHKICK_ATTRIBUTION=off`.

## Development

```sh
pnpm install
pnpm check
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
