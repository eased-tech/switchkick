import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./config.js";

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

/** Long enough for someone to answer a macOS Keychain access prompt. */
const STORE_TIMEOUT_MS = 60_000;

export function defaultCredentialDeps(env: NodeJS.ProcessEnv = process.env): CredentialDeps {
  return {
    env,
    platform: process.platform,
    run: (command, args) =>
      new Promise((resolve) => {
        execFile(
          command,
          args,
          { timeout: STORE_TIMEOUT_MS, encoding: "utf8", windowsHide: true },
          (error, stdout) => {
            if (!error) return resolve({ code: 0, stdout, timedOut: false });
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(null);
            const code = typeof error.code === "number" ? error.code : -1;
            resolve({ code, stdout: "", timedOut: error.killed === true });
          },
        );
      }),
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
