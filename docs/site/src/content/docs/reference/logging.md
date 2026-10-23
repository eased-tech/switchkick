---
title: Logging, errors and access
description: The decision log, switchkick report, error handling, attribution and environment variables.
---

## Decision log

Each request adds one line to a decision log at `~/.local/state/switchkick/decisions.jsonl`
(`--log-file` or `log.file` to move it, `--no-log` to turn it off). The log records the routing
decision, status, OpenRouter generation id, and the tokens and cost the response reported
(`usage`), never prompt or response text. The line is written when the response ends, streaming
included. It's rotated to `decisions.jsonl.1` at `log.maxBytes`.

What else a line holds depends on the mode: see [hosted mode](/switchkick/routing/hosted/#whats-logged)
and [local mode](/switchkick/routing/local/#whats-logged).

## Report

`switchkick report` summarizes the log and its rotated copy: requests per tier and model, tokens
and spend (OpenRouter's billed cost, plus Jev's), what the same tokens would have cost on one
baseline model at list price (the frontier tier's by default; `--baseline` picks another), Jev's
latency and failures, how often routing fell back, and in hosted mode which models the router
chose. `--since 24h` limits it to recent requests and `--json` prints the numbers.

## Errors

If OpenRouter can't be reached, switchkick answers 502; if it's reachable but doesn't start
responding within Node's 5-minute limit, 504. Both say why (e.g. `ECONNREFUSED`,
`UND_ERR_HEADERS_TIMEOUT`), and so does the decision log. A stream that stalls for 5 minutes after
it has started is cut off; by then the status has been sent, so the client sees a truncated
stream.

## Attribution and access

By default, requests carry OpenRouter's [app attribution](https://openrouter.ai/docs/app-attribution)
headers (`HTTP-Referer: https://github.com/eased-tech/switchkick`, `X-OpenRouter-Title:
switchkick`). That counts switchkick's usage, summed across all users, in OpenRouter's public app
rankings. Nothing identifying you is sent. To opt out, pass `--no-attribution` or set
`SWITCHKICK_ATTRIBUTION=off`.

switchkick listens on `127.0.0.1` only by default. To listen on another address, set
`SWITCHKICK_TOKEN`; clients must then send that token as their API key.

## Environment variables

A flag wins over the variable, and the variable over the config file.

| Variable | |
|---|---|
| `OPENROUTER_API_KEY` | The OpenRouter key. Checked before the OS credential store and `~/.config/switchkick/env`. |
| `SWITCHKICK_CONFIG` | Config file, if `--config` isn't given. |
| `SWITCHKICK_HOST` | Same as `--host`. |
| `SWITCHKICK_PORT` | Same as `--port`. |
| `SWITCHKICK_MODE` | Same as `--mode`. |
| `SWITCHKICK_TOKEN` | Clients must send this as their API key. Required when the host isn't a loopback address. |
| `SWITCHKICK_TIER` | Route every request at one tier: in static mode it's the tier (below `--tier`), in local mode it skips Jev, and in hosted mode it sets the matching `cost_tier`. |
| `SWITCHKICK_ATTRIBUTION` | `off` is the same as `--no-attribution`. |
