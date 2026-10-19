import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

/** What a command run without a shell returned. */
export interface CommandOutput {
  /** 0 on success. */
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Everything the setup, doctor and uninstall commands do to the machine outside the files under
 * {@link System.home} and the XDG directories goes through here, so tests can stand in for it.
 */
export interface System {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** The user's home directory. Client settings live under it. */
  home: string;
  /** The user id, for launchd's `gui/<uid>` domain. */
  uid: number;
  /** The Node.js binary running switchkick. */
  execPath: string;
  /** The real path of the `switchkick` script being run. */
  scriptPath: string;
  /** Runs a command without a shell, with `input` on stdin. Resolves null if it doesn't exist. */
  exec(command: string, args: string[], input?: string): Promise<CommandOutput | null>;
  fetch: typeof fetch;
  /**
   * Asks a question on the terminal and resolves the answer. With `hidden`, typing isn't echoed.
   * Resolves null when there is no terminal to ask on.
   */
  prompt(question: string, options?: { hidden?: boolean }): Promise<string | null>;
}

/** Long enough for someone to answer a macOS Keychain access prompt. */
const COMMAND_TIMEOUT_MS = 60_000;

export function exec(
  command: string,
  args: string[],
  input?: string,
): Promise<CommandOutput | null> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { timeout: COMMAND_TIMEOUT_MS, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr, timedOut: false });
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(null);
        const code = typeof error.code === "number" ? error.code : -1;
        resolve({ code, stdout, stderr, timedOut: error.killed === true });
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}

/** Reads one line from the terminal, optionally without echoing it. */
function prompt(question: string, options: { hidden?: boolean } = {}): Promise<string | null> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stderr, terminal: true });
    if (options.hidden) {
      // readline echoes through `_writeToOutput`; replacing it is the documented-by-usage way to
      // mute it, and keeps line editing working.
      const muted = rl as unknown as { _writeToOutput(text: string): void };
      let asked = false;
      muted._writeToOutput = (text: string) => {
        if (!asked) {
          asked = true;
          stderr.write(text);
        } else if (text.includes("\n") || text.includes("\r")) {
          stderr.write("\n");
        }
      };
    }
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
    rl.on("close", () => {
      if (!answered) resolve(null);
    });
  });
}

function scriptPath(): string {
  const script = process.argv[1] ?? "";
  try {
    return realpathSync(script);
  } catch {
    return script;
  }
}

export function defaultSystem(env: NodeJS.ProcessEnv = process.env): System {
  return {
    env,
    platform: process.platform,
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    execPath: process.execPath,
    scriptPath: scriptPath(),
    exec,
    fetch: (input, init) => fetch(input, init),
    prompt,
  };
}
