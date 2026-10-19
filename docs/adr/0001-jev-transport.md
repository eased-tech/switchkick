# ADR 0001: Jev transport: plain `fetch` to the Decisions API

- Status: accepted
- Date: 2026-10-19

## Context

There are three ways to call Jev with an OpenRouter key:

| Option | Endpoint | Notes |
|---|---|---|
| `@typesafe-ai/sdk` with `baseURL: "https://openrouter.ai/api"` | `POST /api/v1/systemone` | TypeSafe's native "System One" shape. On OpenRouter, `client.models.list()` fails. Undocumented on OpenRouter: zstd request compression, multipart image upload, and the `TypeSafe-Danger-Zone-*` headers. Bare `jev-latest` resolves to 1.13 on TypeSafe but 1.14 on OpenRouter. |
| `@openrouter/sdk`, `openRouter.alpha.decisions.create({ decisionsRequest })` | `POST /api/alpha/decisions` | A full SDK covering every OpenRouter API. Generated code, and a large dependency. |
| Plain `fetch` | `POST /api/alpha/decisions` | One small JSON request with a fully documented schema. |

The TypeSafe SDK sends requests to `/api/v1/systemone`, which is a different surface from
`/api/alpha/decisions`. Both share the `model`/`state`/`questions` → `answers`/`usage` shape.

## Decision

Use **plain `fetch` to `POST https://openrouter.ai/api/alpha/decisions`**, behind the `JevClient`
interface in `@switchkick/jev`.

- The wire types live in `packages/jev/src/types.ts`. They were checked against the
  [API reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request.md)
  and the [tutorial's live capture](https://openrouter.ai/docs/guides/community/jev-tutorial.md).
- `validateDecisionsResponse` checks every response structurally. A malformed answer is a
  fail-open `invalid_response`, never a crash.
- `decide()` returns failures as values (`timeout | http | network | invalid_response`), so the
  routing policy must handle fail-open explicitly.
- The default model is pinned to **`typesafe/jev-1.14`**, not `~typesafe/jev-latest`. Thresholds
  are tuned against a specific model, and the alias moves without notice. Users can opt into the
  alias.

## Why

- **Small:** no runtime dependency for one POST. That matters for `bun build --compile` binaries
  and the `npx` cold start.
- **Contained:** the endpoint is `/alpha/`. If OpenRouter changes it, only `@switchkick/jev`
  changes.
- **Documented:** `/api/alpha/decisions` has a published request/response schema and error codes.
  The `/systemone` path on OpenRouter is documented only as a compatibility target for the
  TypeSafe SDK.

## Schema facts that shape the code

- `questions` is an **object keyed by question name**, not an array. Answers come back under the
  same keys.
- `criteria` has three shapes:
  - Choice: a map of option name to description.
  - Score: an ordered array, lowest level first.
  - Noul: an optional `{true, false}`.
- A Noul answer is `{type, noul}` with **no `confidence`**. Choice and Score answers carry
  `confidence` and `probabilities`.
- `usage.cost` is in USD. Output tokens are free; input costs $0.042 per million tokens on Jev 1.14.
- Optional `session_id` (max 256 characters) and `user` fields exist. Send `session_id` to ease
  debugging.
- Errors use `{"error":{"code","message"}}` with codes 400, 401, 402, 403, 404, 413, 429, 500, 502,
  503, 524 and 529.
  - Treat 429, 5xx, 524 and 529 as fail-open.
  - Treat 400 and 413 as bugs: log them loudly, then fail open.
  - Treat 401, 402 and 403 as config errors that `doctor` surfaces.

## Consequences

- If the endpoint leaves alpha or changes shape, we update `types.ts`, the validator and its
  fixture tests.
- Image state is out of scope for v1. Any image in a request triggers Jev's slower long-context
  mode, so routing uses text only.
