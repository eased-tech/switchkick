import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { TIERS } from "@switchkick/core";
import { type CatalogModel, fetchCatalog, type ModelPricing } from "./catalog.js";
import { CommandError, type CommandIo, loadCommandConfig, parseCommand } from "./command.js";
import { expandHome, resolveTiers } from "./config.js";
import { type DecisionLogEntry, defaultLogPath } from "./log.js";
import type { Usage } from "./metadata.js";

export const REPORT_HELP = `Usage: switchkick report [log] [options]

Summarizes the decision log: requests per tier and model, what they cost, what they would have
cost on one baseline model, Jev's latency, and how often routing fell back. Reads the log and
its rotated copy (<log>.1). The log never holds prompt text, and neither does the report.

Options:
  [log]               The log to read (default: the config's log.file, or ${defaultLogPath()})
  --since <when>      Only requests after this: a duration such as 24h or 7d, or a date
  --baseline <model>  OpenRouter model to compare spend with (default: the frontier tier's)
  --json              Print the summary as JSON
  --config <path>     Config file, for the log path and the frontier tier
`;

interface ModelRow {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** USD, from the responses that reported it. */
  cost: number;
}

export interface ReportSummary {
  files: string[];
  from: string | null;
  to: string | null;
  requests: number;
  /** Lines that weren't valid log entries. */
  skipped: number;
  modes: Record<string, number>;
  tiers: Record<string, number>;
  models: ModelRow[];
  turns: Record<string, number>;
  reasons: Record<string, number>;
  errors: Record<string, number>;
  spend: {
    /** What OpenRouter charged for model calls, from responses that reported it. */
    models: number;
    jev: number;
    total: number;
    /** Requests whose response reported usage. */
    measured: number;
    inputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
  };
  baseline: { model: string; cost: number } | { model: string; error: string } | null;
  jev: {
    calls: number;
    failures: Record<string, number>;
    p50Ms: number | null;
    p95Ms: number | null;
    /** Requests that fell back to the default tier because Jev failed. */
    fellBack: number;
  };
  hosted: {
    requests: number;
    /** Retried in static mode because the router was unavailable. */
    fellBack: number;
    servedModels: Record<string, number>;
    routerReasons: Record<string, number>;
    modelsIgnored: number;
  };
}

const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** A `--since` value as a timestamp. */
export function parseSince(value: string, now: number): number {
  const relative = /^(\d+)\s*([mhdw])$/i.exec(value.trim());
  if (relative) {
    return now - Number(relative[1]) * (UNITS[(relative[2] as string).toLowerCase()] as number);
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) {
    throw new CommandError(
      `--since must be a duration such as 24h or 7d, or a date; got "${value}".`,
    );
  }
  return date;
}

function bump(counts: Record<string, number>, key: string, by = 1) {
  counts[key] = (counts[key] ?? 0) + by;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
}

/** What `usage` would have cost at `pricing`, with cache reads and writes at their own prices. */
export function priceUsage(usage: Usage, pricing: ModelPricing): number {
  const cached = usage.cachedTokens ?? 0;
  const written = usage.cacheWriteTokens ?? 0;
  const fresh = Math.max(0, (usage.inputTokens ?? 0) - cached - written);
  return (
    fresh * pricing.prompt +
    cached * (pricing.cacheRead ?? pricing.prompt) +
    written * (pricing.cacheWrite ?? pricing.prompt) +
    (usage.outputTokens ?? 0) * pricing.completion
  );
}

const isEntry = (value: unknown): value is DecisionLogEntry =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as DecisionLogEntry).ts === "string" &&
  typeof (value as DecisionLogEntry).model === "string";

