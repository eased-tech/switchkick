# switchkick

## 0.2.0

### Minor Changes

- [#19](https://github.com/eased-tech/switchkick/pull/19) [`a978e53`](https://github.com/eased-tech/switchkick/commit/a978e53efa4a6c8c66e6da452597384583003631) Thanks [@anuragit15](https://github.com/anuragit15)! - Ship switchkick as standalone binaries for Linux, macOS and Windows, a Homebrew formula and a
  multi-arch Docker image at `ghcr.io/eased-tech/switchkick`, alongside the npm packages, which are
  now published with provenance. `serve` reads `SWITCHKICK_HOST`, `SWITCHKICK_PORT` and
  `SWITCHKICK_MODE`, so a container can be configured with environment variables alone, and
  `setup` installs a service that runs a standalone binary directly.

### Patch Changes

- [#13](https://github.com/eased-tech/switchkick/pull/13) [`9f06b48`](https://github.com/eased-tech/switchkick/commit/9f06b4868a9e6a3ec851202cbe9b5b8795d6548f) Thanks [@anuragit15](https://github.com/anuragit15)! - `report` shows amounts under a cent to two significant figures (for example `$0.000021`)
  instead of rounding them to `$0.0000`.
- Updated dependencies []:
  - @switchkick/core@0.2.0
  - @switchkick/jev@0.2.0
