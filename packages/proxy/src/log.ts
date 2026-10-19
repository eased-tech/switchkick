import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Tier } from "@switchkick/core";
import type { ApiFormat } from "./formats.js";
import type { CostTier } from "./hosted.js";
import type { JevLog, LocalLogFields } from "./local.js";
import type { RouterDecision } from "./metadata.js";

/**
 * One line of the decision log, written per request. It records how the request was routed and
 * what came back, and never any prompt or response content.
 */
export interface DecisionLogEntry {
  /** ISO 8601 timestamp of when the request arrived. */
  ts: string;
  format: ApiFormat;
  stream: boolean;
  mode: "static" | "hosted" | "local";
  /** The tier switchkick routed to. Null in hosted mode, where the router chooses, and for pins. */
  tier: Tier | null;
  /** The `model` the client asked for, before switchkick rewrote it. */
  requestedModel: string | null;
  /** The model switchkick sent upstream: `typesafe/jev-router` in hosted mode. */
  model: string;
  /** The reasoning effort switchkick set, or null if the client's was left alone. */
  effort: string | null;
  reason: string;
  /** The HTTP status returned to the client. 499 means the client disconnected first. */
  status: number;
  /** OpenRouter's `x-generation-id`, for looking the request up later. */
  generationId: string | null;
  /** Time from receiving the request to OpenRouter's response headers. */
  upstreamMs: number | null;
  /** Set when switchkick answered with its own error instead of OpenRouter's response. */
  error?: string;
  /** The underlying failure code for upstream errors, e.g. `ECONNREFUSED`. */
  cause?: string;
  /** Changes switchkick made to the request beyond the model, e.g. `store_rewritten`. */
  warnings?: string[];
  /** Hosted mode: the router's cost tier. */
  costTier?: CostTier;
  /**
   * Hosted mode: the `model` OpenRouter's response names, i.e. the model that served the request.
   * Null when the response didn't say, e.g. an error.
   */
  servedModel?: string | null;
  /** Hosted mode: what the router reported. Null on cache hits, errors and fallbacks. */
  router?: RouterDecision | null;
  /** Hosted mode: set when the router was unavailable and the request was retried in static mode. */
  fallback?: "static";
  /** Local mode: `human`, `inherit`, `subagent` or `side_call`. */
  turn?: LocalLogFields["turn"];
  /** Local mode: a short hash identifying the session. */
  session?: string;
  /** Local mode: the kind of secret found in the request's message (never the secret itself). */
  secret?: string;
  /** Local mode: the session had been idle long enough to start afresh. */
  idleReset?: true;
  /** Local mode: Jev's answer or failure. Null when Jev wasn't asked. */
  jev?: JevLog | null;
}

export interface DecisionLog {
  /** Must never throw: a logging failure can't be allowed to fail a request. */
  write(entry: DecisionLogEntry): void;
}

export const DEFAULT_LOG_MAX_BYTES = 50 * 1024 * 1024;

/** `$XDG_STATE_HOME/switchkick`, falling back to `~/.local/state/switchkick`. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "switchkick");
}

/** `decisions.jsonl` in {@link stateDir}. */
export function defaultLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "decisions.jsonl");
}

export interface FileLogOptions {
  path: string;
  /** When the file would grow past this, it is renamed to `<path>.1` and a new one started. */
  maxBytes?: number;
  /** Called once, on the first write failure. Later failures are dropped silently. */
  onError?: (error: unknown) => void;
}

export interface FileLog extends DecisionLog {
  /** Resolves once every entry written so far has reached the file (or failed). */
  flush(): Promise<void>;
}

/**
 * Append-only JSONL log. Writes are queued so lines never interleave, and the file is created
 * with mode 0600 because it reveals which models and endpoints the user calls.
 */
export function createFileLog(options: FileLogOptions): FileLog {
  const { path } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  let queue: Promise<void> = Promise.resolve();
  let size: number | null = null;
  let reported = false;

  async function append(line: string): Promise<void> {
    if (size === null) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      size = await stat(path).then(
        (s) => s.size,
        () => 0,
      );
    }
    const bytes = Buffer.byteLength(line);
    if (size > 0 && size + bytes > maxBytes) {
      await rename(path, `${path}.1`);
      size = 0;
    }
    await appendFile(path, line, { mode: 0o600 });
    size += bytes;
  }

  return {
    write(entry) {
      const line = `${JSON.stringify(entry)}\n`;
      queue = queue
        .then(() => append(line))
        .catch((error: unknown) => {
          // Re-stat on the next write, in case the file was moved or the directory removed.
          size = null;
          if (!reported) {
            reported = true;
            options.onError?.(error);
          }
        });
    },
    flush: () => queue,
  };
}

export const NO_LOG: DecisionLog = { write() {} };
