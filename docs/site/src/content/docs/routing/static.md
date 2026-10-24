---
title: Tiers and static mode
description: The three tiers, the models behind them, presets, and static mode.
---

switchkick routes every request to one of three tiers: `fast`, `balanced` and `frontier`. Each
tier is an OpenRouter model, with an optional reasoning effort. The routing modes differ only in
how they pick the tier:

- **static** (the default): every request goes to `defaultTier`, or the tier given with `--tier`.
  Static is also the fallback when Jev or the hosted router is unavailable.
- **[hosted](/switchkick/routing/hosted/)**: OpenRouter's Jev router chooses the model.
- **[local](/switchkick/routing/local/)**: switchkick asks Jev which tier each new message needs,
  and applies its own thresholds and guards.

Set the mode with `mode` in the config file, `--mode`, or `SWITCHKICK_MODE`.

## Default models

In static mode, the request's `model` is replaced with the tier's model:

| Tier | Model |
|---|---|
| `fast` | `anthropic/claude-haiku-5.5` |
| `balanced` | `anthropic/claude-sonnet-5.5` |
| `frontier` | `anthropic/claude-opus-5.5` |

To change them, write a config file at `~/.config/switchkick/config.yaml` (or pass `--config`, or
set `SWITCHKICK_CONFIG`). Every key is optional; the
[configuration reference](/switchkick/reference/configuration/) lists them all.

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

A tier set in the file replaces the preset's (or built-in) one. A tier's `effort` (`low`,
`medium`, `high`, `xhigh` or `max`) replaces whatever reasoning effort the client sent. It's sent
as `reasoning.effort` to Chat Completions and Responses, and as `output_config.effort` to
Messages. Without one, the client's own setting passes through. Command-line flags override the
file.

## Presets

`preset` picks a set of models, which the rest of the file can override:

| | `claude-only` | `multi-provider` |
|---|---|---|
| `fast` | `anthropic/claude-haiku-5.5` | `google/gemini-3.8-flash` |
| `balanced` | `anthropic/claude-sonnet-5.5` | `openai/gpt-6.1-sol` |
| `frontier` | `anthropic/claude-opus-5.5` | `anthropic/claude-opus-5.5` |
| `trusted` | `anthropic/claude-sonnet-5.5` | `anthropic/claude-sonnet-5.5` |
| hosted mode | `models: [anthropic/*]`, and every other model author on OpenRouter in `excluded_models` | no lists |

`claude-only` is what Claude Code supports, and setup uses it whenever Claude Code is a client.
Anthropic doesn't support other models in Claude Code, so choosing `multi-provider` for it shows
a warning. `multi-provider` is the default for Codex and OpenAI SDK apps. Without a preset, the
tiers are the Claude models and hosted mode has no lists. New model authors appear on OpenRouter
over time; in hosted mode with `claude-only`, `switchkick doctor` names any that the preset's
exclusion list doesn't cover yet.
