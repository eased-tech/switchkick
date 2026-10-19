/**
 * Record real OpenRouter responses for each API format, streaming and not,
 * and probe the auth and header behavior the docs leave unverified.
 *
 *   OPENROUTER_API_KEY=... node scripts/spikes/record-fixtures.ts [--model anthropic/claude-haiku-4.5]
 *
 * Writes scrubbed fixtures to packages/proxy/test/fixtures/ and a probe report to
 * scripts/spikes/out/probes.json. Each run costs a few cents at most.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "anthropic/claude-haiku-4.5" },
    "base-url": { type: "string", default: "https://openrouter.ai/api/v1" },
  },
});
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is not set.");
  process.exit(1);
}
const baseUrl = values["base-url"];
const model = values.model;
const fixturesDir = join(import.meta.dirname, "../../packages/proxy/test/fixtures");
const outDir = join(import.meta.dirname, "out");

const PROMPT = "Reply with exactly: ok";
const ATTRIBUTION = {
  "HTTP-Referer": "https://github.com/switchkick/switchkick",
  "X-OpenRouter-Title": "switchkick spikes",
};

type Format = "chat" | "responses" | "messages";

const bodies: Record<Format, (model: string, stream: boolean) => unknown> = {
  chat: (model, stream) => ({
    model,
    stream,
    max_tokens: 16,
    messages: [{ role: "user", content: PROMPT }],
  }),
  responses: (model, stream) => ({
    model,
    stream,
    max_output_tokens: 16,
    input: [{ type: "message", role: "user", content: PROMPT }],
  }),
  messages: (model, stream) => ({
    model,
    stream,
    max_tokens: 16,
    messages: [{ role: "user", content: PROMPT }],
  }),
};

const paths: Record<Format, string> = {
  chat: "/chat/completions",
  responses: "/responses",
  messages: "/messages",
};

/** Response headers worth keeping in fixtures; everything else is dropped. */
const KEPT_HEADERS = ["content-type", "cache-control", "x-generation-id"];

/** Replace per-request ids so fixtures are stable and carry nothing account-specific. */
function scrub(text: string): string {
  return text
    .replace(/gen-[A-Za-z0-9-]{8,}/g, "gen-REDACTED")
    .replace(/msg_[A-Za-z0-9]{8,}/g, "msg_REDACTED")
    .replace(/resp_[A-Za-z0-9]{8,}/g, "resp_REDACTED")
    .replace(/"created(_at)?":\s*\d+/g, '"created$1":0');
}

async function post(path: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...ATTRIBUTION, ...headers },
    body: JSON.stringify(body),
  });
  return { res, text: await res.text() };
}

async function record(name: string, path: string, body: unknown, headers: Record<string, string>) {
  const { res, text } = await post(path, body, { authorization: `Bearer ${apiKey}`, ...headers });
  const kept = Object.fromEntries(
    KEPT_HEADERS.flatMap((h) => {
      const v = res.headers.get(h);
      return v === null ? [] : [[h, h === "x-generation-id" ? "gen-REDACTED" : v]];
    }),
  );
  const streaming = (res.headers.get("content-type") ?? "").includes("text/event-stream");
  await writeFile(join(fixturesDir, `${name}.${streaming ? "sse" : "json"}`), scrub(text));
  await writeFile(
    join(fixturesDir, `${name}.meta.json`),
    `${JSON.stringify({ status: res.status, headers: kept, request: body }, null, 2)}\n`,
  );
  console.log(`${res.status} ${name}`);
}

async function probe(
  name: string,
  format: Format,
  headers: Record<string, string>,
  extraBody: Record<string, unknown> = {},
) {
  const body = { ...(bodies[format](model, false) as object), ...extraBody };
  const { res, text } = await post(paths[format], body, headers);
  return { name, status: res.status, body: scrub(text).slice(0, 300) };
}

await mkdir(fixturesDir, { recursive: true });
await mkdir(outDir, { recursive: true });

// One fixture per format × streaming mode.
for (const format of Object.keys(paths) as Format[]) {
  for (const stream of [false, true]) {
    const name = `${format}-${stream ? "stream" : "json"}`;
    await record(name, paths[format], bodies[format](model, stream), {});
  }
}

// Hosted router with metadata, to find where `openrouter_metadata` lands in each format.
for (const format of Object.keys(paths) as Format[]) {
  for (const stream of [false, true]) {
    const name = `hosted-${format}-${stream ? "stream" : "json"}`;
    const body = {
      ...(bodies[format]("typesafe/jev-router", stream) as object),
      plugins: [{ id: "jev-router", cost_tier: "low" }],
    };
    await record(name, paths[format], body, { "X-OpenRouter-Metadata": "enabled" });
  }
}

// Undocumented behavior: auth and header handling on /messages.
const probes = [
  await probe("messages: x-api-key only", "messages", { "x-api-key": apiKey }),
  await probe("messages: bearer + anthropic-version", "messages", {
    authorization: `Bearer ${apiKey}`,
    "anthropic-version": "2023-06-01",
  }),
  await probe("messages: bearer + unknown anthropic-beta", "messages", {
    authorization: `Bearer ${apiKey}`,
    "anthropic-beta": "switchkick-probe-2026-01-01",
  }),
  await probe(
    "responses: previous_response_id",
    "responses",
    { authorization: `Bearer ${apiKey}` },
    { previous_response_id: "resp_switchkick_probe" },
  ),
];
await writeFile(join(outDir, "probes.json"), `${JSON.stringify(probes, null, 2)}\n`);
for (const p of probes) console.log(`${p.status} probe: ${p.name}`);
