---
"switchkick": minor
---

Ship switchkick as standalone binaries for Linux, macOS and Windows, a Homebrew formula and a
multi-arch Docker image at `ghcr.io/eased-tech/switchkick`, alongside the npm packages, which are
now published with provenance. `serve` reads `SWITCHKICK_HOST`, `SWITCHKICK_PORT` and
`SWITCHKICK_MODE`, so a container can be configured with environment variables alone, and
`setup` installs a service that runs a standalone binary directly.
