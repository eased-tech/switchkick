import { access, constants, mkdir } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { isLoopback } from "./access.js";
import {
  CLIENT_NAMES,
  CLIENTS,
  type Client,
  ClientConfigError,
  clientEnv,
  clientSettingsPath,
  type Endpoint,
  endpointUrl,
  wireClaude,
  wireCodex,
} from "./clients.js";
import { CommandError, type CommandIo, listOption, parseCommand } from "./command.js";
import {
  CONFIG_SCHEMA_URL,
  type Config,
  configDir,
  expandHome,
  type LoadedConfig,
  loadConfig,
  MODES,
  type Mode,
  parseConfig,
  resolveTiers,
  resolveTrusted,
} from "./config.js";
import { findStoredKey, keyProblem, storeApiKey } from "./credentials.js";
import { stateDir } from "./log.js";
import {
  emptyManifest,
  type Manifest,
  manifestPath,
  readBytes,
  readManifest,
  recordWrite,
  type ServiceRecord,
  writeManifest,
} from "./manifest.js";
import { PRESETS, type Preset, presetModels } from "./presets.js";
import {
  detectService,
  LAUNCHD_LABEL,
  launchdPlist,
  launchdPlistPath,
  lingering,
  SERVICE_KINDS,
  type ServiceChoice,
  SYSTEMD_UNIT,
  serviceCommand,
  serviceLogHint,
  startService,
  systemdUnit,
  systemdUnitPath,
} from "./service.js";
import type { System } from "./system.js";

export const SETUP_HELP = `Usage: switchkick setup [options]

Sets switchkick up to run in the background and points clients at it:

  1. Stores your OpenRouter key in the OS credential store (macOS Keychain, or libsecret on
     Linux), or in a file only you can read where there is none. A key already stored is kept.
  2. Writes a config file, unless one exists.
  3. Installs a launchd agent (macOS) or systemd user service (Linux) that runs \`switchkick serve\`.
  4. Points each client at switchkick, saving a copy of every file it changes so
     \`switchkick uninstall\` can put it back byte for byte.

Options:
  --client <name>     codex, claude or openai; repeat or comma-separate for several. Defaults to
                      the clients found on this machine, or openai if none is. For openai,
                      setup prints the environment variables to set.
  --preset <name>     Models for a new config: ${PRESETS.join(" or ")}. Defaults to
                      claude-only when Claude Code is a client, and multi-provider otherwise.
  --mode <mode>       Routing mode for a new config: ${MODES.join(", ")} (default local).
  --service <kind>    ${SERVICE_KINDS.join(", ")} (default auto: launchd on macOS, systemd on Linux).
  --config <path>     Config file to use or write (default ${configDir()}/config.yaml).
  -y, --yes           Don't ask anything. The key must then be in OPENROUTER_API_KEY or already
                      stored.

Claude Code is set up with Anthropic models only (the claude-only preset), since Anthropic
doesn't support other models in it. Choosing another preset shows a warning.
`;

/** Whether `name` is an executable on the PATH. */
async function onPath(name: string, system: System): Promise<boolean> {
  const dirs = (system.env.PATH ?? "").split(delimiter).filter(Boolean);
  const names = system.platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name];
  for (const dir of dirs) {
    for (const file of names) {
      const found = await access(join(dir, file), constants.X_OK).then(
        () => true,
        () => false,
      );
      if (found) return true;
    }
  }
  return false;
}

/** Clients installed here: their settings file's directory exists, or their command is on PATH. */
export async function detectClients(system: System): Promise<Client[]> {
  const found: Client[] = [];
  for (const client of ["codex", "claude"] as const) {
    const dir = dirname(clientSettingsPath(client, system) as string);
    const hasDir = await access(dir).then(
      () => true,
      () => false,
    );
    if (hasDir || (await onPath(client, system))) found.push(client);
  }
  return found;
}

