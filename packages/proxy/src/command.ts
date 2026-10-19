import { type ParseArgsConfig, parseArgs } from "node:util";
import { type Endpoint, endpointUrl } from "./clients.js";
import { ConfigError, type LoadedConfig, loadConfig } from "./config.js";
import type { FoundKey } from "./credentials.js";
import type { System } from "./system.js";

/** What a command gets from the process it runs in. Tests pass stand-ins for all of it. */
export interface CommandIo {
  env: NodeJS.ProcessEnv;
  stdout(text: string): void;
  stderr(text: string): void;
  system: System;
  findApiKey(env: NodeJS.ProcessEnv): Promise<FoundKey>;
}

/** A command's failure, printed as `switchkick: <message>` with exit code 1. */
export class CommandError extends Error {
  override name = "CommandError";
}

/** Parses a command's arguments, turning unknown options into a {@link CommandError}. */
export function parseCommand<T extends NonNullable<ParseArgsConfig["options"]>>(
  argv: string[],
  options: T,
  help: string,
) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: { ...options, help: { type: "boolean", short: "h" } } as T & {
        help: { type: "boolean"; short: "h" };
      },
    });
  } catch (error) {
    throw new CommandError(`${(error as Error).message}\n\n${help}`);
  }
}

/** Loads the config the way `serve` does, as a {@link CommandError} when it's invalid. */
export async function loadCommandConfig(
  path: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<LoadedConfig> {
  try {
    return await loadConfig(path, env);
  } catch (error) {
    if (error instanceof ConfigError) throw new CommandError(error.message);
    throw error;
  }
}

/** Where clients reach switchkick, for the config's server settings. */
export function configEndpoint(loaded: LoadedConfig, env: NodeJS.ProcessEnv): Endpoint {
  const { host, port } = loaded.config.server;
  return { url: endpointUrl(host, port), token: env.SWITCHKICK_TOKEN?.trim() || null };
}

/** Splits `--client a,b --client c` into its values. */
export function listOption(values: string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}
