# switchkick

## 0.3.0

### Minor Changes

- [#25](https://github.com/eased-tech/switchkick/pull/25) [`f84a012`](https://github.com/eased-tech/switchkick/commit/f84a01279fc35d950634db09251448b5c43081ce) Thanks [@anuragit15](https://github.com/anuragit15)! - Local mode's default `policy.accept.fast` is now 0.80 (it was 0.85), chosen with a new set of 206 labelled prompts for `switchkick eval`. Simple requests that Jev is 80–85% sure of now go to the fast tier instead of balanced. Configs that set `accept.fast` keep their value. The tuning guide at https://eased-tech.github.io/switchkick/guides/tuning/ shows the numbers, and notes that `accept.frontier` has no effect.

### Patch Changes

- [#28](https://github.com/eased-tech/switchkick/pull/28) [`0b88ffa`](https://github.com/eased-tech/switchkick/commit/0b88ffa0b83751f5f7d6b6eb36b099788d87ba4f) Thanks [@anuragit15](https://github.com/anuragit15)! - Local mode now makes one Jev call per message when a client retries a request. A request that repeats the conversation its session last decided, within 5 minutes, gets the same tier and is logged with `reason: retry`. Before, each retry was decided again: one Codex turn made 6 Jev calls, and in `ratchet` mode a retry could raise the session's tier partway through a turn. `planRoute` takes a new optional `conversation` fingerprint, `SessionState` has an optional `decided` field, and `RETRY_WINDOW_MS` is exported.
  
  Codex's `session-id` header now names the session, as Claude Code's session id already did. Codex subagents send their parent's id, so they inherit the parent's tier instead of starting a session of their own and costing a Jev call. The header only counts on requests from Codex (an `originator` starting with `codex`, or an `x-codex-window-id` header), since other clients may use `session-id` for something other than one conversation.

- [#24](https://github.com/eased-tech/switchkick/pull/24) [`3f43a49`](https://github.com/eased-tech/switchkick/commit/3f43a492f3b1f93c61f2cb7b3aedf2ba2448d78a) Thanks [@anuragit15](https://github.com/anuragit15)! - The documentation moved to https://eased-tech.github.io/switchkick/, which also serves the config schema at the URL configs already point to. The config `setup` writes links to its configuration reference.
- Updated dependencies [[`0b88ffa`](https://github.com/eased-tech/switchkick/commit/0b88ffa0b83751f5f7d6b6eb36b099788d87ba4f), [`f84a012`](https://github.com/eased-tech/switchkick/commit/f84a01279fc35d950634db09251448b5c43081ce)]:
  - @switchkick/core@0.3.0
  - @switchkick/jev@0.3.0

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
