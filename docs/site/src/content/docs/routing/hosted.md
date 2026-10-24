---
title: Hosted mode
description: Let OpenRouter's Jev router choose the model for each request.
---

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

:::caution[`models` is a preference, not an allowlist]
If none of the listed models is in the router's pool, the router ignores the list and picks from
everything. Only `excluded_models` is a hard restriction. If you need a strict allowlist, use
[local mode](/switchkick/routing/local/) or static mode.

Without any lists, the router can choose models from any provider, including for Anthropic
Messages requests from Claude Code. With `cost_tier: low` and a trivial prompt it picked a
non-Anthropic model. For Claude Code, use `preset: claude-only`, which prefers `anthropic/*` and
excludes every other model author on OpenRouter.
:::

## Model patterns

Patterns are exact slugs (`anthropic/claude-sonnet-5.5`, which matches every dated revision),
dated revisions, case-sensitive wildcards (`anthropic/*`, `"*flash*"`) or family aliases
(`~anthropic/claude-opus-latest`). Quote a pattern that starts with `*`, since YAML otherwise
reads it as an alias. Each list takes up to 1,024 patterns of up to 1,024 characters, and 65,536
characters in total. switchkick checks these limits when it starts.

## What switchkick does to each request

- `model` becomes `typesafe/jev-router`, and a `jev-router` plugin entry built from `hosted` is
  added. Other plugins the client sends are kept; a `jev-router` entry of its own is replaced.
- `reasoning.effort` passes through as a hint. A tier's `effort` setting doesn't apply, because
  the router picks the effort. The router rejects `reasoning.max_tokens` and
  `reasoning.mode: "pro"`, so switchkick strips them and notes it in the log. With
  `unsupportedReasoning: reject` it answers 400 instead.

A tier override sets the router's `cost_tier` for a request: `fast` → `low`, `balanced` →
`medium`, `frontier` → `high`. Overrides come from a `#fast`, `#balanced` or `#frontier` tag in
the user's latest message (it applies to every step of that turn), the `x-switchkick-tier`
request header, or `SWITCHKICK_TIER` (every request), in that order. See
[local mode](/switchkick/routing/local/#how-a-request-is-routed) for the tag syntax.

## Errors

| Router response | What the client gets |
|---|---|
| 503, router unavailable | switchkick retries once in static mode on `defaultTier`, and the client gets that response. |
| 404 | No model was left to choose: `excluded_models` ruled out every candidate, or the account has no router access. switchkick says so in a 404. |
| 400 | OpenRouter's message, with a pointer to the `hosted` settings. |

## What's logged

Every log line in hosted mode records the model that served the request (`servedModel`), and the
router's decision when OpenRouter reports one (`router`). That covers the resolved models in
fallback order, the candidates with estimated costs, and the reason. It's written when the
response ends, streaming included. OpenRouter doesn't report the decision on cache hits.
