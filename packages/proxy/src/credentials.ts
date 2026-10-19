import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir } from "./config.js";
import { exec, type System } from "./system.js";

/** The credential-store entry switchkick reads, and `setup` will write. */
export const KEY_SERVICE = "switchkick";
export const KEY_ACCOUNT = "openrouter";

export interface CommandResult {
  /** 0 on success. */
  code: number;
  stdout: string;
  timedOut: boolean;
}

export interface CredentialDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Runs a command without a shell. Resolves null if the command doesn't exist. */
  run(command: string, args: string[]): Promise<CommandResult | null>;
  readFile(path: string): Promise<string>;
  /** The file's permission bits, or null if it doesn't exist. */
  fileMode(path: string): Promise<number | null>;
}

export interface FoundKey {
  key: string;
  /** Where the key came from, for startup output. Never the key itself. */
  source: string;
}

export class CredentialError extends Error {
  override name = "CredentialError";
}

export function defaultCredentialDeps(env: NodeJS.ProcessEnv = process.env): CredentialDeps {
  return {
    env,
    platform: process.platform,
    run: async (command, args) => {
      const result = await exec(command, args);
      // Only a successful lookup's output is kept: a failure's could still hold the secret.
      return result && { ...result, stdout: result.code === 0 ? result.stdout : "" };
    },
    readFile: (path) => readFile(path, "utf8"),
    fileMode: (path) =>
      stat(path).then(
        (s) => s.mode & 0o777,
        () => null,
      ),
  };
}

/** `$XDG_CONFIG_HOME/switchkick/env`: a KEY=value file for machines without a credential store. */
export function envFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "env");
}

interface Store {
  name: string;
  command: string;
  args: string[];
  /** Exit code meaning "no such entry", as opposed to a failure worth reporting. */
  notFound: number;
}

function credentialStore(platform: NodeJS.Platform): Store | null {
  if (platform === "darwin") {
    return {
      name: "macOS Keychain",
      command: "security",
      args: ["find-generic-password", "-s", KEY_SERVICE, "-a", KEY_ACCOUNT, "-w"],
      notFound: 44,
    };
  }
  if (platform === "linux") {
    return {
      name: "Secret Service (libsecret)",
      command: "secret-tool",
      args: ["lookup", "service", KEY_SERVICE, "account", KEY_ACCOUNT],
      notFound: 1,
    };
  }
  return null;
}

/** Reads `OPENROUTER_API_KEY` from KEY=value lines, allowing `export`, quotes and comments. */
export function parseEnvFile(text: string): string | null {
  // Plain string operations rather than regexes with nested quantifiers, which backtrack
  // polynomially on long runs of spaces.
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (line.startsWith("export ") || line.startsWith("export\t")) line = line.slice(7).trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1 || line.slice(0, eq).trim() !== "OPENROUTER_API_KEY") continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trimEnd();
    }
    return value || null;
  }
  return null;
}

/**
 * Finds the OpenRouter API key. The first source that has one wins:
 * 1. the `OPENROUTER_API_KEY` environment variable;
 * 2. the OS credential store (service `switchkick`, account `openrouter`);
 * 3. the env file, which must not be readable by other users.
 * Later sources are not consulted, so a set variable never triggers a Keychain prompt.
 */
export async function findApiKey(
  deps: CredentialDeps = defaultCredentialDeps(),
): Promise<FoundKey> {
  const fromEnv = deps.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "OPENROUTER_API_KEY" };
  const tried = ["the OPENROUTER_API_KEY environment variable"];

  const store = credentialStore(deps.platform);
  if (store) {
    const result = await deps.run(store.command, store.args);
    const where = `the ${store.name} (service "${KEY_SERVICE}", account "${KEY_ACCOUNT}")`;
    if (result === null) {
      tried.push(`${where}: \`${store.command}\` is not installed`);
    } else if (result.code === 0 && result.stdout.trim()) {
      return { key: result.stdout.trim(), source: store.name };
    } else if (result.timedOut) {
      tried.push(`${where}: timed out, possibly waiting on an access prompt`);
    } else if (result.code === store.notFound || result.code === 0) {
      tried.push(`${where}: no entry`);
    } else {
      // Exit codes only: the command's output could contain the secret.
      tried.push(`${where}: \`${store.command}\` exited with code ${result.code}`);
    }
  }

  const path = envFilePath(deps.env);
  const mode = await deps.fileMode(path);
  if (mode === null) {
    tried.push(`${path}: not found`);
  } else {
    if (deps.platform !== "win32" && (mode & 0o077) !== 0) {
      throw new CredentialError(
        `Refusing to read ${path}: other users can access it (mode ${mode.toString(8)}). ` +
          `Run: chmod 600 ${path}`,
      );
    }
    const key = parseEnvFile(await deps.readFile(path));
    if (key) return { key, source: path };
    tried.push(`${path}: no OPENROUTER_API_KEY line`);
  }

  throw new CredentialError(
    `No OpenRouter API key found. Tried:\n${tried.map((t) => `  - ${t}`).join("\n")}`,
  );
}

