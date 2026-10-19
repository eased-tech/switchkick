/**
 * Reads the served model and OpenRouter's router metadata out of a response that is being
 * piped to the client. It only ever looks at a copy: the client's bytes are never changed.
 */

/** Responses larger than this aren't scanned, so a huge body can't hold memory hostage. */
export const MAX_SCAN_BYTES = 8 * 1024 * 1024;

/** The candidates kept per log entry. */
const MAX_CANDIDATES = 32;

export interface RouterCandidate {
  model?: string;
  effort?: string;
  tier?: string;
  /** An estimate in USD, not the billed amount. */
  estimatedCost?: number;
}

/**
 * The documented part of the router's `openrouter_metadata` pipeline entry, plus its policy
 * `version`. Every field is optional because none is guaranteed, and the rest of the entry is
 * internal to the router and changes without notice.
 */
export interface RouterDecision {
  /** The chosen models, in fallback order. */
  resolvedModels?: string[];
  candidates?: RouterCandidate[];
  /** Why the route was chosen or kept, e.g. `initial` or `continuation`. */
  reason?: string;
  /** `default` or `agentic`. */
  pipeline?: string;
  version?: string;
  /** `models_ignored` when no model in `hosted.models` was in the router's pool. */
  listFallback?: string;
  listTierCap?: string;
  maxFallback?: string;
  advisorModel?: string;
}

/**
 * Token counts and cost from a response's `usage`, the same across the three formats. Every
 * field is optional because providers and errors leave some out.
 */
export interface Usage {
  /** All input tokens, cached ones included. */
  inputTokens?: number;
  outputTokens?: number;
  /** Input tokens read from the prompt cache. */
  cachedTokens?: number;
  /** Input tokens written to the prompt cache. */
  cacheWriteTokens?: number;
  /** What OpenRouter charged, in USD. */
  cost?: number;
}

export interface ScanResult {
  /** The response's top-level `model`: the model that actually served the request. */
  servedModel: string | null;
  /** `openrouter_metadata`, absent on cache hits and some errors. */
  metadata: Record<string, unknown> | null;
  /** The last `usage` the response reported, or null if none. */
  usage: Usage | null;
}

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * Normalizes a `usage` object. Chat Completions and Responses count cached tokens inside the
 * input; Anthropic Messages counts them separately, so they are added back in.
 */
export function readUsage(raw: unknown): Usage | null {
  if (!isPlainObject(raw)) return null;
  const usage: Usage = {};
  const set = (key: keyof Usage, value: unknown) => {
    const n = count(value);
    if (n !== undefined) usage[key] = n;
  };
  const details = isPlainObject(raw.prompt_tokens_details)
    ? raw.prompt_tokens_details
    : isPlainObject(raw.input_tokens_details)
      ? raw.input_tokens_details
      : null;
  if (raw.prompt_tokens !== undefined || details) {
    set("inputTokens", raw.prompt_tokens ?? raw.input_tokens);
    set("outputTokens", raw.completion_tokens ?? raw.output_tokens);
    set("cachedTokens", details?.cached_tokens);
    set("cacheWriteTokens", details?.cache_write_tokens);
  } else {
    const read = count(raw.cache_read_input_tokens);
    const write = count(raw.cache_creation_input_tokens);
    const input = count(raw.input_tokens);
    if (input !== undefined) usage.inputTokens = input + (read ?? 0) + (write ?? 0);
    set("outputTokens", raw.output_tokens);
    if (read !== undefined) usage.cachedTokens = read;
    if (write !== undefined) usage.cacheWriteTokens = write;
  }
  set("cost", raw.cost);
  return Object.keys(usage).length > 0 ? usage : null;
}

