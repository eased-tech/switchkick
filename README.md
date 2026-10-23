# switchkick

> **Status: pre-alpha.** All three routing modes work: static (one configured tier), hosted
> (OpenRouter's Jev router picks the model) and local (switchkick asks Jev and applies its own
> policy). `setup`, `doctor`, `uninstall`, `report`, `eval` and `env` are in place; standalone
> binaries come later. The acceptance thresholds in local mode are untuned starting values.

switchkick is a local proxy for coding agents and OpenAI/Anthropic SDK apps. It accepts
OpenAI Chat Completions, OpenAI Responses and Anthropic Messages requests, sends them through
[OpenRouter](https://openrouter.ai), and uses Jev, TypeSafe's decision model, to choose a model
for each human turn. One `OPENROUTER_API_KEY` covers both the routing decision and the model call.

Routing modes:

- **hosted**: OpenRouter's `typesafe/jev-router` chooses the model.
- **local**: switchkick asks Jev directly and applies its own thresholds and guards.
- **static**: a fixed tier. This is also the fallback when Jev is unavailable.

## Getting started

switchkick needs Node.js 22.18 or newer.

```sh
npm install -g switchkick
switchkick setup
switchkick doctor --live
```

`npx switchkick setup` works too: the service it installs then runs this exact version through
npx. To run from a checkout instead, `pnpm install && pnpm build`, then use
`node packages/proxy/dist/cli.js` in place of `switchkick`.

### Other ways to install

These don't need Node.js.

- **Homebrew** (macOS and Linux): `brew install eased-tech/switchkick/switchkick`.
- **Standalone binary:** download `switchkick-<os>-<arch>` for linux-x64, linux-arm64,
  darwin-x64, darwin-arm64 or windows-x64 from
  [Releases](https://github.com/eased-tech/switchkick/releases), make it executable, and put it on
  your `PATH` as `switchkick`. Each release has a `SHA256SUMS` file, and every binary has a
  build attestation, which shows it was built from this repository by its release workflow:

  ```sh
  sha256sum --check --ignore-missing SHA256SUMS
  gh attestation verify switchkick-darwin-arm64 --repo eased-tech/switchkick
  ```

  On Windows, `serve` works, but `setup` installs no service and can't use a credential store,
  so set `OPENROUTER_API_KEY` instead.
- **Docker:** see [Docker](#docker). The npm packages are published with
  [provenance](https://docs.npmjs.com/generating-provenance-statements) too.

`setup` asks for your OpenRouter key and shows what it will change before doing it:

1. **Key.** Stored in the macOS Keychain or, on Linux, the Secret Service (libsecret), under
   service `switchkick`, account `openrouter`. Where neither works (a server, a container), it goes
   in `~/.config/switchkick/env`, readable only by you. The key is passed on stdin, never as a
   command-line argument. A key that's already stored is kept.
2. **Config.** `~/.config/switchkick/config.yaml` in local mode, with the `claude-only` preset when
   Claude Code is a client and `multi-provider` otherwise (see [presets](#presets)). An existing
   config is left as it is.
3. **Service.** A launchd agent on macOS (`~/Library/LaunchAgents/io.github.eased-tech.switchkick.plist`,
   logging to `~/.local/state/switchkick/service.log`) or a systemd user unit on Linux
   (`~/.config/systemd/user/switchkick.service`, logging to the journal). It starts at login and
   restarts switchkick if it stops. Without a service manager, run `switchkick serve` yourself.
   systemd stops user services at logout unless you run `loginctl enable-linger`.
4. **Clients.** Each client found on the machine (or named with `--client codex,claude,openai`)
   is pointed at switchkick:
   - **Codex:** `model_provider = "switchkick"` and a `[model_providers.switchkick]` table in
     `~/.codex/config.toml` (`$CODEX_HOME`). The rest of the file, comments included, is left as it
     was; switchkick parses the result and refuses to write it if anything else would change.
   - **Claude Code:** `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and
     `CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000` in the `env` of `~/.claude/settings.json`
     (`$CLAUDE_CONFIG_DIR`). A cap you already set is kept.
   - **OpenAI SDK apps:** nothing to edit; setup prints `OPENAI_BASE_URL` and `OPENAI_API_KEY`.

Before changing a client's file, setup saves its exact bytes. `switchkick uninstall` stops and
removes the service and puts every file back byte for byte, or deletes it if setup created it. If
you edited a file after setup, your version is kept next to it as `<file>.switchkick-uninstall`.
The config, the decision log and the stored key stay; `uninstall --purge` deletes them too.
`setup --yes` asks nothing, and takes the key from `OPENROUTER_API_KEY` if none is stored.

`switchkick doctor` checks the config, the key (it says where it found it, never what it is),
that every configured model is on OpenRouter, the service, the client settings, and that the
proxy answers. `--live` also asks Jev one question and sends a tiny request through the proxy at
the frontier tier for each client setup wired, with the output cap that client asks for. That's
where a 402 from OpenRouter (credit, or the key's limit, too low for a request's worst case) shows
up, rather than in the middle of a session. Claude Code asks for up to `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.
Codex sets no cap, so OpenRouter prices each Codex request at the model's full output limit,
and a key with little credit left refuses them all. The checks cost a fraction of a cent.

### Docker

The image at `ghcr.io/eased-tech/switchkick` runs `switchkick serve` for `linux/amd64` and
`linux/arm64`, as a non-root user, with a healthcheck on `/healthz`. It's configured with
environment variables. Inside the container switchkick listens on `0.0.0.0`, so
`SWITCHKICK_TOKEN` is required, and clients send it as their API key:

```sh
docker run -d --name switchkick -p 127.0.0.1:8787:8787 \
  -e OPENROUTER_API_KEY -e SWITCHKICK_TOKEN -e SWITCHKICK_MODE=local \
  -v switchkick-data:/data ghcr.io/eased-tech/switchkick
```

| Variable | Default in the image | |
|---|---|---|
| `OPENROUTER_API_KEY` | | Required. |
| `SWITCHKICK_TOKEN` | | Required. |
| `SWITCHKICK_MODE` | `static` | `static`, `hosted` or `local`. |
| `SWITCHKICK_TIER` | | See [attribution and access](#attribution-and-access). |
| `SWITCHKICK_PORT` | `8787` | |
| `SWITCHKICK_CONFIG` | `/config/switchkick/config.yaml` if it exists | Mount a config file for anything else. |
| `SWITCHKICK_ATTRIBUTION` | | `off` to opt out. |

Sessions and the decision log are written to `/data`; mount a volume there to keep them.
Images are tagged `latest`, with the version (`X.Y.Z`) and with the minor version (`X.Y`), and
each has a build attestation: `gh attestation verify oci://ghcr.io/eased-tech/switchkick:<tag> --repo
eased-tech/switchkick`.

## Commands

| Command | What it does |
|---|---|
| `switchkick serve` | Run the proxy in the foreground. |
| `switchkick setup [--client …] [--preset …] [--mode …] [--service auto\|launchd\|systemd\|none] [--yes]` | Store the key, write the config, install the service, point clients at switchkick. |
| `switchkick doctor [--live]` | Check that everything is in place; exits 1 if not. |
| `switchkick uninstall [--purge]` | Undo `setup`. |
| `switchkick report [log] [--since 7d] [--baseline <model>] [--json]` | Summarize the decision log. |
| `switchkick eval [--set <file>] [--answers <file>] [--from <file>]` | Measure local mode's routing against labelled prompts. |
| `switchkick env <openai\|claude\|codex>` | Print the environment for one shell: `eval "$(switchkick env claude)"`. |

`switchkick <command> --help` lists each command's options.

## Running the proxy

```sh
OPENROUTER_API_KEY=sk-or-... switchkick serve --tier balanced
```

Instead of setting `OPENROUTER_API_KEY` each time, you can store the key once in the OS
credential store, which switchkick checks next (`setup` does this for you):

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

### Presets

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

A tier set in the file replaces the preset's (or built-in) one. A tier's `effort` (`low`, `medium`, `high`,
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
> non-Anthropic model. For Claude Code, use `preset: claude-only`, which prefers `anthropic/*` and
> excludes every other model author on OpenRouter.

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
  persistSessions: true        # sessionFile: ~/.local/state/switchkick/sessions.json
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
session's tier if that's higher. With `failClosed: true`, switchkick answers 503 instead. Jev
usually answers in about 0.55 s, and rarely takes over 1 s. To save the first call the cost of
connecting, switchkick opens the connection at startup with a `HEAD` request that carries no
key and no data.

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

Sessions are saved to `~/.local/state/switchkick/sessions.json` every 30 seconds when something
changed, and when switchkick stops, so a restart doesn't drop a conversation to a lower tier. The
file holds session hashes, tiers and timestamps, never text, and is readable only by you. Set
`policy.sessionFile` to move it, or `policy.persistSessions: false` to keep sessions in memory only.

### Claude Code

`switchkick setup --client claude` points Claude Code at switchkick in its user settings. To do
it by hand, set `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` and any `ANTHROPIC_AUTH_TOKEN`
(switchkick ignores it). Claude Code asks for up to 128,000 output tokens per request, and
OpenRouter refuses requests (402) whose maximum cost the account's credit, or the key's limit,
can't cover. setup sets `CLAUDE_CODE_MAX_OUTPUT_TOKENS` to `32000` for that reason, and
`switchkick doctor --live` sends a request with the same cap to check it's affordable.

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
status, OpenRouter generation id, and the tokens and cost the response reported (`usage`), never
prompt or response text. The line is written when the response ends, streaming included.

`switchkick report` summarizes the log and its rotated copy: requests per tier and model, tokens
and spend (OpenRouter's billed cost, plus Jev's), what the same tokens would have cost on one
baseline model at list price (the frontier tier's by default; `--baseline` picks another), Jev's
latency and failures, how often routing fell back, and in hosted mode which models the router
chose. `--since 24h` limits it to recent requests and `--json` prints the numbers.

### Tuning local mode with `eval`

`switchkick eval --set prompts.jsonl` asks Jev about each prompt in a labelled set, routes the
answers with your config's policy, and prints a confusion matrix, the share routed below their
label (a quality risk) and above it (extra cost), and how moving each `policy.accept` bar would
change those. Each line of the set is `{"id": "...", "tier": "fast|balanced|frontier",
"prompt": "...", "previous": "optional assistant message it replies to"}`. A small synthetic
starter set is in [`eval/prompts.jsonl`](eval/prompts.jsonl); your own prompts tell you more.
`--answers out.jsonl` saves Jev's answers (ids, labels and probabilities, no prompt text), and
`--from out.jsonl` re-runs the policy on them without asking Jev again. Each prompt costs one Jev
call; the starter set's 24 cost $0.0005 together.

## Attribution and access

By default, requests carry OpenRouter's [app attribution](https://openrouter.ai/docs/app-attribution)
headers (`HTTP-Referer: https://github.com/eased-tech/switchkick`, `X-OpenRouter-Title:
switchkick`). That counts switchkick's usage, summed across all users, in OpenRouter's public app
rankings. Nothing identifying you is sent. To opt out, pass `--no-attribution` or set
`SWITCHKICK_ATTRIBUTION=off`.

switchkick listens on `127.0.0.1` only by default. To listen on another address, set
`SWITCHKICK_TOKEN`; clients must then send that token as their API key.

`SWITCHKICK_HOST`, `SWITCHKICK_PORT` and `SWITCHKICK_MODE` work like `--host`, `--port` and
`--mode`: a flag wins over the variable, and the variable over the config file.

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