/** The credential store switchkick uses on this platform, or null where there is none. */
export function credentialStoreName(platform: NodeJS.Platform): string | null {
  return credentialStore(platform)?.name ?? null;
}

/** {@link CredentialDeps} backed by a {@link System}, so tests never reach the real store. */
export function systemCredentialDeps(system: System, env = system.env): CredentialDeps {
  return {
    env,
    platform: system.platform,
    run: async (command, args) => {
      const result = await system.exec(command, args);
      return result && { ...result, stdout: result.code === 0 ? result.stdout : "" };
    },
    readFile: (path) => readFile(path, "utf8"),
    fileMode: (path) =>
      stat(path).then(
        (s) => s.mode & 0o777,
        () => null,
      ),
  };
}

/**
 * The key a background service would find: the credential store or the env file, ignoring
 * `OPENROUTER_API_KEY`, which a service doesn't inherit. Null when neither has one.
 */
export async function findStoredKey(system: System): Promise<FoundKey | null> {
  const { OPENROUTER_API_KEY: _, ...env } = system.env;
  try {
    return await findApiKey(systemCredentialDeps(system, env));
  } catch (error) {
    if (error instanceof CredentialError) return null;
    throw error;
  }
}

/** Characters an OpenRouter key can contain. Anything else is refused rather than quoted. */
const KEY_PATTERN = /^[A-Za-z0-9._-]{8,512}$/;

/**
 * What's wrong with a pasted key, or null if it looks like one. `fatal` problems mean it can't be
 * stored. Never quotes the key.
 */
export function keyProblem(key: string): { message: string; fatal: boolean } | null {
  if (!KEY_PATTERN.test(key)) {
    return {
      message: "that isn't an OpenRouter key: expected 8 or more letters, digits, '.', '_' or '-'",
      fatal: true,
    };
  }
  if (!key.startsWith("sk-or-")) {
    return { message: "OpenRouter keys usually start with sk-or-", fatal: false };
  }
  return null;
}

/** Writes the env file with only the key, readable by the user alone. */
async function writeEnvFile(path: string, key: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `OPENROUTER_API_KEY=${key}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/**
 * Stores the key where {@link findApiKey} looks: the OS credential store when it works, otherwise
 * the env file. The key never appears in a command line, where other processes could see it:
 * `security` reads its command from stdin (`-i`), and `secret-tool` reads the secret from stdin.
 * Returns where the key went.
 */
export async function storeApiKey(system: System, key: string): Promise<string> {
  if (!KEY_PATTERN.test(key)) throw new CredentialError("Refusing to store a malformed key.");
  const store = credentialStore(system.platform);
  if (system.platform === "darwin" && store) {
    const result = await system.exec(
      "security",
      ["-i"],
      `add-generic-password -U -s ${KEY_SERVICE} -a ${KEY_ACCOUNT} -l switchkick -w "${key}"\n`,
    );
    if (result?.code === 0 && !/error/i.test(result.stderr)) return store.name;
  } else if (system.platform === "linux" && store) {
    const result = await system.exec(
      "secret-tool",
      ["store", "--label=switchkick", "service", KEY_SERVICE, "account", KEY_ACCOUNT],
      key,
    );
    if (result?.code === 0) return store.name;
  }
  const path = envFilePath(system.env);
  await writeEnvFile(path, key);
  return path;
}

/** Removes the key from the credential store and the env file. Returns what was removed. */
export async function deleteApiKey(system: System): Promise<string[]> {
  const removed: string[] = [];
  const store = credentialStore(system.platform);
  if (store && system.platform === "darwin") {
    const result = await system.exec("security", [
      "delete-generic-password",
      "-s",
      KEY_SERVICE,
      "-a",
      KEY_ACCOUNT,
    ]);
    if (result?.code === 0) removed.push(store.name);
  } else if (store && system.platform === "linux") {
    const before = await system.exec(store.command, store.args);
    if (before?.code === 0 && before.stdout.trim() !== "") {
      const result = await system.exec("secret-tool", [
        "clear",
        "service",
        KEY_SERVICE,
        "account",
        KEY_ACCOUNT,
      ]);
      if (result?.code === 0) removed.push(store.name);
    }
  }
  const path = envFilePath(system.env);
  if ((await stat(path).catch(() => null)) !== null) {
    await rm(path, { force: true });
    removed.push(path);
  }
  return removed;
}
