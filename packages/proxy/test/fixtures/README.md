Real OpenRouter responses, recorded with `scripts/spikes/record-fixtures.ts`.

- `{chat,responses,messages}-{json,stream}` were sent to `anthropic/claude-haiku-4.5`.
- `hosted-*` were sent to `typesafe/jev-router` with `cost_tier: "low"` and
  `X-OpenRouter-Metadata: enabled`.

Each response has a `.meta.json` file next to it with the HTTP status, the response headers
switchkick cares about, and the request body.

The recording script replaces these with stable placeholders: generation, message and response
ids, timestamps, and the OpenRouter edge region. Auth headers are never written. To refresh:

```sh
OPENROUTER_API_KEY=... pnpm spike:fixtures
```
