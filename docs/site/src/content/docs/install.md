---
title: Install
description: npm, Homebrew, standalone binaries, Docker, or a checkout.
---

## npm

```sh
npm install -g switchkick
```

switchkick needs Node.js 22.18 or newer. The packages are published with
[provenance](https://docs.npmjs.com/generating-provenance-statements), which shows they were built
from this repository by its release workflow.

## Homebrew

On macOS and Linux:

```sh
brew install eased-tech/switchkick/switchkick
```

This installs a standalone binary, so it doesn't need Node.js.

## Standalone binary

Download `switchkick-<os>-<arch>` for linux-x64, linux-arm64, darwin-x64, darwin-arm64 or
windows-x64 from [Releases](https://github.com/eased-tech/switchkick/releases), make it
executable, and put it on your `PATH` as `switchkick`. Each release has a `SHA256SUMS` file, and
every binary has a build attestation, which shows it was built from this repository by its
release workflow:

```sh
sha256sum --check --ignore-missing SHA256SUMS
gh attestation verify switchkick-darwin-arm64 --repo eased-tech/switchkick
```

On Windows, `serve` works, but `setup` installs no service and can't use a credential store, so
set `OPENROUTER_API_KEY` instead.

## Docker

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
| `SWITCHKICK_TIER` | | One tier for every request; see [environment variables](/switchkick/reference/logging/#environment-variables). |
| `SWITCHKICK_PORT` | `8787` | |
| `SWITCHKICK_CONFIG` | `/config/switchkick/config.yaml` if it exists | Mount a config file for anything else. |
| `SWITCHKICK_ATTRIBUTION` | | `off` to opt out. |

Sessions and the decision log are written to `/data`; mount a volume there to keep them. Images
are tagged `latest`, with the version (`X.Y.Z`) and with the minor version (`X.Y`), and each has a
build attestation:

```sh
gh attestation verify oci://ghcr.io/eased-tech/switchkick:<tag> --repo eased-tech/switchkick
```

## From a checkout

```sh
git clone https://github.com/eased-tech/switchkick && cd switchkick
pnpm install && pnpm build
node packages/proxy/dist/cli.js --help
```

Use `node packages/proxy/dist/cli.js` wherever these docs say `switchkick`.
