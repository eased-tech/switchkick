import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";
import { exit, type FakeMachine, fakeMachine, json, ok } from "./system.js";

const KEY = "sk-or-v1-0123456789abcdef";

let machine: FakeMachine;

afterEach(async () => {
  await machine?.cleanup();
});

/** A Mac whose Keychain and launchd are simulated, with switchkick answering once started. */
async function mac(
  options: { stored?: string; env?: NodeJS.ProcessEnv; scriptPath?: string } = {},
) {
  let keychain: string | null = options.stored ?? null;
  let started = false;
  machine = await fakeMachine({
    platform: "darwin",
    ...(options.env ? { env: options.env } : {}),
    ...(options.scriptPath ? { scriptPath: options.scriptPath } : {}),
    exec: ({ command, args, input }) => {
      if (command === "security" && args[0] === "-i") {
        keychain = /-w "([^"]+)"/.exec(input ?? "")?.[1] ?? null;
        return ok();
      }
      if (command === "security" && args[0] === "find-generic-password") {
        return keychain ? ok(`${keychain}\n`) : exit(44);
      }
      if (command === "security" && args[0] === "delete-generic-password") {
        const had = keychain !== null;
        keychain = null;
        return had ? ok() : exit(44);
      }
      if (command === "launchctl" && args[0] === "bootstrap") started = true;
      if (command === "launchctl" && args[0] === "bootout") started = false;
      if (command === "launchctl" && args[0] === "print") {
        return started ? ok("\tstate = running\n") : exit(113);
      }
      return ok();
    },
    fetch: (url) =>
      started && url.endsWith("/healthz") ? json({ ok: true, version: VERSION }) : undefined,
  });
  return { keychain: () => keychain };
}

const read = (path: string) => readFile(path, "utf8");
const codexPath = () => join(machine.home, ".codex", "config.toml");
const claudePath = () => join(machine.home, ".claude", "settings.json");
const configPath = () => join(machine.home, ".config", "switchkick", "config.yaml");
const plistPath = () =>
  join(machine.home, "Library", "LaunchAgents", "io.github.eased-tech.switchkick.plist");