/** The config file `setup` writes: short, with the preset's models shown for reference. */
export function configTemplate(preset: Preset, mode: Mode): string {
  const models = presetModels(preset);
  const width = Math.max(...Object.keys(models.tiers).map((t) => t.length), "trusted".length) + 1;
  const row = (name: string, model: string) => `#   ${`${name}:`.padEnd(width)} ${model}`;
  return [
    `# yaml-language-server: $schema=${CONFIG_SCHEMA_URL}`,
    "# Written by `switchkick setup`. Every key is optional; the README lists them all.",
    `preset: ${preset}`,
    `mode: ${mode}`,
    "defaultTier: balanced",
    "# The preset's models. Add a `tiers:` or `trusted:` entry to replace one:",
    ...Object.entries(models.tiers).map(([tier, target]) => row(tier, target.model)),
    row("trusted", models.trusted.model),
    "",
  ].join("\n");
}

/** Models in the config that aren't Anthropic's, which Claude Code doesn't support. */
function nonAnthropicModels(config: Config): string[] {
  const models = [
    ...Object.values(resolveTiers(config)).map((t) => t.model),
    resolveTrusted(config).model,
  ];
  return [...new Set(models.filter((m) => !m.startsWith("anthropic/")))];
}

/** Resolves when switchkick answers `/healthz` at `url`, or false after `timeoutMs`. */
export async function waitForHealth(
  system: System,
  url: string,
  timeoutMs: number,
): Promise<{ version: string } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await system.fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const body = (await response.json()) as { ok?: boolean; version?: unknown };
        if (body.ok === true) return { version: String(body.version ?? "") };
      }
    } catch {
      // Not up yet.
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new CommandError(`${name} must be one of ${allowed.join(", ")}, got "${value}".`);
  }
  return value as T;
}

async function confirm(system: System, question: string): Promise<boolean> {
  const answer = await system.prompt(`${question} [Y/n] `);
  if (answer === null) {
    throw new CommandError(
      "there's no terminal to confirm on. Pass --yes to go ahead without asking.",
    );
  }
  return answer.trim() === "" || /^y(es)?$/i.test(answer.trim());
}

