import { access } from "node:fs/promises";
import { ROUTING_QUESTIONS, readVerdict, TIERS } from "@switchkick/core";
import { createJevClient } from "@switchkick/jev";
import { VERSION } from "./app.js";
import { fetchCatalog } from "./catalog.js";
import {
  CLAUDE_DEFAULT_MAX_TOKENS,
  CLIENT_NAMES,
  type Client,
  claudeEnv,
  claudeSettingsPath,
  claudeWiring,
  codexConfigPath,
  codexWiring,
  type Endpoint,
  PLACEHOLDER_KEY,
} from "./clients.js";
import {
  CommandError,
  type CommandIo,
  configEndpoint,
  loadCommandConfig,
  parseCommand,
} from "./command.js";
import { type LoadedConfig, resolveHosted, resolveTiers, resolveTrusted } from "./config.js";
import { CredentialError, type FoundKey, findStoredKey } from "./credentials.js";
import { ATTRIBUTION } from "./forward.js";
import { type Manifest, readBytes, readManifest } from "./manifest.js";
import { NON_ANTHROPIC_AUTHORS, ROUTER_AUTHORS } from "./presets.js";
import { serviceLogHint, serviceStatus } from "./service.js";
import { waitForHealth } from "./setup.js";

export const DOCTOR_HELP = `Usage: switchkick doctor [--live] [--config <path>]

Checks that switchkick is ready: the config file, the OpenRouter key (never shown), that the
configured models exist on OpenRouter, the background service, the client settings setup
changed, and that the proxy answers. Exits 1 if anything fails.

  --live   Also make one Jev call (local mode) and one tiny model call through the proxy, at
           the frontier tier. Costs a fraction of a cent. For Claude Code, the call asks for the
           same max_tokens Claude Code will, so a 402 from OpenRouter (credit too low for the
           request's worst case) shows up here rather than mid-session.
`;

type Level = "ok" | "warn" | "fail" | "info";
const MARKS: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗", info: "·" };

/** The model call's prompt: short, and with one obvious answer. */
const LIVE_PROMPT = "Reply with the single word OK.";

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** The program and script a service file runs, to check they still exist. */
function serviceProgram(text: string, kind: "launchd" | "systemd"): string[] {
  if (kind === "launchd") {
    const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
    return [...array.matchAll(/<string>([^<]*)<\/string>/g)]
      .map((m) =>
        (m[1] ?? "")
          .replaceAll("&quot;", '"')
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&amp;", "&"),
      )
      .slice(0, 2);
  }
  const line = /^ExecStart=(.*)$/m.exec(text)?.[1] ?? "";
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => (m[1] ?? "").replace(/\\(.)/g, "$1").replaceAll("%%", "%").replaceAll("$$", "$"))
    .slice(0, 2);
}

