import { rm } from "node:fs/promises";
import { join } from "node:path";
import { CLIENT_NAMES, type Client } from "./clients.js";
import { CommandError, type CommandIo, parseCommand } from "./command.js";
import { configDir } from "./config.js";
import { deleteApiKey } from "./credentials.js";
import { stateDir } from "./log.js";
import { manifestPath, readManifest, restoreFile } from "./manifest.js";
import { reloadServices, stopService } from "./service.js";

export const UNINSTALL_HELP = `Usage: switchkick uninstall [--purge] [--yes]

Stops and removes the background service, and puts back every client settings file setup
changed, byte for byte. A file edited since setup is restored too, and the edited version is kept
next to it as <file>.switchkick-uninstall.

The config file, the decision log, saved sessions and the stored key are kept, unless:
  --purge     Also delete the config directory (${configDir()}), the state directory
              (${stateDir()}) and the stored OpenRouter key.
  -y, --yes   Don't ask before purging.
`;

/** `switchkick uninstall`. */
export async function uninstallCommand(argv: string[], io: CommandIo): Promise<number> {
  const { values, positionals } = parseCommand(
    argv,
    { purge: { type: "boolean" }, yes: { type: "boolean", short: "y" } },
    UNINSTALL_HELP,
  );
  if (values.help) {
    io.stdout(UNINSTALL_HELP);
    return 0;
  }
  if (positionals.length > 0) {
    throw new CommandError(`unexpected argument: ${positionals[0]}\n\n${UNINSTALL_HELP}`);
  }
  const { system, env } = io;
  const say = (text = "") => io.stderr(`${text}\n`);

  if (values.purge && !values.yes) {
    const answer = await system.prompt(
      "Delete switchkick's config, logs, sessions and stored key too? [y/N] ",
    );
    if (answer === null) throw new CommandError("there's no terminal to confirm on. Pass --yes.");
    if (!/^y(es)?$/i.test(answer.trim())) {
      say("Nothing was changed.");
      return 1;
    }
  }

  let manifest: Awaited<ReturnType<typeof readManifest>>;
  try {
    manifest = await readManifest(env);
  } catch (error) {
    throw new CommandError(`can't read ${manifestPath(env)}: ${(error as Error).message}`);
  }
  if (!manifest) {
    say("switchkick setup hasn't run here (no setup record), so there's nothing to undo.");
  }

  let failed = false;
  if (manifest?.service) {
    await stopService(system, manifest.service);
    say(`✓ Stopped the ${manifest.service.kind} service.`);
  }
  for (const change of manifest?.files ?? []) {
    // The config is switchkick's own file: kept unless purging, when the whole directory goes.
    if (change.kind === "config") continue;
    try {
      const outcome = await restoreFile(change);
      const what =
        change.kind === "service"
          ? "Removed the service file"
          : `${CLIENT_NAMES[change.kind.slice("client:".length) as Client]}: ${
              outcome.action === "removed" ? "removed" : "restored"
            }`;
      if (outcome.action === "unchanged") {
        say(`✓ ${change.path} is already as it was before setup.`);
      } else {
        say(`✓ ${what} ${change.path}.`);
      }
      if ("kept" in outcome) {
        say(`  It had changed since setup; that version is saved as ${outcome.kept}.`);
      }
    } catch (error) {
      failed = true;
      say(`✗ Couldn't restore ${change.path}: ${(error as Error).message}`);
    }
  }
  if (manifest?.service) await reloadServices(system, manifest.service);

  if (values.purge) {
    for (const removed of await deleteApiKey(system)) say(`✓ Deleted the key from ${removed}.`);
    for (const dir of [configDir(env), stateDir(env)]) {
      await rm(dir, { recursive: true, force: true });
      say(`✓ Deleted ${dir}.`);
    }
  } else if (manifest && !failed) {
    await rm(manifestPath(env), { force: true });
    const config =
      manifest.files.find((f) => f.kind === "config")?.path ?? join(configDir(env), "config.yaml");
    say(`Kept the config (${config}), the decision log and the stored key; --purge deletes them.`);
  }
  return failed ? 1 : 0;
}