/** `switchkick setup`. */
export async function setupCommand(argv: string[], io: CommandIo): Promise<number> {
  const { values, positionals } = parseCommand(
    argv,
    {
      client: { type: "string", multiple: true },
      preset: { type: "string" },
      mode: { type: "string" },
      service: { type: "string" },
      config: { type: "string" },
      yes: { type: "boolean", short: "y" },
    },
    SETUP_HELP,
  );
  if (values.help) {
    io.stdout(SETUP_HELP);
    return 0;
  }
  if (positionals.length > 0) {
    throw new CommandError(`unexpected argument: ${positionals[0]}\n\n${SETUP_HELP}`);
  }
  const { system } = io;
  const env = io.env;
  const yes = values.yes === true;
  const say = (text = "") => io.stderr(`${text}\n`);

  const requested = listOption(values.client).map((c) => oneOf("--client", c, CLIENTS));
  const presetFlag = values.preset ? oneOf("--preset", values.preset, PRESETS) : undefined;
  const mode = oneOf("--mode", values.mode ?? "local", MODES);
  const serviceChoice = oneOf<ServiceChoice>("--service", values.service ?? "auto", SERVICE_KINDS);

  // The config: an existing one is used as is.
  const chosenConfig = values.config ?? env.SWITCHKICK_CONFIG;
  const configPath = chosenConfig ? expandHome(chosenConfig) : join(configDir(env), "config.yaml");
  let existing: LoadedConfig | null = null;
  if ((await readBytes(configPath)) !== null) {
    try {
      existing = await loadConfig(configPath, env);
    } catch (error) {
      throw new CommandError(
        `${(error as Error).message}\nFix the config file, or move it aside, and run setup again.`,
      );
    }
  }

  let manifest: Manifest;
  try {
    manifest = (await readManifest(env)) ?? emptyManifest();
  } catch (error) {
    // Starting a new record would save files setup already changed as their originals.
    throw new CommandError(
      `can't read the setup record ${manifestPath(env)}: ${(error as Error).message}. It holds ` +
        "the original client settings; move it aside only if you no longer need them.",
    );
  }

  const clients = requested.length > 0 ? [...new Set(requested)] : await detectClients(system);
  if (clients.length === 0) clients.push("openai");
  const preset: Preset =
    presetFlag ??
    existing?.config.preset ??
    (clients.includes("claude") ? "claude-only" : "multi-provider");
  const template = configTemplate(preset, mode);
  const config = existing?.config ?? parseConfig({ preset, mode }, configPath);
  const { host, port } = config.server;
  const endpoint: Endpoint = {
    url: endpointUrl(host, port),
    token: env.SWITCHKICK_TOKEN?.trim() || null,
  };

  // The service.
  let serviceKind: "launchd" | "systemd" | null = null;
  let noServiceReason = "--service none";
  if (serviceChoice === "auto") {
    const detected = await detectService(system);
    serviceKind = detected.kind;
    if (detected.kind === null) noServiceReason = detected.reason;
  } else if (serviceChoice !== "none") {
    serviceKind = serviceChoice;
  }
  if (serviceKind && !isLoopback(host)) {
    throw new CommandError(
      `the config listens on ${host}, which isn't a loopback address. The background service ` +
        "only listens on loopback; run `switchkick serve` with SWITCHKICK_TOKEN for other addresses.",
    );
  }
  const command = serviceKind
    ? await serviceCommand(system, chosenConfig ? configPath : undefined)
    : null;

  // The key: one already stored is kept, so the service can read it.
  const stored = await findStoredKey(system);
  let key: string | null = null;
  if (!stored) {
    key = env.OPENROUTER_API_KEY?.trim() || null;
    if (!key && yes) {
      throw new CommandError(
        "no OpenRouter key is stored yet. Set OPENROUTER_API_KEY, or run setup without --yes to " +
          "paste it. Keys are at https://openrouter.ai/settings/keys.",
      );
    }
    if (!key) {
      say("switchkick needs an OpenRouter API key (https://openrouter.ai/settings/keys).");
      key =
        (await system.prompt("OpenRouter API key (input hidden): ", { hidden: true }))?.trim() ??
        null;
      if (key === null) {
        throw new CommandError(
          "there's no terminal to ask for the key on. Set OPENROUTER_API_KEY and pass --yes.",
        );
      }
      if (key === "") throw new CommandError("no key entered.");
    }
    const problem = keyProblem(key);
    if (problem?.fatal) throw new CommandError(problem.message);
    if (problem) say(`warning: ${problem.message}; storing it anyway.`);
  }

  // The plan.
  const lines: string[] = [];
  lines.push(
    stored
      ? `Key:     keep the one in ${stored.source}`
      : "Key:     store it (credential store, or a 0600 file)",
  );
  lines.push(
    existing
      ? `Config:  keep ${configPath}${existing.config.preset ? ` (preset ${existing.config.preset})` : ""}`
      : `Config:  write ${configPath} (preset ${preset}, mode ${mode})`,
  );
  lines.push(
    serviceKind === "launchd"
      ? `Service: launchd agent ${launchdPlistPath(system)}`
      : serviceKind === "systemd"
        ? `Service: systemd user unit ${systemdUnitPath(system)}`
        : `Service: none (${noServiceReason}); run \`switchkick serve\` yourself`,
  );
  for (const client of clients) {
    const path = clientSettingsPath(client, system);
    lines.push(
      `Client:  ${CLIENT_NAMES[client]}${path ? `, edit ${path} (a copy is kept)` : ", print the environment to set"}`,
    );
  }
  say("switchkick setup will:");
  for (const line of lines) say(`  ${line}`);
  if (
    existing &&
    (presetFlag || values.mode) &&
    (existing.config.preset !== preset || existing.config.mode !== mode)
  ) {
    say(
      `\nnote: ${configPath} already exists, so --preset and --mode aren't applied. Edit its ` +
        "`preset` and `mode` instead.",
    );
  }
  if (clients.includes("claude")) {
    const others = nonAnthropicModels(config);
    if (others.length > 0) {
      say(
        `\nwarning: Claude Code will be routed to models that aren't Anthropic's (${others.join(", ")}). ` +
          "Anthropic doesn't support that, and some Claude Code features may break.",
      );
    }
  }
  if (command?.warning) say(`\nwarning: ${command.warning}`);
  say();
  if (!yes && !(await confirm(system, "Continue?"))) {
    say("Nothing was changed.");
    return 1;
  }

  const save = () => writeManifest(env, manifest);
  let failed = false;

  if (key) {
    manifest.keySource = await storeApiKey(system, key);
    await save();
    say(`✓ Stored the key in ${manifest.keySource}.`);
  } else if (stored) {
    manifest.keySource ??= stored.source;
  }

  if (!existing) {
    await recordWrite(manifest, configPath, "config", template);
    await save();
    say(`✓ Wrote ${configPath}.`);
  }

  if (serviceKind && command) {
    const record: ServiceRecord =
      serviceKind === "launchd"
        ? { kind: "launchd", name: LAUNCHD_LABEL, path: launchdPlistPath(system) }
        : { kind: "systemd", name: SYSTEMD_UNIT, path: systemdUnitPath(system) };
    const content =
      serviceKind === "launchd" ? launchdPlist(system, command) : systemdUnit(system, command);
    await mkdir(stateDir(env), { recursive: true, mode: 0o700 });
    await recordWrite(manifest, record.path, "service", content);
    manifest.service = record;
    await save();
    try {
      await startService(system, record);
      const health = await waitForHealth(system, endpoint.url, 10_000);
      if (health) {
        say(
          `✓ Started the ${serviceKind} service; switchkick ${health.version} answers at ${endpoint.url}.`,
        );
      } else {
        failed = true;
        say(
          `✗ Started the ${serviceKind} service, but nothing answers at ${endpoint.url}. ` +
            `See ${serviceLogHint(system, record)}.`,
        );
      }
    } catch (error) {
      failed = true;
      say(`✗ Couldn't start the service: ${(error as Error).message}`);
    }
    if (serviceKind === "systemd" && (await lingering(system)) === false) {
      say(
        "  note: systemd stops user services at logout. To keep switchkick running, run " +
          "`loginctl enable-linger`.",
      );
    }
  }

  for (const client of clients) {
    const path = clientSettingsPath(client, system);
    if (path === null) {
      say(
        `✓ ${CLIENT_NAMES[client]}: set these in the app's environment (or \`eval "$(switchkick env ${client})"\`):`,
      );
      for (const line of clientEnv(client, endpoint).trimEnd().split("\n")) say(`    ${line}`);
      continue;
    }
    try {
      const current = (await readBytes(path))?.toString("utf8") ?? null;
      const wired =
        client === "codex"
          ? wireCodex(current, endpoint, path)
          : wireClaude(current, endpoint, path);
      if (current !== wired) {
        await recordWrite(manifest, path, `client:${client as "codex" | "claude"}`, wired);
        await save();
      }
      say(`✓ ${CLIENT_NAMES[client]}: pointed at ${endpoint.url} in ${path}.`);
    } catch (error) {
      if (!(error instanceof ClientConfigError)) throw error;
      failed = true;
      say(`✗ ${CLIENT_NAMES[client]}: ${error.message}`);
    }
  }
  manifest.clients = [...new Set([...(manifest.clients ?? []), ...clients])];
  await save();

  say();
  say(
    failed
      ? "Setup finished with problems (above). `switchkick doctor` checks everything again."
      : "Done. Run `switchkick doctor --live` to check it end to end (it makes one small paid call).",
  );
  if (!serviceKind) say("Start switchkick with `switchkick serve`.");
  return failed ? 1 : 0;
}
