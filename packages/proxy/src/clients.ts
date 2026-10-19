import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import type { System } from "./system.js";

/** Clients `setup` can point at switchkick. */
export const CLIENTS = ["codex", "claude", "openai"] as const;
export type Client = (typeof CLIENTS)[number];

export const CLIENT_NAMES: Record<Client, string> = {
  codex: "Codex",
  claude: "Claude Code",
  openai: "OpenAI SDK apps",
};

/** Where clients reach switchkick. */
export interface Endpoint {
  /** e.g. `http://127.0.0.1:8787`, without a trailing slash. */
  url: string;
  /** `SWITCHKICK_TOKEN`, when switchkick requires one. */
  token: string | null;
}

/** The API key clients send. switchkick ignores it unless `SWITCHKICK_TOKEN` is set. */
export const PLACEHOLDER_KEY = "switchkick";

/** The id of switchkick's provider entry in Codex's config. */
export const CODEX_PROVIDER = "switchkick";

/**
 * Claude Code's output cap setup writes. Claude Code otherwise asks for up to 128,000 output
 * tokens, and OpenRouter refuses (402) requests whose worst-case cost exceeds the account's credit.
 */
export const CLAUDE_MAX_OUTPUT_TOKENS = "32000";
/** Claude Code's own maximum, which applies when `CLAUDE_CODE_MAX_OUTPUT_TOKENS` isn't set. */
export const CLAUDE_DEFAULT_MAX_TOKENS = 128_000;

/** Addresses that mean "every interface", which clients reach on loopback. */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", ""]);

/** The URL clients use for a server listening on `host:port`. */
export function endpointUrl(host: string, port: number): string {
  let name = WILDCARD_HOSTS.has(host) ? "127.0.0.1" : host;
  if (name.includes(":") && !name.startsWith("[")) name = `[${name}]`;
  return `http://${name}:${port}`;
}

/** `$CODEX_HOME/config.toml`, by default `~/.codex/config.toml`. */
export function codexConfigPath(system: Pick<System, "env" | "home">): string {
  return join(system.env.CODEX_HOME || join(system.home, ".codex"), "config.toml");
}

/** `$CLAUDE_CONFIG_DIR/settings.json`, by default `~/.claude/settings.json`. */
export function claudeSettingsPath(system: Pick<System, "env" | "home">): string {
  return join(system.env.CLAUDE_CONFIG_DIR || join(system.home, ".claude"), "settings.json");
}

/** The settings file `setup` edits for a client. `openai` has none: apps read the environment. */
export function clientSettingsPath(client: Client, system: Pick<System, "env" | "home">) {
  if (client === "codex") return codexConfigPath(system);
  if (client === "claude") return claudeSettingsPath(system);
  return null;
}

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** The provider table Codex needs. Codex sends no key unless `env_key` names a variable. */
function codexProvider(endpoint: Endpoint): Record<string, string> {
  return {
    name: "switchkick",
    base_url: `${endpoint.url}/v1`,
    wire_api: "responses",
    ...(endpoint.token ? { env_key: "SWITCHKICK_TOKEN" } : {}),
  };
}

const tomlString = (value: string) => JSON.stringify(value);

/**
 * Shell lines that point a client at switchkick for one session, for `switchkick env`. Codex reads
 * its provider from its config file rather than the environment, so it gets an alias that passes
 * the provider on the command line.
 */