/** Reads log files line by line and summarizes them. Missing files are skipped. */
export async function summarize(
  paths: string[],
  options: { since?: number; baseline?: { model: string; pricing: ModelPricing | null } } = {},
): Promise<ReportSummary> {
  const summary: ReportSummary = {
    files: [],
    from: null,
    to: null,
    requests: 0,
    skipped: 0,
    modes: {},
    tiers: {},
    models: [],
    turns: {},
    reasons: {},
    errors: {},
    spend: {
      models: 0,
      jev: 0,
      total: 0,
      measured: 0,
      inputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    },
    baseline: null,
    jev: { calls: 0, failures: {}, p50Ms: null, p95Ms: null, fellBack: 0 },
    hosted: { requests: 0, fellBack: 0, servedModels: {}, routerReasons: {}, modelsIgnored: 0 },
  };
  const models = new Map<string, ModelRow>();
  const latencies: number[] = [];
  let baselineCost = 0;

  for (const path of paths) {
    const stream = createReadStream(path, { encoding: "utf8" });
    const opened = await new Promise<boolean>((resolve) => {
      stream.once("open", () => resolve(true));
      stream.once("error", () => resolve(false));
    });
    if (!opened) continue;
    summary.files.push(path);
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (line.trim() === "") continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        summary.skipped++;
        continue;
      }
      if (!isEntry(entry)) {
        summary.skipped++;
        continue;
      }
      const ts = Date.parse(entry.ts);
      if (options.since !== undefined && !(ts >= options.since)) continue;
      add(entry);
    }
  }

  function add(entry: DecisionLogEntry) {
    summary.requests++;
    if (summary.from === null || entry.ts < summary.from) summary.from = entry.ts;
    if (summary.to === null || entry.ts > summary.to) summary.to = entry.ts;
    bump(summary.modes, entry.mode);
    bump(summary.reasons, entry.reason);
    if (entry.turn) bump(summary.turns, entry.turn);
    bump(summary.tiers, entry.tier ?? (entry.mode === "hosted" ? "router" : "pinned"));
    if (entry.error) bump(summary.errors, entry.error);
    else if (entry.status >= 400) bump(summary.errors, `http_${entry.status}`);

    const model = entry.servedModel ?? entry.model;
    let row = models.get(model);
    if (!row) {
      row = { model, requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
      models.set(model, row);
    }
    row.requests++;
    const usage = entry.usage;
    if (usage) {
      summary.spend.measured++;
      row.inputTokens += usage.inputTokens ?? 0;
      row.outputTokens += usage.outputTokens ?? 0;
      row.cost += usage.cost ?? 0;
      summary.spend.models += usage.cost ?? 0;
      summary.spend.inputTokens += usage.inputTokens ?? 0;
      summary.spend.cachedTokens += usage.cachedTokens ?? 0;
      summary.spend.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
      summary.spend.outputTokens += usage.outputTokens ?? 0;
      if (options.baseline?.pricing) baselineCost += priceUsage(usage, options.baseline.pricing);
    }

    if (entry.jev) {
      summary.jev.calls++;
      latencies.push(entry.jev.latencyMs);
      if ("error" in entry.jev) bump(summary.jev.failures, entry.jev.error);
      else summary.spend.jev += entry.jev.cost ?? 0;
    }
    if (entry.reason === "fail_open" || entry.reason === "fail_closed") summary.jev.fellBack++;

    if (entry.mode === "hosted") {
      summary.hosted.requests++;
      if (entry.fallback === "static") summary.hosted.fellBack++;
      if (entry.servedModel) bump(summary.hosted.servedModels, entry.servedModel);
      if (entry.router?.reason) bump(summary.hosted.routerReasons, entry.router.reason);
      if (entry.warnings?.includes("models_ignored")) summary.hosted.modelsIgnored++;
    }
  }

  latencies.sort((a, b) => a - b);
  summary.jev.p50Ms = percentile(latencies, 50);
  summary.jev.p95Ms = percentile(latencies, 95);
  summary.models = [...models.values()].sort((a, b) => b.requests - a.requests);
  summary.spend.total = summary.spend.models + summary.spend.jev;
  if (options.baseline) {
    summary.baseline = options.baseline.pricing
      ? { model: options.baseline.model, cost: baselineCost }
      : { model: options.baseline.model, error: "no price on OpenRouter's model list" };
  }
  return summary;
}

const usd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const pct = (part: number, whole: number) =>
  whole === 0 ? "0%" : `${((100 * part) / whole).toFixed(part / whole < 0.1 ? 1 : 0)}%`;
const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

