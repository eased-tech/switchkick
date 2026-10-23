import { access, constants } from "node:fs/promises";
import { dirname, join } from "node:path";
import { VERSION } from "./app.js";
import { stateDir } from "./log.js";
import type { ServiceRecord } from "./manifest.js";
import type { System } from "./system.js";

export const SERVICE_KINDS = ["auto", "launchd", "systemd", "none"] as const;
export type ServiceChoice = (typeof SERVICE_KINDS)[number];

/** The launchd label, after the project's home on GitHub. */
export const LAUNCHD_LABEL = "io.github.eased-tech.switchkick";
export const SYSTEMD_UNIT = "switchkick.service";

/** Environment the service is started with, so it reads the same config and state as `setup`. */
const PASSED_ENV = ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "SWITCHKICK_CONFIG"] as const;

export function launchdPlistPath(system: Pick<System, "home">): string {
  return join(system.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function systemdUnitPath(system: Pick<System, "env" | "home">): string {
  const config = system.env.XDG_CONFIG_HOME || join(system.home, ".config");
  return join(config, "systemd", "user", SYSTEMD_UNIT);
}

/** The service's log, next to the decision log. */
export function serviceLogPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "service.log");
}

export interface ServiceCommand {
  /** Program and arguments, all absolute. */
  argv: string[];
  /** Set when the command can stop working later, e.g. because it lives in npx's cache. */
  warning?: string;
}