export function clientEnv(client: Client, endpoint: Endpoint): string {
  const key = endpoint.token ?? PLACEHOLDER_KEY;
  const lines: string[] = [];
  if (client === "openai") {
    lines.push(`export OPENAI_BASE_URL=${quote(`${endpoint.url}/v1`)}`);
    lines.push(`export OPENAI_API_KEY=${quote(key)}`);
  } else if (client === "claude") {
    lines.push(`export ANTHROPIC_BASE_URL=${quote(endpoint.url)}`);
    lines.push(`export ANTHROPIC_AUTH_TOKEN=${quote(key)}`);
    lines.push(`export CLAUDE_CODE_MAX_OUTPUT_TOKENS=${CLAUDE_MAX_OUTPUT_TOKENS}`);
  } else {
    const table = Object.entries(codexProvider(endpoint))
      .map(([k, v]) => `${k}=${tomlString(v)}`)
      .join(",");
    if (endpoint.token) lines.push(`export SWITCHKICK_TOKEN=${quote(endpoint.token)}`);
    lines.push(
      "# Codex reads its provider from config.toml, so this alias passes it on the command line.",
      `alias codex=${quote(
        `codex -c model_provider=${CODEX_PROVIDER} -c ${quote(`model_providers.${CODEX_PROVIDER}={${table}}`)}`,
      )}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export class ClientConfigError extends Error {
  override name = "ClientConfigError";
}

/**
 * The table a TOML header line opens, e.g. `model_providers.x` for `[model_providers.x]` or
 * `[[profiles]]` (with an optional comment), or null for any other line. String operations rather
 * than a regex, which would backtrack polynomially on long runs of spaces.
 */
function tableHeader(line: string): { name: string; array: boolean } | null {
  const text = line.trim();
  if (!text.startsWith("[")) return null;
  const array = text.startsWith("[[");
  const open = array ? 2 : 1;
  const close = text.indexOf(array ? "]]" : "]", open);
  if (close === -1) return null;
  const name = text.slice(open, close).trim();
  const rest = text.slice(close + open).trim();
  if (name === "" || /[=,[\]]/.test(name) || (rest !== "" && !rest.startsWith("#"))) return null;
  return { name, array };
}

const isTableHeader = (line: string) => tableHeader(line) !== null;

/** Whether the line opens switchkick's own provider table. */
function isOurTable(line: string): boolean {
  const header = tableHeader(line);
  if (!header || header.array) return false;
  const name = header.name.split(".").map((part) => part.trim());
  return (
    name.length === 2 &&
    name[0] === "model_providers" &&
    (name[1] === CODEX_PROVIDER || name[1] === `"${CODEX_PROVIDER}"`)
  );
}

const MODEL_PROVIDER_KEY = /^\s*model_provider\s*=/;
const CODEX_COMMENT =
  "# Added by `switchkick setup`; `switchkick uninstall` restores the original file.";

/**
 * Parsed TOML as plain JSON values. smol-toml's tables have no prototype and its dates are
 * objects, which a deep comparison would trip over.
 */
function parsePlainToml(text: string): Record<string, unknown> {
  return JSON.parse(JSON.stringify(parseToml(text)));
}

function parseCodex(text: string, path: string): Record<string, unknown> {
  try {
    return parsePlainToml(text);
  } catch (error) {
    throw new ClientConfigError(
      `${path} isn't valid TOML, so switchkick won't edit it: ${(error as Error).message.split("\n")[0]}`,
    );
  }
}

/** The parsed config without what switchkick sets, for checking that an edit changed nothing else. */
function withoutOurs(config: Record<string, unknown>): Record<string, unknown> {
  const { model_provider: _, ...rest } = config;
  const providers = rest.model_providers;
  if (providers && typeof providers === "object" && !Array.isArray(providers)) {
    const { [CODEX_PROVIDER]: __, ...others } = providers as Record<string, unknown>;
    if (Object.keys(others).length > 0) rest.model_providers = others;
    else delete rest.model_providers;
  }
  return rest;
}

/**
 * Codex's config with switchkick as the model provider. The text is edited in place, so comments
 * and layout survive: `model_provider` is set among the top-level keys, and a
 * `[model_providers.switchkick]` table replaces any earlier one. The result is parsed back and
 * compared with the original, and if anything besides those two changed, nothing is written.
 */
export function wireCodex(original: string | null, endpoint: Endpoint, path: string): string {
  const text = original ?? "";
  const before = parseCodex(text, path);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);
  const trailingNewline = lines.length > 0 && lines.at(-1) === "";
  if (trailingNewline) lines.pop();

  // Drop an earlier switchkick table, down to the next table header.
  let start = lines.findIndex(isOurTable);
  if (start !== -1) {
    let end = start + 1;
    if (lines[start - 1] === CODEX_COMMENT) start--;
    while (end < lines.length && !isTableHeader(lines[end] as string)) end++;
    lines.splice(start, end - start);
  }
  while (lines.length > 0 && (lines.at(-1) as string).trim() === "") lines.pop();

  const setting = `model_provider = ${tomlString(CODEX_PROVIDER)}`;
  const firstTable = lines.findIndex(isTableHeader);
  const topLevelEnd = firstTable === -1 ? lines.length : firstTable;
  const existing = lines.slice(0, topLevelEnd).findIndex((line) => MODEL_PROVIDER_KEY.test(line));
  if (existing !== -1) {
    lines[existing] = setting;
  } else if (firstTable === -1) {
    lines.push(setting);
  } else {
    // Before the first table, after the top-level keys, so the key stays top-level.
    let at = firstTable;
    while (at > 0 && (lines[at - 1] as string).trim() === "") at--;
    lines.splice(at, 0, setting);
  }

  const table = Object.entries(codexProvider(endpoint)).map(([k, v]) => `${k} = ${tomlString(v)}`);
  if (lines.length > 0) lines.push("");
  lines.push(CODEX_COMMENT, `[model_providers.${CODEX_PROVIDER}]`, ...table);
  const result = `${lines.join(eol)}${eol}`;

  let after: Record<string, unknown> | null = null;
  try {
    after = parsePlainToml(result);
  } catch {
    // Reported below: the edit broke the file.
  }
  const providers = after?.model_providers as Record<string, unknown> | undefined;
  if (
    after === null ||
    after.model_provider !== CODEX_PROVIDER ||
    !isDeepStrictEqual(providers?.[CODEX_PROVIDER], codexProvider(endpoint)) ||
    !isDeepStrictEqual(withoutOurs(after), withoutOurs(before))
  ) {
    throw new ClientConfigError(
      `switchkick couldn't safely edit ${path}. Add this to it yourself:\n\n` +
        `model_provider = ${tomlString(CODEX_PROVIDER)}\n\n[model_providers.${CODEX_PROVIDER}]\n` +
        `${table.join("\n")}\n`,
    );
  }
  return result;
}