/** `switchkick doctor`. */
export async function doctorCommand(argv: string[], io: CommandIo): Promise<number> {
  const { values, positionals } = parseCommand(
    argv,
    { live: { type: "boolean" }, config: { type: "string" } },
    DOCTOR_HELP,
  );
  if (values.help) {
    io.stdout(DOCTOR_HELP);
    return 0;
  }
  if (positionals.length > 0) {
    throw new CommandError(`unexpected argument: ${positionals[0]}\n\n${DOCTOR_HELP}`);
  }
  const { system, env } = io;
  let failures = 0;
  const report = (level: Level, text: string) => {
    if (level === "fail") failures++;
    io.stdout(`${MARKS[level]} ${text}\n`);
  };

  // Config.
  let loaded: LoadedConfig;
  try {
    loaded = await loadCommandConfig(values.config, env);
  } catch (error) {
    report("fail", `Config: ${(error as Error).message}`);
    return 1;
  }
  const { config } = loaded;
  report(
    "ok",
    `Config: ${loaded.path ?? "built-in defaults (no config file)"}; mode ${config.mode}` +
      `${config.preset ? `, preset ${config.preset}` : ""}`,
  );
  const endpoint = configEndpoint(loaded, env);

  let manifest: Manifest | null = null;
  try {
    manifest = await readManifest(env);
  } catch (error) {
    report("warn", `Setup record: ${(error as Error).message}`);
  }

  // Key.
  let key: FoundKey | null = null;
  try {
    key = await io.findApiKey(env);
    report("ok", `Key: found in ${key.source}`);
  } catch (error) {
    if (!(error instanceof CredentialError)) throw error;
    report(
      "fail",
      `Key: ${error.message.replaceAll("\n", "\n    ")}\n    Run \`switchkick setup\`.`,
    );
  }
  if (key?.source === "OPENROUTER_API_KEY" && manifest?.service && !(await findStoredKey(system))) {
    report(
      "fail",
      "Key: only in OPENROUTER_API_KEY, which the background service doesn't see. Run " +
        "`switchkick setup` to store it.",
    );
  }

  // Models.
  const targets = new Map<string, string>();
  const tiers = resolveTiers(config);
  for (const tier of TIERS) targets.set(tiers[tier].model, `tiers.${tier}`);
  const trusted = resolveTrusted(config).model;
  if (!targets.has(trusted)) targets.set(trusted, "trusted");
  for (const [pattern, model] of Object.entries(config.policy.modelPins)) {
    if (!targets.has(model)) targets.set(model, `policy.modelPins["${pattern}"]`);
  }
  try {
    const catalog = await fetchCatalog(system.fetch, config.upstream.baseUrl);
    const missing = [...targets].filter(([model]) => !catalog.has(model));
    if (missing.length === 0) {
      report("ok", `Models: all ${targets.size} configured models are on OpenRouter`);
    } else {
      for (const [model, where] of missing) {
        report("fail", `Models: ${model} (${where}) isn't on OpenRouter's model list`);
      }
    }
    const hosted = resolveHosted(config);
    const presetList =
      config.preset === "claude-only" && config.hosted.excluded_models === undefined;
    if (config.mode === "hosted" && presetList) {
      const known = new Set<string>([...NON_ANTHROPIC_AUTHORS, ...ROUTER_AUTHORS]);
      const authors = [
        ...new Set([...catalog.keys()].map((id) => id.split("/")[0]?.replace(/^~/, "") ?? "")),
      ];
      const fresh = authors.filter((author) => author && !known.has(author));
      if (fresh.length > 0) {
        report(
          "warn",
          `Hosted: the claude-only preset doesn't exclude ${fresh.map((a) => `${a}/*`).join(", ")}, ` +
            "new on OpenRouter. Add them to hosted.excluded_models (with the preset's list: " +
            `${hosted.excluded_models.length} patterns) or upgrade switchkick.`,
        );
      }
    }
  } catch (error) {
    report("warn", `Models: couldn't check them (${(error as Error).message})`);
  }

  // Service.
  if (manifest?.service) {
    const { service } = manifest;
    const text = (await readBytes(service.path))?.toString("utf8") ?? null;
    if (text === null) {
      report("fail", `Service: ${service.path} is gone. Run \`switchkick setup\` again.`);
    } else {
      const program = serviceProgram(text, service.kind);
      const lost = [];
      for (const path of program)
        if (path.startsWith("/") && !(await exists(path))) lost.push(path);
      if (lost.length > 0) {
        report(
          "fail",
          `Service: it runs ${lost.join(" and ")}, which no longer exists. Run \`switchkick setup\` again.`,
        );
      }
      const status = await serviceStatus(system, service);
      if (status.running) report("ok", `Service: ${service.kind} ${service.name} is running`);
      else {
        report(
          "fail",
          `Service: ${service.kind} ${service.name} is ${status.loaded ? "loaded but not running" : "not loaded"}` +
            `${status.detail ? ` (${status.detail})` : ""}. See ${serviceLogHint(system, service)}.`,
        );
      }
    }
  } else {
    report(
      "info",
      "Service: none installed by setup; `switchkick serve` runs it in the foreground",
    );
  }

  // Proxy.
  const health = await waitForHealth(system, endpoint.url, 1500);
  if (!health) {
    report("fail", `Proxy: nothing answers at ${endpoint.url}`);
  } else if (health.version !== VERSION) {
    report(
      "warn",
      `Proxy: switchkick ${health.version} answers at ${endpoint.url}, but this is ${VERSION}. ` +
        "Restart it to pick up this version.",
    );
  } else {
    report("ok", `Proxy: switchkick ${health.version} answers at ${endpoint.url}`);
  }

  // Clients.
  const wiredClients = new Set<Client>(manifest?.clients ?? []);
  let claudeMaxTokens: number | null = null;
  for (const client of ["codex", "claude"] as const) {
    const path = client === "codex" ? codexConfigPath(system) : claudeSettingsPath(system);
    const text = (await readBytes(path))?.toString("utf8") ?? null;
    const state = client === "codex" ? codexWiring(text, endpoint) : claudeWiring(text, endpoint);
    const name = CLIENT_NAMES[client];
    if (state.wired) {
      report("ok", `${name}: points at ${endpoint.url} (${path})`);
    } else if (wiredClients.has(client)) {
      report("fail", `${name}: setup pointed it at switchkick, but ${state.reason} (${path})`);
    } else {
      report("info", `${name}: not pointed at switchkick`);
    }
    if (client === "claude" && state.wired) {
      const configured =
        claudeEnv(text)?.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
      const parsed = Number(configured);
      claudeMaxTokens = Number.isInteger(parsed) && parsed > 0 ? parsed : CLAUDE_DEFAULT_MAX_TOKENS;
      if (configured === undefined) {
        report(
          "warn",
          `${name}: CLAUDE_CODE_MAX_OUTPUT_TOKENS isn't set, so it asks for ${CLAUDE_DEFAULT_MAX_TOKENS} ` +
            "output tokens and OpenRouter refuses (402) when credit can't cover that. `--live` checks.",
        );
      }
    }
  }

  if (values.live) {
    failures += await live(io, loaded, endpoint, key, health !== null, claudeMaxTokens, report);
  }

  io.stdout(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
  return failures === 0 ? 0 : 1;
}

/** The `--live` checks. Returns how many failed (already reported). */
async function live(
  io: CommandIo,
  loaded: LoadedConfig,
  endpoint: Endpoint,
  key: FoundKey | null,
  proxyUp: boolean,
  claudeMaxTokens: number | null,
  report: (level: Level, text: string) => void,
): Promise<number> {
  const { config } = loaded;
  let failures = 0;
  const fail = (text: string) => {
    failures++;
    report("fail", text);
  };

  if (config.mode === "local") {
    if (!key) {
      fail("Jev: skipped, no key");
    } else {
      const jev = createJevClient({
        apiKey: key.key,
        model: config.jev.model,
        baseUrl: config.jev.baseUrl,
        deadlineMs: 10_000,
        headers: config.attribution ? { ...ATTRIBUTION } : {},
        fetch: io.system.fetch,
      });
      const result = await jev.decide({
        state: { latest_user_message: "Rename the variable `x` to `count` in utils.ts." },
        questions: ROUTING_QUESTIONS,
        sessionId: "switchkick-doctor",
      });
      const verdict = result.ok ? readVerdict(result.response.answers) : null;
      if (result.ok && verdict) {
        const top = TIERS.reduce((a, b) =>
          verdict.probabilities[b] > verdict.probabilities[a] ? b : a,
        );
        report(
          "ok",
          `Jev: ${result.response.model} answered in ${result.latencyMs} ms (a rename → ${top}, ` +
            `p=${verdict.probabilities[top].toFixed(2)})`,
        );
      } else if (result.ok) {
        fail("Jev: answered, but not with the expected answers");
      } else {
        const e = result.error;
        fail(
          `Jev: ${e.kind === "http" ? `HTTP ${e.status}: ${e.message}` : e.kind}` +
            `${e.kind === "http" && [401, 402, 403].includes(e.status) ? ". Check the key and its credits." : ""}`,
        );
      }
    }
  }

  if (!proxyUp) {
    fail("Model call: skipped, the proxy isn't answering");
    return failures;
  }
  const claude = claudeMaxTokens !== null;
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${endpoint.token ?? PLACEHOLDER_KEY}`,
    "x-switchkick-tier": "frontier",
    "x-switchkick-session": "switchkick-doctor",
    ...(claude ? { "anthropic-version": "2023-06-01" } : {}),
  };
  const messages = [{ role: "user", content: LIVE_PROMPT }];
  const body = claude
    ? { model: "claude-doctor", max_tokens: claudeMaxTokens, messages }
    : { model: "doctor", max_tokens: 16, messages };
  const started = Date.now();
  let response: Response;
  try {
    response = await io.system.fetch(
      `${endpoint.url}/v1/${claude ? "messages" : "chat/completions"}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      },
    );
  } catch (error) {
    fail(`Model call: ${(error as Error).message}`);
    return failures;
  }
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // Reported below by status.
  }
  const served = typeof parsed.model === "string" ? parsed.model : "a model";
  const what = claude ? `Claude Code's max_tokens (${claudeMaxTokens})` : "max_tokens 16";
  if (response.ok) {
    report(
      "ok",
      `Model call: ${served} answered in ${Date.now() - started} ms, at the frontier tier with ${what}`,
    );
  } else {
    const message =
      ((parsed.error as Record<string, unknown> | undefined)?.message as string | undefined) ??
      `HTTP ${response.status}`;
    if (response.status === 402) {
      fail(
        `Model call: OpenRouter refused it (402): ${message}\n    The account's credit, or the ` +
          `key's limit, doesn't cover the request's worst case at the frontier tier with ${what}. ` +
          "Add credit or raise the key's limit, or " +
          (claude
            ? "lower CLAUDE_CODE_MAX_OUTPUT_TOKENS in Claude Code's settings."
            : "lower max_tokens."),
      );
    } else {
      fail(`Model call: HTTP ${response.status}: ${message}`);
    }
  }
  return failures;
}
