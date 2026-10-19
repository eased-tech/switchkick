# Contributing to switchkick

Thanks for helping. This guide covers local setup and the checks a pull request must pass.

## Ground rules

- switchkick is written from scratch. Don't copy code, config or prompts from other routers.
  Reading them for ideas is fine. If you're unsure whether something counts as copying, ask in
  the pull request.
- Contributions are licensed under Apache-2.0 (see `LICENSE`).
- Never commit API keys, real prompts, or unscrubbed API responses. Recorded fixtures must go
  through `scripts/spikes/record-fixtures.ts`, which strips auth headers and ids.

## Setup

Requirements: Node.js 22.18 or newer, and pnpm. The version is pinned in `package.json`; with
Node 22–24 `corepack enable` installs it, otherwise run `npx pnpm@<version>`.

```sh
pnpm install
pnpm check      # lint + typecheck + build + test, same as CI
```

Useful scripts:

| Script | What it does |
|---|---|
| `pnpm lint` / `pnpm format` | Biome check, or check and fix |
| `pnpm typecheck` | `tsc` in every package |
| `pnpm build` | tsup (JS) + `tsc` (declarations) in every package |
| `pnpm test` | vitest across all packages. Live tests run only when `OPENROUTER_API_KEY` is set |
| `pnpm --filter switchkick dev` | rebuild the proxy on change and run `switchkick serve` |

## Layout

```
packages/core    pure routing policy, no I/O
packages/jev     Jev Decisions API client
packages/proxy   the `switchkick` CLI and HTTP server
docs/adr/        architecture decision records
scripts/spikes/  scripts that call live APIs (need OPENROUTER_API_KEY)
```

Inside packages, import relative files with a `.js` extension (`./tier.js`), as NodeNext
resolution requires.

## Pull requests

- Keep each pull request to one change, with tests.
- `pnpm check` must pass.
- A change to the config schema is a public API change. Regenerate `schema/v1.json` with
  `pnpm schema` and call the change out in the description.