export interface ResponseScanner {
  push(chunk: Uint8Array): void;
  finish(): ScanResult;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A scanner for a response with the given `content-type`. JSON bodies are parsed once at the end.
 * Event streams are parsed event by event, and only the events that matter are decoded as JSON:
 * the first one that names a model, and any that carry `openrouter_metadata` or `usage` (the last
 * Chat chunk, Messages' `message_start`, `message_delta` and `message_stop`, Responses'
 * `response.completed`). Anything else isn't scanned. A key can't match inside a JSON string,
 * where its quotes would be escaped.
 */
export function createScanner(contentType: string | null): ResponseScanner {
  const type = contentType?.toLowerCase() ?? "";
  const result: ScanResult = { servedModel: null, metadata: null, usage: null };

  const take = (payload: string) => {
    if (
      result.servedModel !== null &&
      !payload.includes('"openrouter_metadata"') &&
      !payload.includes('"usage"')
    ) {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      return;
    }
    if (!isPlainObject(value)) return;
    // Chat chunks and JSON bodies carry these at the top level; Messages' `message_start` nests
    // them under `message`, and Responses events under `response`.
    for (const holder of [value, value.message, value.response]) {
      if (!isPlainObject(holder)) continue;
      if (result.servedModel === null && typeof holder.model === "string") {
        result.servedModel = holder.model;
      }
      if (isPlainObject(holder.openrouter_metadata)) result.metadata = holder.openrouter_metadata;
      // Messages streams report usage twice: input at the start, then the totals and cost.
      const usage = readUsage(holder.usage);
      if (usage) result.usage = { ...result.usage, ...usage };
    }
  };

  if (type.includes("text/event-stream")) return sseScanner(take, result);
  if (type.includes("json")) return jsonScanner(take, result);
  return { push() {}, finish: () => result };
}

function jsonScanner(take: (payload: string) => void, result: ScanResult): ResponseScanner {
  const chunks: Uint8Array[] = [];
  let size = 0;
  return {
    push(chunk) {
      if (size > MAX_SCAN_BYTES) return;
      size += chunk.byteLength;
      if (size > MAX_SCAN_BYTES) chunks.length = 0;
      else chunks.push(chunk);
    },
    finish() {
      if (size <= MAX_SCAN_BYTES) take(Buffer.concat(chunks).toString("utf8"));
      chunks.length = 0;
      return result;
    },
  };
}

function sseScanner(take: (payload: string) => void, result: ScanResult): ResponseScanner {
  const decoder = new TextDecoder();
  let pending = "";
  let data: string[] = [];
  let buffered = 0;
  let gaveUp = false;

  const line = (raw: string) => {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (text === "") {
      // End of an event. `[DONE]` and the `event: data` pair after it aren't JSON and are skipped.
      if (data.length > 0) take(data.join("\n"));
      data = [];
      buffered = 0;
      return;
    }
    if (!text.startsWith("data:")) return;
    const value = text.startsWith("data: ") ? text.slice(6) : text.slice(5);
    data.push(value);
    buffered += value.length;
  };

  return {
    push(chunk) {
      if (gaveUp) return;
      pending += decoder.decode(chunk, { stream: true });
      let start = 0;
      for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n", start)) {
        line(pending.slice(start, end));
        start = end + 1;
      }
      pending = pending.slice(start);
      if (pending.length + buffered > MAX_SCAN_BYTES) {
        gaveUp = true;
        pending = "";
        data = [];
      }
    },
    finish() {
      if (!gaveUp) {
        pending += decoder.decode();
        if (pending !== "") line(pending);
        line("");
      }
      return result;
    },
  };
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function candidate(value: unknown): RouterCandidate | null {
  if (!isPlainObject(value)) return null;
  const entry: RouterCandidate = {};
  const model = string(value.model);
  const effort = string(value.effort);
  const tier = string(value.tier);
  if (model !== undefined) entry.model = model;
  if (effort !== undefined) entry.effort = effort;
  if (tier !== undefined) entry.tier = tier;
  if (typeof value.estimated_cost === "number") entry.estimatedCost = value.estimated_cost;
  return entry;
}

/**
 * The jev-router entry of `openrouter_metadata.pipeline`, selected by `name` because its `type`
 * isn't documented. Null when the router didn't run or reported nothing.
 */
export function routerDecision(metadata: unknown): RouterDecision | null {
  if (!isPlainObject(metadata) || !Array.isArray(metadata.pipeline)) return null;
  const stage = metadata.pipeline.find(
    (entry) => isPlainObject(entry) && entry.name === "jev-router",
  );
  if (!isPlainObject(stage) || !isPlainObject(stage.data)) return null;
  const data = stage.data;

  const decision: RouterDecision = {};
  if (Array.isArray(data.resolved_models)) {
    decision.resolvedModels = data.resolved_models.filter(
      (m): m is string => typeof m === "string",
    );
  }
  if (Array.isArray(data.candidates)) {
    decision.candidates = data.candidates
      .slice(0, MAX_CANDIDATES)
      .map(candidate)
      .filter((entry): entry is RouterCandidate => entry !== null);
  }
  const strings = {
    reason: data.reason,
    pipeline: data.pipeline,
    version: data.version,
    listFallback: data.list_fallback,
    listTierCap: data.list_tier_cap,
    maxFallback: data.max_fallback,
    advisorModel: data.advisor_model,
  } as const;
  for (const [key, value] of Object.entries(strings)) {
    const text = string(value);
    if (text !== undefined) decision[key as keyof typeof strings] = text;
  }
  return decision;
}