export type WiringState = { wired: true } | { wired: false; reason: string };

/** Whether Codex's config sends requests to `endpoint`. */
export function codexWiring(text: string | null, endpoint: Endpoint): WiringState {
  if (text === null) return { wired: false, reason: "no config file" };
  let config: Record<string, unknown>;
  try {
    config = parsePlainToml(text);
  } catch {
    return { wired: false, reason: "the config isn't valid TOML" };
  }
  if (config.model_provider !== CODEX_PROVIDER) {
    return {
      wired: false,
      reason: `model_provider is ${config.model_provider === undefined ? "not set" : JSON.stringify(config.model_provider)}`,
    };
  }
  const provider = (
    config.model_providers as Record<string, Record<string, unknown>> | undefined
  )?.[CODEX_PROVIDER];
  const url = `${endpoint.url}/v1`;
  if (provider?.base_url !== url) {
    return { wired: false, reason: `the switchkick provider's base_url isn't ${url}` };
  }
  return { wired: true };
}

function parseClaude(text: string, path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ClientConfigError(
      `${path} isn't valid JSON, so switchkick won't edit it: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ClientConfigError(`${path} isn't a JSON object, so switchkick won't edit it.`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Claude Code's user settings with its `env` pointing at switchkick: the base URL, a placeholder
 * key (or the token), and an output cap unless one is already set. Other settings are kept.
 */
export function wireClaude(original: string | null, endpoint: Endpoint, path: string): string {
  const settings = original === null || original.trim() === "" ? {} : parseClaude(original, path);
  const env = settings.env ?? {};
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new ClientConfigError(`"env" in ${path} isn't an object, so switchkick won't edit it.`);
  }
  const next: Record<string, unknown> = { ...(env as Record<string, unknown>) };
  next.ANTHROPIC_BASE_URL = endpoint.url;
  // Claude Code prefers the auth token over an API key, so a key set elsewhere stays unused.
  next.ANTHROPIC_AUTH_TOKEN = endpoint.token ?? PLACEHOLDER_KEY;
  next.CLAUDE_CODE_MAX_OUTPUT_TOKENS ??= CLAUDE_MAX_OUTPUT_TOKENS;
  settings.env = next;
  const eol = original?.includes("\r\n") ? "\r\n" : "\n";
  return `${JSON.stringify(settings, null, 2).replaceAll("\n", eol)}${eol}`;
}

/** Claude Code's settings `env`, or null if the file is missing or unreadable. */
export function claudeEnv(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const settings = JSON.parse(text);
    const env = settings?.env;
    return typeof env === "object" && env !== null && !Array.isArray(env) ? env : {};
  } catch {
    return null;
  }
}

/** Whether Claude Code's settings send requests to `endpoint`. */
export function claudeWiring(text: string | null, endpoint: Endpoint): WiringState {
  if (text === null) return { wired: false, reason: "no settings file" };
  const env = claudeEnv(text);
  if (env === null) return { wired: false, reason: "the settings aren't valid JSON" };
  if (env.ANTHROPIC_BASE_URL !== endpoint.url) {
    return { wired: false, reason: `env.ANTHROPIC_BASE_URL isn't ${endpoint.url}` };
  }
  return { wired: true };
}
