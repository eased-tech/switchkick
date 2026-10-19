import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isTier, type SessionState, type SessionStore } from "@switchkick/core";
import { stateDir } from "./log.js";

/** `sessions.json` in the state directory, next to the decision log. */
export function defaultSessionsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "sessions.json");
}

/**
 * The session file: session keys (hashes) and their routing state. It holds no prompt text, but
 * it is written 0600 like the log, since it shows when and how often the user works.
 */
interface SessionFile {
  version: 1;
  sessions: [key: string, state: SessionState][];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const nullableString = (v: unknown) => v === null || typeof v === "string";

function isState(v: unknown): v is SessionState {
  return (
    isRecord(v) &&
    (v.tier === null || isTier(v.tier)) &&
    typeof v.provisional === "boolean" &&
    typeof v.trusted === "boolean" &&
    typeof v.lastSeenAt === "number" &&
    Number.isFinite(v.lastSeenAt) &&
    nullableString(v.root)
  );
}

/** Sessions from the file's text. Malformed entries are skipped; a malformed file gives none. */
export function parseSessions(text: string): [string, SessionState][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.sessions)) return [];
  return parsed.sessions.filter(
    (entry): entry is [string, SessionState] =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === "string" &&
      /^[0-9a-f]{64}$/.test(entry[0]) &&
      isState(entry[1]),
  );
}

export interface SessionFileOptions {
  path: string;
  store: SessionStore;
  /** How often to save, when anything changed. */
  intervalMs?: number;
  /** Called once, on the first failure to read or write. Later failures are dropped silently. */
  onError?: (error: unknown) => void;
}

export interface PersistedSessions {
  /** Writes the sessions now if anything changed since the last save. */
  save(): Promise<void>;
  /** Stops saving periodically, after a final save. */
  close(): Promise<void>;
}

export const DEFAULT_SAVE_INTERVAL_MS = 30_000;

/**
 * Keeps a session store on disk, so a restart doesn't forget each session's tier (and drop a
 * conversation to a lower tier, losing its prompt cache). Loads the file into `store`, then saves it
 * every `intervalMs` when it has changed, and on `close`. Writes go to a temporary file that is
 * renamed into place, so a crash never leaves a half-written file.
 */
export async function persistSessions(options: SessionFileOptions): Promise<PersistedSessions> {
  const { path, store } = options;
  let reported = false;
  const report = (error: unknown) => {
    if (!reported) {
      reported = true;
      options.onError?.(error);
    }
  };

  try {
    for (const [key, state] of parseSessions(await readFile(path, "utf8"))) store.set(key, state);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") report(error);
  }

  let saved = store.version;
  let writing: Promise<void> = Promise.resolve();
  const save = () => {
    writing = writing.then(async () => {
      const version = store.version;
      if (version === saved) return;
      const file: SessionFile = { version: 1, sessions: store.entries() };
      const temporary = `${path}.${process.pid}.tmp`;
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(temporary, `${JSON.stringify(file)}\n`, { mode: 0o600 });
        await rename(temporary, path);
        saved = version;
      } catch (error) {
        report(error);
      }
    });
    return writing;
  };

  const timer = setInterval(save, options.intervalMs ?? DEFAULT_SAVE_INTERVAL_MS);
  timer.unref();
  return {
    save,
    async close() {
      clearInterval(timer);
      await save();
    },
  };
}
