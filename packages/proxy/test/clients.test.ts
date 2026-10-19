import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  ClientConfigError,
  claudeWiring,
  clientEnv,
  codexWiring,
  endpointUrl,
  wireClaude,
  wireCodex,
} from "../src/clients.js";
import { launchdPlist, systemdUnit } from "../src/service.js";
import type { System } from "../src/system.js";
import { fakeMachine } from "./system.js";

const ENDPOINT = { url: "http://127.0.0.1:8787", token: null };
const plain = (text: string) => JSON.parse(JSON.stringify(parseToml(text)));

describe("wireCodex", () => {
  it("writes a new config", () => {
    const text = wireCodex(null, ENDPOINT, "c");
    expect(plain(text)).toEqual({
      model_provider: "switchkick",
      model_providers: {
        switchkick: {
          name: "switchkick",
          base_url: "http://127.0.0.1:8787/v1",
          wire_api: "responses",
        },
      },
    });
  });

  it("keeps model_provider top-level, before the first table, and keeps comments", () => {
    const original = [
      "# my settings",
      'model = "gpt-6"',
      "",
      "[profiles.fast] # a profile",
      'model = "x"',
      "",
      "[[mcp_servers.list]]",
      'name = "a"',
      "",
    ].join("\n");
    const text = wireCodex(original, ENDPOINT, "c");
    expect(
      text.startsWith(
        '# my settings\nmodel = "gpt-6"\nmodel_provider = "switchkick"\n\n[profiles.fast]',
      ),
    ).toBe(true);
    const parsed = plain(text);
    expect(parsed.profiles).toEqual({ fast: { model: "x" } });
    expect(parsed.model_provider).toBe("switchkick");
  });

  it("replaces an existing provider choice and an earlier switchkick table", () => {
    const once = wireCodex(
      'model_provider = "openai"\n',
      { url: "http://127.0.0.1:1", token: null },
      "c",
    );
    const twice = wireCodex(once, ENDPOINT, "c");
    expect(twice.match(/model_provider =/g)).toHaveLength(1);
    expect(twice.match(/\[model_providers\.switchkick\]/g)).toHaveLength(1);
    expect(twice.match(/Added by `switchkick setup`/g)).toHaveLength(1);
    expect(plain(twice).model_providers.switchkick.base_url).toBe("http://127.0.0.1:8787/v1");
    expect(wireCodex(twice, ENDPOINT, "c")).toBe(twice);
  });

  it("keeps other providers and CRLF line endings", () => {
    const original = '[model_providers.other]\r\nname = "o"\r\nbase_url = "http://o"\r\n';
    const text = wireCodex(original, ENDPOINT, "c");
    expect(text).not.toMatch(/[^\r]\n/);
    expect(plain(text).model_providers.other).toEqual({ name: "o", base_url: "http://o" });
  });

  it("names SWITCHKICK_TOKEN as the key variable when a token is required", () => {
    const text = wireCodex(null, { ...ENDPOINT, token: "secret" }, "c");
    expect(plain(text).model_providers.switchkick.env_key).toBe("SWITCHKICK_TOKEN");
    expect(text).not.toContain('secret"');
  });

  it("handles long runs of spaces in linear time", () => {
    const spaces = " ".repeat(100_000);
    const started = performance.now();
    expect(() => wireCodex(`[${spaces}`, ENDPOINT, "c")).toThrow(ClientConfigError);
    expect(() => wireCodex(`[[${spaces}x${spaces}`, ENDPOINT, "c")).toThrow(ClientConfigError);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("recognizes the switchkick table however its header is spaced or quoted", () => {
    const original = '[ model_providers . "switchkick" ] # old\nname = "old"\n';
    const text = wireCodex(original, ENDPOINT, "c");
    expect(text).not.toContain('"old"');
    expect(text.match(/model_providers/g)).toHaveLength(1);
  });

  it("refuses invalid TOML", () => {
    expect(() => wireCodex("model = [", ENDPOINT, "c")).toThrow(ClientConfigError);
  });

  it("refuses an edit it can't verify, with instructions", () => {
    // An array element that looks like a table header: inserting before it would break the array.
    const original = 'notify = [\n["a"]\n]\n';
    expect(() => wireCodex(original, ENDPOINT, "c")).toThrow(/Add this to it yourself/);
  });

  it("is reported as wired, or why not", () => {
    expect(codexWiring(wireCodex(null, ENDPOINT, "c"), ENDPOINT)).toEqual({ wired: true });
    expect(codexWiring('model_provider = "openai"', ENDPOINT)).toEqual({
      wired: false,
      reason: 'model_provider is "openai"',
    });
    expect(codexWiring(null, ENDPOINT).wired).toBe(false);
  });
});

describe("wireClaude", () => {
  it("adds the env entries and keeps everything else", () => {
    const text = wireClaude('{"model":"opus","env":{"A":"1"}}', ENDPOINT, "s");
    expect(JSON.parse(text)).toEqual({
      model: "opus",
      env: {
        A: "1",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
        ANTHROPIC_AUTH_TOKEN: "switchkick",
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
      },
    });
  });

  it("keeps an output cap the user already chose", () => {
    const text = wireClaude('{"env":{"CLAUDE_CODE_MAX_OUTPUT_TOKENS":"8000"}}', ENDPOINT, "s");
    expect(JSON.parse(text).env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("8000");
  });

  it("refuses files that aren't a JSON object", () => {
    expect(() => wireClaude("[]", ENDPOINT, "s")).toThrow(ClientConfigError);
    expect(() => wireClaude('{"env": 3}', ENDPOINT, "s")).toThrow(ClientConfigError);
    expect(() => wireClaude("// comment\n{}", ENDPOINT, "s")).toThrow(ClientConfigError);
  });

  it("is reported as wired, or why not", () => {
    expect(claudeWiring(wireClaude(null, ENDPOINT, "s"), ENDPOINT)).toEqual({ wired: true });
    expect(claudeWiring("{}", ENDPOINT)).toEqual({
      wired: false,
      reason: "env.ANTHROPIC_BASE_URL isn't http://127.0.0.1:8787",
    });
  });
});

describe("clientEnv", () => {
  it("prints exports for OpenAI apps and Claude Code", () => {
    expect(clientEnv("openai", ENDPOINT)).toBe(
      "export OPENAI_BASE_URL='http://127.0.0.1:8787/v1'\nexport OPENAI_API_KEY='switchkick'\n",
    );
    expect(clientEnv("claude", { ...ENDPOINT, token: "it's" })).toContain(
      `export ANTHROPIC_AUTH_TOKEN='it'"'"'s'`,
    );
  });

  it("prints a Codex alias that passes the provider on the command line", () => {
    expect(clientEnv("codex", ENDPOINT)).toContain(
      `alias codex='codex -c model_provider=switchkick -c '"'"'model_providers.switchkick={name="switchkick",base_url="http://127.0.0.1:8787/v1",wire_api="responses"}'"'"''`,
    );
  });

  it("reaches a wildcard listener on loopback", () => {
    expect(endpointUrl("0.0.0.0", 1)).toBe("http://127.0.0.1:1");
    expect(endpointUrl("::1", 2)).toBe("http://[::1]:2");
  });
});

describe("service files", () => {
  const system = (overrides: Partial<System>) =>
    ({
      env: { XDG_STATE_HOME: "/s & t" },
      home: "/h",
      execPath: "/Applications/My Node/bin/node",
      ...overrides,
    }) as System;

  it("escapes paths in the launchd plist", () => {
    const plist = launchdPlist(system({}), { argv: ["/a b/node", "/x<y>&z/cli.js", "serve"] });
    expect(plist).toContain("<string>/x&lt;y&gt;&amp;z/cli.js</string>");
    expect(plist).toContain("<string>/s &amp; t/switchkick/service.log</string>");
    expect(plist).toContain("/Applications/My Node/bin:/usr/local/bin");
  });

  it("quotes ExecStart and Environment for systemd", () => {
    const unit = systemdUnit(system({ env: { XDG_CONFIG_HOME: '/c "1"' } }), {
      argv: ["/a b/node", "/50%/$x\\y.js", "serve"],
    });
    expect(unit).toContain('ExecStart="/a b/node" "/50%%/$$x\\\\y.js" "serve"');
    expect(unit).toContain('Environment="XDG_CONFIG_HOME=/c \\"1\\""');
  });
});

describe("switchkick env", () => {
  it("prints the client's environment for the configured address", async () => {
    const machine = await fakeMachine();
    try {
      expect(await machine.run(["env", "openai"])).toBe(0);
      expect(machine.stdout).toContain("OPENAI_BASE_URL='http://127.0.0.1:8787/v1'");
      expect(await machine.run(["env", "cursor"])).toBe(1);
      expect(machine.stderr).toContain("unknown client: cursor");
    } finally {
      await machine.cleanup();
    }
  });
});
