import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_TIER_MODELS,
  loadConfig,
  parseConfig,
  resolveTiers,
} from "../src/index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "switchkick-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseConfig", () => {
  it("fills in defaults for an empty file", () => {
    expect(parseConfig(null, "test")).toEqual({
      mode: "static",
      defaultTier: "balanced",
      tiers: {},
      attribution: true,
      server: { host: "127.0.0.1", port: 8787, maxBodyBytes: 20 * 1024 ** 2 },
      upstream: { baseUrl: "https://openrouter.ai/api/v1" },
      log: { enabled: true, maxBytes: 50 * 1024 ** 2 },
    });
  });

  it.each([
    ["512kb", 512 * 1024],
    ["20MB", 20 * 1024 ** 2],
    ["1 gb", 1024 ** 3],
    ["100b", 100],
    [4096, 4096],
  ])("reads the size %s as %d bytes", (size, bytes) => {
    expect(parseConfig({ server: { maxBodyBytes: size } }, "test").server.maxBodyBytes).toBe(bytes);
  });

  it("names every invalid field by path", () => {
    const raw = {
      mode: "local",
      tiers: { fast: { model: "x", efort: "high" } },
      server: { port: 70000, maxBodyBytes: "lots" },
      extra: 1,
    };
    expect(() => parseConfig(raw, "my.yaml")).toThrow(ConfigError);
    try {
      parseConfig(raw, "my.yaml");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Invalid config in my.yaml:");
      for (const path of [
        "mode:",
        "tiers.fast.efort: unrecognized key",
        "server.port:",
        "server.maxBodyBytes:",
        "extra: unrecognized key",
      ]) {
        expect(message).toContain(path);
      }
    }
  });

  it("rejects effort levels that Anthropic Messages doesn't accept", () => {
    expect(() => parseConfig({ tiers: { fast: { model: "x", effort: "minimal" } } }, "t")).toThrow(
      /tiers\.fast\.effort/,
    );
  });
});

describe("resolveTiers", () => {
  it("replaces a configured tier entirely and keeps the other built-ins", () => {
    const config = parseConfig(
      { tiers: { frontier: { model: "openai/gpt-5.5", effort: "xhigh" } } },
      "t",
    );
    expect(resolveTiers(config)).toEqual({
      fast: { model: DEFAULT_TIER_MODELS.fast },
      balanced: { model: DEFAULT_TIER_MODELS.balanced },
      frontier: { model: "openai/gpt-5.5", effort: "xhigh" },
    });
  });
});

describe("loadConfig", () => {
  it("reads config.yaml from XDG_CONFIG_HOME", async () => {
    const path = join(dir, "switchkick", "config.yaml");
    await mkdir(join(dir, "switchkick"));
    await writeFile(path, "defaultTier: fast\n");
    const loaded = await loadConfig(undefined, { XDG_CONFIG_HOME: dir });
    expect(loaded.path).toBe(path);
    expect(loaded.config.defaultTier).toBe("fast");
  });

  it("falls back to built-in defaults when the default file doesn't exist", async () => {
    const loaded = await loadConfig(undefined, { XDG_CONFIG_HOME: dir });
    expect(loaded.path).toBeNull();
    expect(loaded.config.defaultTier).toBe("balanced");
  });

  it("fails when an explicitly named file doesn't exist", async () => {
    await expect(loadConfig(join(dir, "nope.yaml"), {})).rejects.toThrow(/Can't read config/);
    await expect(
      loadConfig(undefined, { SWITCHKICK_CONFIG: join(dir, "nope.yaml") }),
    ).rejects.toThrow(/Can't read config/);
  });

  it("prefers the flag over SWITCHKICK_CONFIG", async () => {
    const a = join(dir, "a.yaml");
    const b = join(dir, "b.yaml");
    await writeFile(a, "defaultTier: fast\n");
    await writeFile(b, "defaultTier: frontier\n");
    const loaded = await loadConfig(a, { SWITCHKICK_CONFIG: b });
    expect(loaded.config.defaultTier).toBe("fast");
  });

  it("reports YAML syntax errors with the file name", async () => {
    const path = join(dir, "bad.yaml");
    await writeFile(path, "tiers: [unclosed\n");
    await expect(loadConfig(path, {})).rejects.toThrow(`Invalid YAML in ${path}`);
  });

  it("treats an empty file as all defaults", async () => {
    const path = join(dir, "empty.yaml");
    await writeFile(path, "# nothing yet\n");
    expect((await loadConfig(path, {})).config.mode).toBe("static");
  });
});
