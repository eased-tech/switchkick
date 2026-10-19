import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialError, run } from "../src/index.js";
import type { CommandOutput, System } from "../src/system.js";

export interface ExecCall {
  command: string;
  args: string[];
  input?: string | undefined;
}

export type ExecHandler = (call: ExecCall) => CommandOutput | null | undefined;

export const ok = (stdout = ""): CommandOutput => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
});
export const exit = (code: number, stderr = ""): CommandOutput => ({
  code,
  stdout: "",
  stderr,
  timedOut: false,
});

export type FetchHandler = (url: string, init: RequestInit | undefined) => Response | undefined;

export interface FakeMachine {
  /** A temporary directory holding home, config and state. */
  dir: string;
  home: string;
  env: NodeJS.ProcessEnv;
  system: System;
  calls: ExecCall[];
  fetches: { url: string; init: RequestInit | undefined }[];
  prompts: string[];
  /** Answers handed to `prompt`, in order. Null means no terminal. */
  answers: (string | null)[];
  stdout: string;
  stderr: string;
  /** Runs the CLI against this machine. */
  run(argv: string[], env?: NodeJS.ProcessEnv): Promise<number>;
  cleanup(): Promise<void>;
}

/**
 * A stand-in machine: real files under a temporary directory, and scripted commands, network and
 * terminal. Nothing reaches the real Keychain, launchd, systemd, ~/.codex or ~/.claude.
 */
export async function fakeMachine(
  options: {
    platform?: NodeJS.Platform;
    exec?: ExecHandler;
    fetch?: FetchHandler;
    env?: NodeJS.ProcessEnv;
    scriptPath?: string;
  } = {},
): Promise<FakeMachine> {
  const dir = await mkdtemp(join(tmpdir(), "switchkick-machine-"));
  const home = join(dir, "home");
  await mkdir(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    PATH: join(dir, "bin"),
    USER: "tester",
    ...options.env,
  };
  const machine: FakeMachine = {
    dir,
    home,
    env,
    calls: [],
    fetches: [],
    prompts: [],
    answers: [],
    stdout: "",
    stderr: "",
    system: undefined as unknown as System,
    async run(argv, extraEnv = {}) {
      const runEnv = { ...env, ...extraEnv };
      machine.system.env = runEnv;
      const result = await run(argv, {
        env: runEnv,
        system: machine.system,
        findApiKey: async (e) => {
          if (e.OPENROUTER_API_KEY)
            return { key: e.OPENROUTER_API_KEY, source: "OPENROUTER_API_KEY" };
          throw new CredentialError("No OpenRouter API key found.");
        },
        stdout: (text) => {
          machine.stdout += text;
        },
        stderr: (text) => {
          machine.stderr += text;
        },
      });
      return result.exitCode;
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
  machine.system = {
    env,
    platform: options.platform ?? "darwin",
    home,
    uid: 501,
    execPath: "/opt/node/bin/node",
    scriptPath: options.scriptPath ?? "/opt/switchkick/dist/cli.js",
    async exec(command, args, input) {
      const call = { command, args, input };
      machine.calls.push(call);
      const handled = options.exec?.(call);
      return handled === undefined ? ok() : handled;
    },
    async fetch(input, init) {
      const url = String(input);
      machine.fetches.push({ url, init });
      const response = options.fetch?.(url, init);
      if (response) return response;
      throw new TypeError("fetch failed");
    },
    async prompt(question) {
      machine.prompts.push(question);
      return machine.answers.length > 0 ? (machine.answers.shift() as string | null) : null;
    },
  };
  return machine;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
