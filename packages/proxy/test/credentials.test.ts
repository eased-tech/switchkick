import { describe, expect, it, vi } from "vitest";
import { type CredentialDeps, CredentialError, findApiKey, parseEnvFile } from "../src/index.js";

const ENV_FILE = "/cfg/switchkick/env";

/** Fake system: no real Keychain, Secret Service or files are touched. */
function deps(overrides: Partial<CredentialDeps> = {}): CredentialDeps {
  return {
    env: { XDG_CONFIG_HOME: "/cfg" },
    platform: "darwin",
    run: vi.fn(async () => ({ code: 44, stdout: "", timedOut: false })),
    readFile: vi.fn(async () => {
      throw new Error("readFile should not be called");
    }),
    fileMode: vi.fn(async () => null),
    ...overrides,
  };
}

describe("findApiKey", () => {
  it("uses OPENROUTER_API_KEY first, without touching the credential store", async () => {
    const d = deps({ env: { OPENROUTER_API_KEY: " sk-env \n" } });
    expect(await findApiKey(d)).toEqual({ key: "sk-env", source: "OPENROUTER_API_KEY" });
    expect(d.run).not.toHaveBeenCalled();
  });

  it("reads the macOS Keychain entry for service switchkick, account openrouter", async () => {
    const d = deps({
      run: vi.fn(async () => ({ code: 0, stdout: "sk-keychain\n", timedOut: false })),
    });
    expect(await findApiKey(d)).toEqual({ key: "sk-keychain", source: "macOS Keychain" });
    expect(d.run).toHaveBeenCalledWith("security", [
      "find-generic-password",
      "-s",
      "switchkick",
      "-a",
      "openrouter",
      "-w",
    ]);
  });

  it("reads libsecret on Linux", async () => {
    const d = deps({
      platform: "linux",
      run: vi.fn(async () => ({ code: 0, stdout: "sk-secret", timedOut: false })),
    });
    expect((await findApiKey(d)).source).toBe("Secret Service (libsecret)");
    expect(d.run).toHaveBeenCalledWith("secret-tool", [
      "lookup",
      "service",
      "switchkick",
      "account",
      "openrouter",
    ]);
  });

  it("falls back to an env file readable only by the user", async () => {
    const d = deps({
      fileMode: vi.fn(async () => 0o600),
      readFile: vi.fn(async () => "# switchkick\nexport OPENROUTER_API_KEY='sk-file'\n"),
    });
    expect(await findApiKey(d)).toEqual({ key: "sk-file", source: ENV_FILE });
  });

  it("refuses an env file other users can read", async () => {
    const d = deps({ fileMode: vi.fn(async () => 0o644) });
    await expect(findApiKey(d)).rejects.toThrow(/Refusing to read .*chmod 600/);
    expect(d.readFile).not.toHaveBeenCalled();
  });

  it("lists every source it tried when there is no key", async () => {
    const error = await findApiKey(deps()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialError);
    expect((error as Error).message).toMatch(
      /OPENROUTER_API_KEY environment variable[\s\S]*macOS Keychain.*no entry[\s\S]*not found/,
    );
  });

  it("reports a missing command, a timeout, and other failures by exit code only", async () => {
    const message = async (result: Awaited<ReturnType<CredentialDeps["run"]>>) =>
      String(await findApiKey(deps({ run: vi.fn(async () => result) })).catch((e) => e));
    expect(await message(null)).toContain("`security` is not installed");
    expect(await message({ code: -1, stdout: "", timedOut: true })).toContain("timed out");
    expect(await message({ code: 51, stdout: "sk-leaked", timedOut: false })).toContain(
      "exited with code 51",
    );
    expect(await message({ code: 51, stdout: "sk-leaked", timedOut: false })).not.toContain(
      "sk-leaked",
    );
  });

  it("skips the credential store on platforms without one", async () => {
    const d = deps({ platform: "win32" });
    await expect(findApiKey(d)).rejects.toThrow(CredentialError);
    expect(d.run).not.toHaveBeenCalled();
  });
});

describe("parseEnvFile", () => {
  it("stays fast on long runs of spaces and comment markers", () => {
    const started = performance.now();
    parseEnvFile(`OPENROUTER_API_KEY=${" ".repeat(50_000)}x`);
    parseEnvFile(`OPENROUTER_API_KEY=x${" #".repeat(50_000)}`);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it.each([
    ["OPENROUTER_API_KEY=sk-1", "sk-1"],
    ["export OPENROUTER_API_KEY=sk-2", "sk-2"],
    ['OPENROUTER_API_KEY="sk-3"', "sk-3"],
    ["OPENROUTER_API_KEY = sk-4  # comment", "sk-4"],
    ["\r\n# OPENROUTER_API_KEY=commented\r\nOTHER=1\r\nOPENROUTER_API_KEY=sk-5\r\n", "sk-5"],
    ["export\tOPENROUTER_API_KEY=sk-6", "sk-6"],
    ["OPENROUTER_API_KEY_OLD=sk-wrong\nOPENROUTER_API_KEY=sk-7", "sk-7"],
    ['OPENROUTER_API_KEY="sk # not a comment"', "sk # not a comment"],
    ["OPENROUTER_API_KEY=", null],
    ["", null],
  ])("parses %j", (text, expected) => {
    expect(parseEnvFile(text)).toBe(expected);
  });
});