function counts(record: Record<string, number>, total: number): string {
  return Object.entries(record)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${key} ${n} (${pct(n, total)})`)
    .join(", ");
}

/** The summary as text for a terminal. */
export function formatReport(s: ReportSummary): string {
  if (s.requests === 0) {
    return `No requests${s.files.length === 0 ? ": no log file found" : ""}.\n`;
  }
  const lines: string[] = [];
  lines.push(`${s.requests} requests, ${s.from} to ${s.to}`);
  lines.push(
    `  log: ${s.files.join(", ")}${s.skipped ? ` (${s.skipped} unreadable lines skipped)` : ""}`,
  );
  lines.push(`  modes: ${counts(s.modes, s.requests)}`);
  lines.push("");

  const order = [...TIERS, "router", "pinned"];
  lines.push("Tiers:");
  for (const tier of order.filter((t) => s.tiers[t])) {
    lines.push(
      `  ${tier.padEnd(9)} ${String(s.tiers[tier]).padStart(7)}  ${pct(s.tiers[tier] as number, s.requests).padStart(5)}`,
    );
  }
  lines.push("");

  const width = Math.max(5, ...s.models.map((m) => m.model.length));
  lines.push(
    `  ${"Model".padEnd(width)}${"Requests".padStart(9)}${"Input".padStart(9)}${"Output".padStart(9)}${"Cost".padStart(10)}`,
  );
  for (const m of s.models) {
    lines.push(
      `  ${m.model.padEnd(width)}${String(m.requests).padStart(9)}${tokens(m.inputTokens).padStart(9)}` +
        `${tokens(m.outputTokens).padStart(9)}${usd(m.cost).padStart(10)}`,
    );
  }
  lines.push("");

  const sp = s.spend;
  lines.push(
    `Spend: ${usd(sp.total)} (models ${usd(sp.models)}, Jev ${usd(sp.jev)}), from the ${sp.measured} ` +
      `of ${s.requests} responses that reported cost`,
  );
  if (sp.inputTokens > 0) {
    lines.push(
      `  input ${tokens(sp.inputTokens)} tokens (${pct(sp.cachedTokens, sp.inputTokens)} from cache), output ${tokens(sp.outputTokens)}`,
    );
  }
  if (sp.measured === 0) {
    // Nothing to compare.
  } else if (s.baseline && "cost" in s.baseline) {
    const saved = s.baseline.cost - sp.total;
    lines.push(
      `  on ${s.baseline.model} alone, the same tokens would cost about ${usd(s.baseline.cost)} at list ` +
        `price: ${saved >= 0 ? `${usd(saved)} (${pct(saved, s.baseline.cost)}) saved` : `${usd(-saved)} more spent`}`,
    );
  } else if (s.baseline) {
    lines.push(`  no comparison with ${s.baseline.model}: ${s.baseline.error}`);
  }

  if (s.jev.calls > 0 || s.modes.local) {
    lines.push("");
    lines.push(
      `Jev: ${s.jev.calls} calls, p50 ${s.jev.p50Ms ?? "-"} ms, p95 ${s.jev.p95Ms ?? "-"} ms` +
        `${Object.keys(s.jev.failures).length ? `; failed: ${counts(s.jev.failures, s.jev.calls)}` : ""}`,
    );
    lines.push(
      `  fell back to the default tier: ${s.jev.fellBack} (${pct(s.jev.fellBack, s.jev.calls)} of calls)`,
    );
    if (Object.keys(s.turns).length)
      lines.push(`  turns: ${counts(s.turns, s.modes.local ?? s.requests)}`);
    lines.push(`  reasons: ${counts(s.reasons, s.requests)}`);
  }
  if (s.hosted.requests > 0) {
    const h = s.hosted;
    lines.push("");
    lines.push(
      `Hosted: ${h.requests} requests, ${h.fellBack} (${pct(h.fellBack, h.requests)}) retried in static mode`,
    );
    if (Object.keys(h.servedModels).length)
      lines.push(`  served by: ${counts(h.servedModels, h.requests)}`);
    if (Object.keys(h.routerReasons).length)
      lines.push(`  router reasons: ${counts(h.routerReasons, h.requests)}`);
    if (h.modelsIgnored) {
      lines.push(
        `  ${h.modelsIgnored} request(s) ignored hosted.models: none of its models was in the router's pool`,
      );
    }
  }
  if (Object.keys(s.errors).length) {
    lines.push("");
    lines.push(`Errors: ${counts(s.errors, s.requests)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** `switchkick report`. */
export async function reportCommand(argv: string[], io: CommandIo): Promise<number> {
  const { values, positionals } = parseCommand(
    argv,
    {
      since: { type: "string" },
      baseline: { type: "string" },
      json: { type: "boolean" },
      config: { type: "string" },
    },
    REPORT_HELP,
  );
  if (values.help) {
    io.stdout(REPORT_HELP);
    return 0;
  }
  if (positionals.length > 1) {
    throw new CommandError(`unexpected argument: ${positionals[1]}\n\n${REPORT_HELP}`);
  }
  const loaded = await loadCommandConfig(values.config, io.env);
  const { config } = loaded;
  const log = positionals[0]
    ? expandHome(positionals[0])
    : config.log.file
      ? expandHome(config.log.file)
      : defaultLogPath(io.env);
  const since = values.since ? parseSince(values.since, Date.now()) : undefined;

  const baselineModel = values.baseline ?? resolveTiers(config).frontier.model;
  let baseline: { model: string; pricing: ModelPricing | null } | undefined;
  let catalogError: string | null = null;
  let catalog: Map<string, CatalogModel> | null = null;
  try {
    catalog = await fetchCatalog(io.system.fetch, config.upstream.baseUrl);
  } catch (error) {
    catalogError = (error as Error).message;
  }
  if (catalog)
    baseline = { model: baselineModel, pricing: catalog.get(baselineModel)?.pricing ?? null };

  const summary = await summarize([`${log}.1`, log], {
    ...(since !== undefined ? { since } : {}),
    ...(baseline ? { baseline } : {}),
  });
  if (!baseline)
    summary.baseline = { model: baselineModel, error: `couldn't fetch prices (${catalogError})` };
  if (summary.files.length === 0) {
    throw new CommandError(
      `no decision log at ${log}. Is logging on, and has switchkick served requests?`,
    );
  }
  io.stdout(values.json ? `${JSON.stringify(summary, null, 2)}\n` : formatReport(summary));
  return 0;
}
