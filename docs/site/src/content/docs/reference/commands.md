---
title: Commands
description: What each switchkick command does, and its options.
---

`switchkick <command> --help` prints the same details for the installed version.

| Command | What it does |
|---|---|
| [`serve`](#serve) | Run the proxy in the foreground. |
| [`setup`](#setup) | Store the key, write the config, install the service, point clients at switchkick. |
| [`doctor`](#doctor) | Check that everything is in place; exits 1 if not. |
| [`uninstall`](#uninstall) | Undo `setup`. |
| [`report`](#report) | Summarize the decision log. |
| [`eval`](#eval) | Measure local mode's routing against labelled prompts. |
| [`env`](#env) | Print the environment for one shell. |

## serve

```
switchkick serve [options]
```

| Option | |
|---|---|
| `--config <path>` | Config file (default `~/.config/switchkick/config.yaml` if it exists). |
| `--host <addr>` | Address to listen on (default `127.0.0.1`). |
| `--port <n>` | Port to listen on (default `8787`). |
| `--mode <mode>` | `static`, `hosted` or `local` (default `static`). |
| `--tier <tier>` | The tier in static mode, and the fallback in hosted and local mode (default `balanced`). |
| `--log-file <path>` | Decision log (default `~/.local/state/switchkick/decisions.jsonl`). |
| `--no-log` | Don't write a decision log. |
| `--no-attribution` | Don't send OpenRouter's app-attribution headers. |

Each flag overrides the matching [environment variable](/switchkick/reference/logging/#environment-variables),
which overrides the config file. The API key comes from `OPENROUTER_API_KEY`, then the OS
credential store, then `~/.config/switchkick/env`; see
[getting started](/switchkick/getting-started/#run-it-by-hand).

## setup

```
switchkick setup [--client …] [--preset …] [--mode …] [--service auto|launchd|systemd|none] [--yes]
```

Stores the key, writes a config unless one exists, installs a launchd agent or systemd user
service, and points clients at switchkick. [Getting started](/switchkick/getting-started/#what-setup-does)
walks through each step.

| Option | |
|---|---|
| `--client <name>` | `codex`, `claude` or `openai`; repeat or comma-separate for several. Defaults to the clients found on the machine, or `openai` if none is. |
| `--preset <name>` | Models for a new config: `claude-only` or `multi-provider`. Defaults to `claude-only` when Claude Code is a client. |
| `--mode <mode>` | Routing mode for a new config (default `local`). |
| `--service <kind>` | `auto`, `launchd`, `systemd` or `none` (default `auto`). |
| `--config <path>` | Config file to use or write. |
| `-y`, `--yes` | Ask nothing. The key must be in `OPENROUTER_API_KEY` or already stored. |

## doctor

```
switchkick doctor [--live] [--config <path>]
```

Checks the config file, the OpenRouter key (never shown), that the configured models exist on
OpenRouter, the service, the client settings setup changed, and that the proxy answers. `--live`
also makes one Jev call (local mode) and a tiny model call per wired client at the frontier
tier, with that client's output cap. It costs a fraction of a cent.

## uninstall

```
switchkick uninstall [--purge] [--yes]
```

Stops and removes the service, and puts back every client settings file setup changed, byte for
byte. A file edited since setup is restored too, and the edited version is kept next to it as
`<file>.switchkick-uninstall`. `--purge` also deletes the config directory, the state directory
and the stored key; `--yes` skips the question before purging.

## report

```
switchkick report [log] [--since 7d] [--baseline <model>] [--json] [--config <path>]
```

Summarizes the decision log and its rotated copy. See [logging and report](/switchkick/reference/logging/#report).

## eval

```
switchkick eval [--set <file>] [--answers <file>] [--from <file>] [--concurrency <n>] [--json] [--config <path>]
```

Asks Jev about each prompt in a labelled set, routes the answers with the config's policy, and
compares the result with the labels: a confusion matrix, accuracy, how often a prompt went to a
cheaper tier than its label (a quality risk) or a dearer one (a cost), and how moving each tier's
`policy.accept` bar changes those numbers.

| Option | |
|---|---|
| `--set <file>` | The labelled set (default `eval/prompts.jsonl`, as in the switchkick repository). |
| `--answers <file>` | Save Jev's answers: ids, labels and probabilities, no prompt text. |
| `--from <file>` | Re-run the policy on saved answers instead of asking Jev again. |
| `--concurrency <n>` | Jev calls at once (default 4). |
| `--json` | Print the results as JSON. |
| `--config <path>` | Config file, for the policy and Jev settings. |

The set is JSON Lines, one prompt per line. `previous` may hold the assistant message the prompt
replies to:

```json
{"id": "rename", "tier": "fast", "prompt": "Rename x to count in utils.ts"}
```

Each prompt costs one Jev call, a small fraction of a cent.

## env

```
switchkick env <openai|claude|codex> [--config <path>]
```

Prints shell commands that point a client at switchkick for the current shell only:
`eval "$(switchkick env claude)"`.

| Client | |
|---|---|
| `openai` | `OPENAI_BASE_URL` and `OPENAI_API_KEY`, for OpenAI SDK apps. |
| `claude` | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_MAX_OUTPUT_TOKENS`. |
| `codex` | An alias that passes switchkick as Codex's model provider. |

The API key it prints is a placeholder that switchkick ignores, or `SWITCHKICK_TOKEN` when that
is set.
