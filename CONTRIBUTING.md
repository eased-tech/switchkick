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
| `pnpm changeset` | describe your change for the changelog (see below) |
| `pnpm build:binaries --host` | after `pnpm build`, compile a standalone binary with [Bun](https://bun.sh) into `dist-bin/` |
| `pnpm --filter @switchkick/docs docs:dev` | serve the documentation site locally, with live reload |
| `pnpm --filter @switchkick/docs docs:build` | build the site into `docs/site/dist/`; `docs:check` then checks its links |
| `pnpm smoke <command>` | run a built switchkick against a mock upstream and check responses byte for byte, e.g. `pnpm smoke dist-bin/switchkick-darwin-arm64 serve --config {config} --port {port}` |

## Layout

```
packages/core    pure routing policy, no I/O
packages/jev     Jev Decisions API client
packages/proxy   the `switchkick` CLI and HTTP server
docs/adr/        architecture decision records
docs/site/       the documentation site (Starlight), published to GitHub Pages
eval/            labelled prompts for `switchkick eval` (synthetic, never real sessions)
scripts/release/ binaries, smoke tests, release checks and the Homebrew formula
scripts/spikes/  scripts that call live APIs (need OPENROUTER_API_KEY)
```

Inside packages, import relative files with a `.js` extension (`./tier.js`), as NodeNext
resolution requires.

## Pull requests

- Keep each pull request to one change, with tests.
- `pnpm check` must pass.
- If the change affects what users see or configure, update the page under
  `docs/site/src/content/docs/` that describes it. The configuration reference is generated from
  the schema's descriptions, so a schema change updates it without an edit.
- `eval/answers-jev-1.14.jsonl` holds Jev's answers to `eval/prompts.jsonl`, and the tuning guide
  quotes the results. If you add or relabel prompts, say so in the pull request: a maintainer
  re-records the answers with `switchkick eval --answers` (it needs an OpenRouter key) and
  regenerates the guide with `UPDATE_DOCS=1 pnpm test packages/proxy/test/eval-docs.test.ts`.
- A change to the config schema is a public API change. Regenerate `schema/v1.json` with
  `pnpm schema` and call the change out in the description.
- If the change affects users (a feature, a fix, a behavior change), add a changeset with
  `pnpm changeset`: pick the bump (patch for fixes, minor for features while we're below 1.0) and
  write a sentence or two for the changelog. Changes to tests, CI or docs don't need one.

## Releasing

Maintainers cut releases. All three packages share one version, and a release publishes them to
npm with provenance, standalone binaries with checksums and attestations to GitHub Releases, a
multi-arch image to `ghcr.io/eased-tech/switchkick`, and the formula to the
`eased-tech/homebrew-switchkick` tap.

1. On a branch from an up-to-date `main`, run
   `GITHUB_TOKEN=$(gh auth token) pnpm version-packages`. It applies the pending changesets:
   bumps the versions and writes each package's `CHANGELOG.md`. The token lets the changelog link
   pull requests and authors. Open a pull request titled `Release vX.Y.Z` and merge it.
2. Tag the merge commit on `main` and push the tag (only admins can):
   `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The [Release workflow](.github/workflows/release.yml) checks that the tag matches every
   package version, builds and smoke-tests every artifact, and only then publishes. npm uses
   trusted publishing, so no npm token is stored in the repository. A version with a prerelease
   suffix (`v1.0.0-rc.1`) goes to npm's `next` tag and isn't sent to Homebrew.

If a publish step fails, fix the cause and re-run the failed jobs: packages already on npm are
skipped, and an existing release gets its files replaced.
