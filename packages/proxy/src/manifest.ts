import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Client } from "./clients.js";
import { stateDir } from "./log.js";

/** What a file setup changed is for. */
export type ChangeKind = "client:codex" | "client:claude" | "config" | "service";

/** A file `setup` wrote, and what it held before, so `uninstall` can put it back exactly. */
export interface FileChange {
  path: string;
  kind: ChangeKind;
  /** The file's bytes before the first `setup`, base64-encoded. Null if it didn't exist. */
  original: string | null;
  /** The original's permission bits. */
  mode: number | null;
  /** SHA-256 of what `setup` last wrote, to notice later edits. */
  written: string;
}

export interface ServiceRecord {
  kind: "launchd" | "systemd";
  /** The launchd label or systemd unit name. */
  name: string;
  /** The plist or unit file. */
  path: string;
}

/** `setup.json` in the state directory: everything `uninstall` needs to undo `setup`. */
export interface Manifest {
  version: 1;
  files: FileChange[];
  service: ServiceRecord | null;
  /** Where `setup` stored the key, for `doctor` and `uninstall --purge`. */
  keySource: string | null;
  /** The clients `setup` pointed at switchkick. */
  clients?: Client[];
}

export function manifestPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "setup.json");
}

export const emptyManifest = (): Manifest => ({
  version: 1,
  files: [],
  service: null,
  keySource: null,
});

export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** The manifest, or null if `setup` never ran. Throws if it exists but can't be read. */
export async function readManifest(env: NodeJS.ProcessEnv): Promise<Manifest | null> {
  const path = manifestPath(env);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(text) as Manifest;
  if (parsed?.version !== 1 || !Array.isArray(parsed.files)) {
    throw new Error(`${path} isn't a switchkick setup record`);
  }
  return parsed;
}

/**
 * Writes the manifest, readable only by the user: it holds copies of client settings files, which
 * can contain credentials of their own.
 */
export async function writeManifest(env: NodeJS.ProcessEnv, manifest: Manifest): Promise<void> {
  await atomicWrite(manifestPath(env), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
}

/** The file's bytes, or null if it doesn't exist. */
export async function readBytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Where to write `path`: through a symlink to its target, so dotfile links keep working. */
async function writeTarget(path: string): Promise<string> {
  const info = await lstat(path).catch(() => null);
  return info?.isSymbolicLink() ? realpath(path) : path;
}

/** Writes through a temporary file and a rename, so a crash never leaves half a file. */
export async function atomicWrite(path: string, data: string | Buffer, mode: number) {
  const target = await writeTarget(path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.switchkick-${process.pid}.tmp`;
  await writeFile(temporary, data, { mode });
  await chmod(temporary, mode);
  await rename(temporary, target);
}

async function fileMode(path: string): Promise<number | null> {
  const info = await lstat(await writeTarget(path)).catch(() => null);
  return info ? info.mode & 0o777 : null;
}

/**
 * Writes `content` to `path` and records the change. The first time a path is changed its
 * original bytes are saved; a later `setup` keeps that first original, so `uninstall` always
 * returns to the state before switchkick.
 */
export async function recordWrite(
  manifest: Manifest,
  path: string,
  kind: ChangeKind,
  content: string,
  defaultMode = 0o644,
): Promise<void> {
  let change = manifest.files.find((f) => f.path === path);
  if (!change) {
    const original = await readBytes(path);
    change = {
      path,
      kind,
      original: original?.toString("base64") ?? null,
      mode: original ? await fileMode(path) : null,
      written: "",
    };
    manifest.files.push(change);
  }
  const mode = (await fileMode(path)) ?? change.mode ?? defaultMode;
  await atomicWrite(path, content, mode);
  change.written = sha256(content);
}

export type RestoreOutcome =
  | { path: string; action: "restored" | "removed" }
  /** The file changed after setup; that version was saved to `kept` before restoring. */
  | { path: string; action: "restored" | "removed"; kept: string }
  | { path: string; action: "unchanged" };

/**
 * Puts a file back as it was before `setup`: the original bytes and mode, or no file if there
 * was none. If someone edited the file after `setup`, their version is kept next to it.
 */
export async function restoreFile(change: FileChange): Promise<RestoreOutcome> {
  const current = await readBytes(change.path);
  let kept: string | undefined;
  if (current !== null && sha256(current) !== change.written) {
    const original = change.original === null ? null : Buffer.from(change.original, "base64");
    if (original?.equals(current)) {
      return { path: change.path, action: "unchanged" };
    }
    kept = `${change.path}.switchkick-uninstall`;
    await atomicWrite(kept, current, (await fileMode(change.path)) ?? 0o600);
  }
  let action: "restored" | "removed";
  if (change.original === null) {
    await rm(await writeTarget(change.path), { force: true });
    action = "removed";
  } else {
    await atomicWrite(change.path, Buffer.from(change.original, "base64"), change.mode ?? 0o644);
    action = "restored";
  }
  return kept ? { path: change.path, action, kept } : { path: change.path, action };
}
