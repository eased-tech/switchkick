# @switchkick/core

The routing policy behind [switchkick](https://github.com/eased-tech/switchkick): pure functions,
no I/O. Given a turn's features, Jev's answers, a session's state and the policy settings, it
returns the tier, model target and reason. It also holds the Jev routing questions, the session
store, the secret scan and tier-tag parsing.

Most people want the `switchkick` CLI instead. This package is published for tools that route in
process, and its API may change between 0.x releases.

Apache-2.0.