describe("switchkick setup", () => {
  it("stores the key, writes the config, starts launchd and wires both clients", async () => {
    const { keychain } = await mac();
    await mkdir(join(machine.home, ".codex"));
    await mkdir(join(machine.home, ".claude"));

    const code = await machine.run(["setup", "--yes"], { OPENROUTER_API_KEY: KEY });
    expect(machine.stderr).not.toContain(KEY);
    expect(code).toBe(0);

    // The key went to the Keychain through stdin, never a command line.
    expect(keychain()).toBe(KEY);
    for (const call of machine.calls) expect(call.args.join(" ")).not.toContain(KEY);

    // Claude Code is a client, so the config uses the Claude-only preset in local mode.
    const config = await read(configPath());
    expect(config).toContain("preset: claude-only");
    expect(config).toContain("mode: local");

    const plist = await read(plistPath());
    expect(plist).toContain("<string>/opt/node/bin/node</string>");
    expect(plist).toContain("<string>/opt/switchkick/dist/cli.js</string>");
    expect(plist).toContain(`<string>${machine.env.XDG_CONFIG_HOME}</string>`);
    expect(machine.calls).toContainEqual(
      expect.objectContaining({
        command: "launchctl",
        args: ["bootstrap", "gui/501", plistPath()],
      }),
    );

    expect(await read(codexPath())).toContain('base_url = "http://127.0.0.1:8787/v1"');
    const claude = JSON.parse(await read(claudePath()));
    expect(claude.env).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
      ANTHROPIC_AUTH_TOKEN: "switchkick",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
    });
    expect(machine.stderr).toContain(`switchkick ${VERSION} answers at http://127.0.0.1:8787`);
  });

  it("uses the multi-provider preset when Claude Code isn't a client", async () => {
    await mac();
    expect(
      await machine.run(["setup", "--yes", "--client", "codex"], { OPENROUTER_API_KEY: KEY }),
    ).toBe(0);
    expect(await read(configPath())).toContain("preset: multi-provider");
  });

  it("falls back to printing the environment for OpenAI apps when no client is installed", async () => {
    await mac();
    expect(await machine.run(["setup", "--yes"], { OPENROUTER_API_KEY: KEY })).toBe(0);
    expect(machine.stderr).toContain("export OPENAI_BASE_URL='http://127.0.0.1:8787/v1'");
  });

  it("keeps a stored key and an existing config", async () => {
    const { keychain } = await mac({ stored: "sk-or-v1-alreadystored" });
    await mkdir(join(machine.home, ".config", "switchkick"), { recursive: true });
    await writeFile(configPath(), "mode: static\n");
    expect(await machine.run(["setup", "--yes", "--client", "openai"])).toBe(0);
    expect(keychain()).toBe("sk-or-v1-alreadystored");
    expect(await read(configPath())).toBe("mode: static\n");
    expect(machine.calls.some((c) => c.args[0] === "-i")).toBe(false);
  });

  it("refuses --yes without a key, before changing anything", async () => {
    await mac();
    expect(await machine.run(["setup", "--yes", "--client", "codex"])).toBe(1);
    expect(machine.stderr).toContain("no OpenRouter key is stored yet");
    await expect(stat(codexPath())).rejects.toThrow();
    await expect(stat(configPath())).rejects.toThrow();
  });

  it("asks for the key without echoing it, then for confirmation", async () => {
    const { keychain } = await mac();
    machine.answers.push(KEY, "");
    expect(await machine.run(["setup", "--client", "openai", "--service", "none"])).toBe(0);
    expect(machine.prompts).toEqual(["OpenRouter API key (input hidden): ", "Continue? [Y/n] "]);
    expect(keychain()).toBe(KEY);
  });

  it("changes nothing when the confirmation is declined", async () => {
    await mac();
    machine.answers.push("n");
    expect(await machine.run(["setup", "--client", "codex"], { OPENROUTER_API_KEY: KEY })).toBe(1);
    await expect(stat(codexPath())).rejects.toThrow();
  });

  it("rejects something that isn't a key", async () => {
    await mac();
    expect(await machine.run(["setup", "--yes"], { OPENROUTER_API_KEY: "not a key" })).toBe(1);
    expect(machine.stderr).toContain("that isn't an OpenRouter key");
  });

  it("warns when Claude Code would get non-Anthropic models", async () => {
    await mac();
    const code = await machine.run(
      ["setup", "--yes", "--client", "claude", "--preset", "multi-provider"],
      { OPENROUTER_API_KEY: KEY },
    );
    expect(code).toBe(0);
    expect(machine.stderr).toContain(
      "warning: Claude Code will be routed to models that aren't Anthropic's",
    );
  });

  it("runs this exact version through npx when started from npx's cache", async () => {
    await mac({ scriptPath: "/Users/x/.npm/_npx/abc/node_modules/switchkick/dist/cli.js" });
    const bin = join(machine.dir, "nodebin");
    await mkdir(bin);
    await writeFile(join(bin, "npx"), "#!/bin/sh\n", { mode: 0o755 });
    machine.system.execPath = join(bin, "node");
    expect(
      await machine.run(["setup", "--yes", "--client", "openai"], { OPENROUTER_API_KEY: KEY }),
    ).toBe(0);
    const plist = await read(plistPath());
    expect(plist).toContain(`<string>${join(bin, "npx")}</string>`);
    expect(plist).toContain(`<string>switchkick@${VERSION}</string>`);
  });

  it("reports a service that doesn't come up", async () => {
    await mac();
    machine.system.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const code = await machine.run(["setup", "--yes", "--client", "openai"], {
      OPENROUTER_API_KEY: KEY,
    });
    expect(code).toBe(1);
    expect(machine.stderr).toContain("nothing answers at http://127.0.0.1:8787");
  }, 15_000);
});

describe("switchkick setup on Linux", () => {
  it("falls back to a 0600 env file and no service when there's no keyring or user bus", async () => {
    machine = await fakeMachine({
      platform: "linux",
      exec: ({ command }) => {
        if (command === "secret-tool") return null;
        if (command === "systemctl") return exit(1, "Failed to connect to bus");
        return ok();
      },
    });
    const code = await machine.run(["setup", "--yes", "--client", "openai"], {
      OPENROUTER_API_KEY: KEY,
    });
    expect(code).toBe(0);
    const envFile = join(machine.home, ".config", "switchkick", "env");
    expect(await read(envFile)).toBe(`OPENROUTER_API_KEY=${KEY}\n`);
    expect((await stat(envFile)).mode & 0o777).toBe(0o600);
    expect(machine.stderr).toContain("Service: none (systemd's user manager isn't reachable");
  });

  it("installs and starts a systemd user unit", async () => {
    machine = await fakeMachine({
      platform: "linux",
      exec: ({ command, args }) => {
        if (command === "loginctl") return ok("Linger=no\n");
        if (command === "systemctl" && args.includes("is-active")) return ok("active\n");
        return ok();
      },
      fetch: (url) => (url.endsWith("/healthz") ? json({ ok: true, version: VERSION }) : undefined),
    });
    const code = await machine.run(["setup", "--yes", "--client", "openai"], {
      OPENROUTER_API_KEY: KEY,
    });
    expect(code).toBe(0);
    const unit = await read(join(machine.home, ".config", "systemd", "user", "switchkick.service"));
    expect(unit).toContain('ExecStart="/opt/node/bin/node" "/opt/switchkick/dist/cli.js" "serve"');
    const systemctl = machine.calls
      .filter((c) => c.command === "systemctl")
      .map((c) => c.args.join(" "));
    expect(systemctl).toEqual([
      "--user show-environment",
      "--user daemon-reload",
      "--user enable switchkick.service",
      "--user restart switchkick.service",
    ]);
    expect(machine.stderr).toContain("loginctl enable-linger");
  });
});

