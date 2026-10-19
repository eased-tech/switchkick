# @switchkick/jev

A small client for OpenRouter's Jev Decisions API (`POST /api/alpha/decisions`), used by
[switchkick](https://github.com/eased-tech/switchkick). It races each call against a deadline,
returns failures as values rather than throwing (so callers can fall back), and validates the
response shape.

The Decisions API is in alpha, so this package's API may change between 0.x releases.

Apache-2.0.