async function exists(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

/** The script path inside a `bun build --compile` binary, which only exists in that binary. */
const COMPILED_SCRIPT = /^(?:\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/;

/**
 * The command the service runs. Normally the Node binary and this script, by absolute path. A
 * script in npx's cache can be cleaned away, so then the service runs this exact version through
 * npx instead, which fetches it again if needed. A standalone binary runs itself.
 */
export async function serviceCommand(system: System, config?: string): Promise<ServiceCommand> {
  const tail = ["serve", ...(config ? ["--config", config] : [])];
  if (COMPILED_SCRIPT.test(system.scriptPath)) return { argv: [system.execPath, ...tail] };
  if (/[\\/]_npx[\\/]/.test(system.scriptPath)) {
    const npx = join(dirname(system.execPath), system.platform === "win32" ? "npx.cmd" : "npx");
    if (await exists(npx)) {
      return { argv: [npx, "--yes", `switchkick@${VERSION}`, ...tail] };
    }
    return {
      argv: [system.execPath, system.scriptPath, ...tail],
      warning:
        `switchkick is running from npx's cache (${system.scriptPath}), which npm can clean ` +
        "out, and the service would then fail to start. Install it with `npm install -g " +
        "switchkick` and run `switchkick setup` again.",
    };
  }
  return { argv: [system.execPath, system.scriptPath, ...tail] };
}

const xml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function serviceEnv(system: System): [string, string][] {
  // launchd and systemd start services with a minimal PATH. Node's directory is added for npx,
  // whose script runs `env node`; the system directories hold `security` and `secret-tool`.
  const path = [
    dirname(system.execPath),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const env: [string, string][] = [["PATH", [...new Set(path)].join(":")]];
  for (const name of PASSED_ENV) {
    const value = system.env[name];
    if (value) env.push([name, value]);
  }
  return env;
}

/** A launchd agent that starts at login and restarts switchkick if it exits. */
export function launchdPlist(system: System, command: ServiceCommand): string {
  const log = serviceLogPath(system.env);
  const strings = (values: string[]) =>
    values.map((v) => `    <string>${xml(v)}</string>`).join("\n");
  const env = serviceEnv(system)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by \`switchkick setup\`; \`switchkick uninstall\` removes it. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings(command.argv)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** Quotes one argument for a systemd `ExecStart=` or `Environment=` line. */
function systemdQuote(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", "$$$$")
    .replaceAll("\n", "\\n");
  return `"${escaped}"`;
}

/** A systemd user unit that starts with the user's session and restarts switchkick on failure. */
export function systemdUnit(system: System, command: ServiceCommand): string {
  const env = serviceEnv(system)
    .map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`)
    .join("\n");
  return `# Written by \`switchkick setup\`; \`switchkick uninstall\` removes it.
[Unit]
Description=switchkick, routing LLM API requests through OpenRouter
Documentation=https://github.com/eased-tech/switchkick
After=network-online.target

[Service]
ExecStart=${command.argv.map(systemdQuote).join(" ")}
${env}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/** Which service manager `auto` means here, or null with the reason there's none. */
export async function detectService(
  system: System,
): Promise<{ kind: "launchd" | "systemd" } | { kind: null; reason: string }> {
  if (system.platform === "darwin") return { kind: "launchd" };
  if (system.platform !== "linux") {
    return { kind: null, reason: `no supported service manager on ${system.platform}` };
  }
  const result = await system.exec("systemctl", ["--user", "show-environment"]);
  if (result === null) return { kind: null, reason: "systemctl isn't installed" };
  if (result.code !== 0) {
    return {
      kind: null,
      reason: "systemd's user manager isn't reachable (no user session, e.g. in a container)",
    };
  }
  return { kind: "systemd" };
}

async function must(system: System, command: string, args: string[]): Promise<void> {
  const result = await system.exec(command, args);
  if (result === null) throw new Error(`\`${command}\` isn't installed`);
  if (result.code !== 0) {
    const detail = result.stderr.trim().split("\n").at(-1) ?? "";
    throw new Error(
      `\`${[command, ...args].join(" ")}\` ` +
        `failed (exit ${result.code})${detail ? `: ${detail}` : ""}`,
    );
  }
}

/** Starts (or restarts) the service whose file was just written. */
export async function startService(system: System, record: ServiceRecord): Promise<void> {
  if (record.kind === "launchd") {
    const domain = `gui/${system.uid}`;
    // Unload any earlier version first; it fails harmlessly when nothing is loaded.
    await system.exec("launchctl", ["bootout", `${domain}/${record.name}`]);
    await must(system, "launchctl", ["bootstrap", domain, record.path]);
    return;
  }
  await must(system, "systemctl", ["--user", "daemon-reload"]);
  await must(system, "systemctl", ["--user", "enable", record.name]);
  await must(system, "systemctl", ["--user", "restart", record.name]);
}

/** Stops the service and keeps it from starting again. Missing services are fine. */
export async function stopService(system: System, record: ServiceRecord): Promise<void> {
  if (record.kind === "launchd") {
    await system.exec("launchctl", ["bootout", `gui/${system.uid}/${record.name}`]);
    return;
  }
  await system.exec("systemctl", ["--user", "disable", "--now", record.name]);
}

/** After the unit file is removed, systemd needs telling. */
export async function reloadServices(system: System, record: ServiceRecord): Promise<void> {
  if (record.kind === "systemd") await system.exec("systemctl", ["--user", "daemon-reload"]);
}

export interface ServiceStatus {
  loaded: boolean;
  running: boolean;
  /** Extra detail for doctor, e.g. the last exit code. */
  detail?: string;
}

export async function serviceStatus(system: System, record: ServiceRecord): Promise<ServiceStatus> {
  if (record.kind === "launchd") {
    const result = await system.exec("launchctl", ["print", `gui/${system.uid}/${record.name}`]);
    if (result?.code !== 0) return { loaded: false, running: false };
    const running = /^\s*state = running\s*$/m.test(result.stdout);
    const exit = /^\s*last exit code = (.+)$/m.exec(result.stdout)?.[1]?.trim();
    return { loaded: true, running, ...(exit && !running ? { detail: `last exit: ${exit}` } : {}) };
  }
  const result = await system.exec("systemctl", ["--user", "is-active", record.name]);
  const state = result?.stdout.trim() ?? "";
  return {
    loaded: result !== null && state !== "" && state !== "inactive" && state !== "unknown",
    running: state === "active",
    ...(state && state !== "active" ? { detail: state } : {}),
  };
}

/**
 * Whether systemd keeps the user's services running after logout. Null when it can't tell.
 */
export async function lingering(system: System): Promise<boolean | null> {
  const user = system.env.USER || system.env.LOGNAME;
  if (!user) return null;
  const result = await system.exec("loginctl", ["show-user", user, "--property=Linger"]);
  if (result?.code !== 0) return null;
  return result.stdout.trim() === "Linger=yes";
}

/** Where to look when the service won't start. */
export function serviceLogHint(system: System, record: ServiceRecord): string {
  return record.kind === "launchd"
    ? serviceLogPath(system.env)
    : `journalctl --user -u ${record.name}`;
}