describe("switchkick uninstall", () => {
  const CODEX = '# my codex config\r\nmodel = "gpt-6"\r\n\r\n[profiles.fast]\r\nmodel = "x"';
  const CLAUDE = '{"permissions":{"allow":["Bash(ls)"]},   "env": {"FOO": "1"}}';

  it("restores every client file byte for byte, after setup ran twice", async () => {
    await mac();
    await mkdir(join(machine.home, ".codex"));
    await writeFile(codexPath(), CODEX, { mode: 0o640 });
    // Claude Code's settings don't exist yet; neither does their directory.

    const setup = ["setup", "--yes", "--client", "codex,claude"];
    expect(await machine.run(setup, { OPENROUTER_API_KEY: KEY })).toBe(0);
    expect(await machine.run(setup, { OPENROUTER_API_KEY: KEY })).toBe(0);
    expect(await read(codexPath())).toContain("[model_providers.switchkick]");
    expect((await read(codexPath())).match(/model_providers\.switchkick/g)).toHaveLength(1);

    expect(await machine.run(["uninstall"])).toBe(0);
    expect(await read(codexPath())).toBe(CODEX);
    expect((await stat(codexPath())).mode & 0o777).toBe(0o640);
    await expect(stat(claudePath())).rejects.toThrow();
    await expect(stat(plistPath())).rejects.toThrow();
    // The config and key stay.
    expect(await read(configPath())).toContain("preset: claude-only");
    expect(machine.calls).toContainEqual(
      expect.objectContaining({
        command: "launchctl",
        args: ["bootout", "gui/501/io.github.eased-tech.switchkick"],
      }),
    );
  });

  it("restores an awkwardly formatted Claude Code file exactly", async () => {
    await mac();
    await mkdir(join(machine.home, ".claude"));
    await writeFile(claudePath(), CLAUDE);
    expect(
      await machine.run(["setup", "--yes", "--client", "claude"], { OPENROUTER_API_KEY: KEY }),
    ).toBe(0);
    const wired = JSON.parse(await read(claudePath()));
    expect(wired.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(wired.env.FOO).toBe("1");
    expect(await machine.run(["uninstall"])).toBe(0);
    expect(await read(claudePath())).toBe(CLAUDE);
  });

  it("keeps a version edited after setup next to the restored file", async () => {
    await mac();
    await mkdir(join(machine.home, ".claude"));
    await writeFile(claudePath(), CLAUDE);
    await machine.run(["setup", "--yes", "--client", "claude"], { OPENROUTER_API_KEY: KEY });
    await writeFile(claudePath(), '{"edited": true}\n');
    expect(await machine.run(["uninstall"])).toBe(0);
    expect(await read(claudePath())).toBe(CLAUDE);
    expect(await read(`${claudePath()}.switchkick-uninstall`)).toBe('{"edited": true}\n');
    expect(machine.stderr).toContain("It had changed since setup");
  });

  it("refuses to edit invalid client settings, and leaves them alone", async () => {
    await mac();
    await mkdir(join(machine.home, ".claude"));
    await writeFile(claudePath(), "{ not json");
    const code = await machine.run(["setup", "--yes", "--client", "claude"], {
      OPENROUTER_API_KEY: KEY,
    });
    expect(code).toBe(1);
    expect(machine.stderr).toContain("isn't valid JSON, so switchkick won't edit it");
    expect(await read(claudePath())).toBe("{ not json");
  });

  it("purges the config, state and stored key", async () => {
    const { keychain } = await mac();
    await machine.run(["setup", "--yes", "--client", "openai"], { OPENROUTER_API_KEY: KEY });
    expect(await machine.run(["uninstall", "--purge", "--yes"])).toBe(0);
    expect(keychain()).toBeNull();
    await expect(stat(join(machine.home, ".config", "switchkick"))).rejects.toThrow();
    await expect(stat(join(machine.home, ".local", "state", "switchkick"))).rejects.toThrow();
  });

  it("refuses to run setup again over an unreadable setup record", async () => {
    await mac();
    await mkdir(join(machine.home, ".codex"));
    await writeFile(codexPath(), 'model = "gpt-6"\n');
    const setup = ["setup", "--yes", "--client", "codex"];
    expect(await machine.run(setup, { OPENROUTER_API_KEY: KEY })).toBe(0);
    const wired = await read(codexPath());
    await writeFile(join(machine.home, ".local", "state", "switchkick", "setup.json"), "{broken");
    expect(await machine.run(setup, { OPENROUTER_API_KEY: KEY })).toBe(1);
    expect(machine.stderr).toContain("can't read the setup record");
    expect(await read(codexPath())).toBe(wired);
  });

  it("says so when setup never ran", async () => {
    await mac();
    expect(await machine.run(["uninstall"])).toBe(0);
    expect(machine.stderr).toContain("nothing to undo");
  });
});
