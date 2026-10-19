import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";
import { NON_ANTHROPIC_AUTHORS } from "../src/presets.js";
import { exit, type FakeMachine, fakeMachine, json, ok } from "./system.js";

const KEY = "sk-or-v1-0123456789abcdef";
const CATALOG = [
  "anthropic/claude-haiku-5.5",
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-opus-5.5",
  "google/gemini-3.8-flash",
  "openai/gpt-6.1-sol",
];
const JEV = {
  model: "typesafe/jev-1.14-20261014",
  answers: {
    tier: { type: "choice", choice: "fast", probabilities: { fast: 0.9, balanced: 0.1 } },
    sensitive: { type: "noul", noul: 0 },
    self_routing: { type: "noul", noul: 0 },
  },
  usage: { input_tokens: 10, output_tokens: 0 },
};

let machine: FakeMachine;
let up: boolean;
let catalog: string[];
let modelStatus: number;

afterEach(async () => {
  await machine?.cleanup();
});

async function mac(clients = "claude") {
  let keychain: string | null = null;
  let loaded = false;
  up = false;
  catalog = CATALOG;
  modelStatus = 200;
  machine = await fakeMachine({
    platform: "darwin",
    exec: ({ command, args, input }) => {
      if (command === "security" && args[0] === "-i") {
        keychain = /-w "([^"]+)"/.exec(input ?? "")?.[1] ?? null;
      }
      if (command === "security" && args[0] === "find-generic-password") {
        return keychain ? ok(keychain) : exit(44);
      }
      if (command === "launchctl" && args[0] === "bootstrap") loaded = up = true;
      if (command === "launchctl" && args[0] === "print") {
        return loaded ? ok("state = running\n") : exit(113);
      }
      return ok();
    },
    fetch: (url) => {
      if (url.endsWith("/healthz")) return up ? json({ ok: true, version: VERSION }) : undefined;
      if (url.endsWith("/api/v1/models")) return json({ data: catalog.map((id) => ({ id })) });
      if (url.endsWith("/decisions")) return json(JEV);
      if (/\/v1\/(messages|chat\/completions|responses)$/.test(new URL(url).pathname)) {
        return modelStatus === 200
          ? json({ model: "anthropic/claude-opus-5.5" })
          : json({ error: { message: "Insufficient credits" } }, modelStatus);
      }
      return undefined;
    },
  });
  // The fake service runs a script that must exist for doctor's path check.
  machine.system.execPath = process.execPath;
  machine.system.scriptPath = join(import.meta.dirname, "doctor.test.ts");
  await mkdir(join(machine.home, ".claude"));
  expect(
    await machine.run(["setup", "--yes", "--client", clients], { OPENROUTER_API_KEY: KEY }),
  ).toBe(0);
  machine.stdout = "";
  machine.stderr = "";
}

describe("switchkick doctor", () => {
  it("passes after setup, with a live Jev call and a model call at Claude Code's max_tokens", async () => {
    await mac();
    const code = await machine.run(["doctor", "--live"], { OPENROUTER_API_KEY: KEY });
    expect(machine.stdout).toContain("All checks passed.");
    expect(code).toBe(0);
    expect(machine.stdout).toContain("✓ Key: found in OPENROUTER_API_KEY");
    expect(machine.stdout).toContain("✓ Models: all 3 configured models are on OpenRouter");
    expect(machine.stdout).toContain(
      "✓ Service: launchd io.github.eased-tech.switchkick is running",
    );
    expect(machine.stdout).toContain(
      `✓ Proxy: switchkick ${VERSION} answers at http://127.0.0.1:8787`,
    );
    expect(machine.stdout).toContain("✓ Claude Code: points at http://127.0.0.1:8787");
    expect(machine.stdout).toContain("✓ Jev: typesafe/jev-1.14-20261014 answered");
    expect(machine.stdout).toContain("max_tokens (32000)");

    const call = machine.fetches.find((f) => f.url.endsWith("/v1/messages"));
    expect(JSON.parse(String(call?.init?.body)).max_tokens).toBe(32000);
    const headers = call?.init?.headers as Record<string, string> | undefined;
    expect(headers?.["x-switchkick-tier"]).toBe("frontier");
    // The key never appears in doctor's output.
    expect(machine.stdout).not.toContain(KEY);
  });

  it("explains a 402 from OpenRouter", async () => {
    await mac();
    modelStatus = 402;
    expect(await machine.run(["doctor", "--live"], { OPENROUTER_API_KEY: KEY })).toBe(1);
    expect(machine.stdout).toContain(
      "✗ Model call (Claude Code): OpenRouter refused it (402): Insufficient credits",
    );
    expect(machine.stdout).toContain("lower CLAUDE_CODE_MAX_OUTPUT_TOKENS");
  });

  it("probes Codex the way Codex sends requests, with no output cap", async () => {
    await mac("codex");
    modelStatus = 402;
    expect(await machine.run(["doctor", "--live"], { OPENROUTER_API_KEY: KEY })).toBe(1);
    const call = machine.fetches.find((f) => f.url.endsWith("/v1/responses"));
    const body = JSON.parse(String(call?.init?.body));
    expect(body.max_output_tokens).toBeUndefined();
    expect(machine.stdout).toContain("✗ Model call (Codex): OpenRouter refused it (402)");
    expect(machine.stdout).toContain("Codex doesn't cap its output");
  });

  it("fails when a configured model isn't on OpenRouter, or the proxy is down", async () => {
    await mac();
    catalog = CATALOG.filter((id) => id !== "anthropic/claude-opus-5.5");
    up = false;
    expect(await machine.run(["doctor"], { OPENROUTER_API_KEY: KEY })).toBe(1);
    expect(machine.stdout).toContain(
      "✗ Models: anthropic/claude-opus-5.5 (tiers.frontier) isn't on OpenRouter's model list",
    );
    expect(machine.stdout).toContain("✗ Proxy: nothing answers at http://127.0.0.1:8787");
  });

  it("fails when no key is found", async () => {
    await mac();
    expect(await machine.run(["doctor"])).toBe(1);
    expect(machine.stdout).toContain("✗ Key: No OpenRouter API key found.");
  });

  it("warns about authors new since the claude-only preset's exclusion list", async () => {
    await mac();
    catalog = [...CATALOG, "newlab/model-1"];
    const config = join(machine.home, "hosted.yaml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(config, "preset: claude-only\nmode: hosted\n");
    await machine.run(["doctor", "--config", config], { OPENROUTER_API_KEY: KEY });
    expect(machine.stdout).toContain("doesn't exclude newlab/*");
    expect(machine.stdout).not.toContain(`${NON_ANTHROPIC_AUTHORS[0]}/*,`);
  });
});
