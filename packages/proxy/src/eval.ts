import { readFile, writeFile } from "node:fs/promises";
import {
  isTier,
  type JevVerdict,
  jevState,
  type Policy,
  ROUTING_QUESTIONS,
  readVerdict,
  TIERS,
  type Tier,
  tierFromVerdict,
  tierRank,
} from "@switchkick/core";
import { createJevClient } from "@switchkick/jev";
import { CommandError, type CommandIo, loadCommandConfig, parseCommand } from "./command.js";
import { expandHome, resolvePolicy } from "./config.js";
import { CredentialError } from "./credentials.js";
import { ATTRIBUTION } from "./forward.js";

export const DEFAULT_EVAL_SET = "eval/prompts.jsonl";

export const EVAL_HELP = `Usage: switchkick eval [options]

Asks Jev about each prompt in a labelled set, routes its answers with the config's policy, and
compares the result with the labels: a confusion matrix, accuracy, how often a prompt went to a
cheaper tier than its label (a quality risk) or a dearer one (a cost), and how each tier's
\`policy.accept\` bar changes those numbers. Use it to tune \`accept\` for your own prompts.

The set is JSON Lines, one prompt per line:
  {"id": "rename", "tier": "fast", "prompt": "Rename x to count in utils.ts"}
"previous" may hold the assistant message the prompt replies to. Each prompt costs one Jev call,
a small fraction of a cent.

Options:
  --set <file>        The labelled set (default ${DEFAULT_EVAL_SET}, as in the switchkick repo)
  --answers <file>    Save Jev's answers (ids, labels and probabilities, no prompt text)
  --from <file>       Re-run the policy on saved answers instead of asking Jev again
  --concurrency <n>   Jev calls at once (default 4)
  --json              Print the results as JSON
  --config <path>     Config file, for the policy and Jev settings
`;

export interface EvalCase {
  id: string;
  tier: Tier;
  prompt: string;
  previous?: string;
}

/** Jev's answer for one case, as saved with `--answers`. */
export interface EvalAnswer {
  id: string;
  tier: Tier;
  verdict: JevVerdict | null;
  error?: string;
  latencyMs?: number;
  cost?: number;
}

export interface EvalScore {
  /** Cases Jev answered. */
  scored: number;
  correct: number;
  /** Routed below the label. */
  under: number;
  /** Routed above the label. */
  over: number;
  /** label → routed tier → count. */
  confusion: Record<Tier, Record<Tier, number>>;
}

export interface EvalResult {
  set: string;
  cases: number;
  failed: number;
  cost: number;
  accept: Record<Tier, number>;
  score: EvalScore;
  /** For each tier, the score as its bar moves and the others stay as configured. */
  sweeps: Record<Tier, { bar: number; score: Omit<EvalScore, "confusion"> }[]>;
}

/** Parses a labelled set. Blank lines and lines starting with `#` are skipped. */
export function parseEvalSet(text: string, source: string): EvalCase[] {
  const cases: EvalCase[] = [];
  const ids = new Set<string>();
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const at = `${source}:${index + 1}`;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line);
    } catch {
      throw new CommandError(`${at}: not valid JSON`);
    }
    if (typeof value?.prompt !== "string" || value.prompt.trim() === "") {
      throw new CommandError(`${at}: "prompt" must be a non-empty string`);
    }
    if (typeof value.tier !== "string" || !isTier(value.tier)) {
      throw new CommandError(`${at}: "tier" must be one of ${TIERS.join(", ")}`);
    }
    const id = typeof value.id === "string" && value.id !== "" ? value.id : String(index + 1);
    if (ids.has(id)) throw new CommandError(`${at}: duplicate id "${id}"`);
    ids.add(id);
    cases.push({
      id,
      tier: value.tier,
      prompt: value.prompt,
      ...(typeof value.previous === "string" ? { previous: value.previous } : {}),
    });
  });
  if (cases.length === 0) throw new CommandError(`${source} has no prompts`);
  return cases;
}

function parseAnswers(text: string, source: string): EvalAnswer[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      const value = JSON.parse(line) as EvalAnswer;
      if (typeof value?.id !== "string" || !isTier(value.tier)) {
        throw new CommandError(`${source}:${index + 1}: not a saved eval answer`);
      }
      return value;
    });
}

const emptyConfusion = () =>
  Object.fromEntries(TIERS.map((t) => [t, Object.fromEntries(TIERS.map((u) => [u, 0]))])) as Record<
    Tier,
    Record<Tier, number>
  >;

/** Routes each answer with `policy` and compares the tiers with the labels. */
export function scoreAnswers(
  answers: EvalAnswer[],
  policy: Pick<Policy, "accept" | "sensitiveFloor" | "claimGuard">,
): EvalScore {
  const score: EvalScore = {
    scored: 0,
    correct: 0,
    under: 0,
    over: 0,
    confusion: emptyConfusion(),
  };
  for (const answer of answers) {
    if (!answer.verdict) continue;
    const routed = tierFromVerdict(answer.verdict, policy).tier;
    score.scored++;
    score.confusion[answer.tier][routed]++;
    const diff = tierRank(routed) - tierRank(answer.tier);
    if (diff === 0) score.correct++;
    else if (diff < 0) score.under++;
    else score.over++;
  }
  return score;
}

const SWEEP_BARS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95];

export function evaluate(
  set: string,
  answers: EvalAnswer[],
  policy: Pick<Policy, "accept" | "sensitiveFloor" | "claimGuard">,
): EvalResult {
  const sweeps = {} as EvalResult["sweeps"];
  for (const tier of TIERS) {
    const bars = [...new Set([...SWEEP_BARS, policy.accept[tier]])].sort((a, b) => a - b);
    sweeps[tier] = bars.map((bar) => {
      const { confusion: _, ...score } = scoreAnswers(answers, {
        ...policy,
        accept: { ...policy.accept, [tier]: bar },
      });
      return { bar, score };
    });
  }
  return {
    set,
    cases: answers.length,
    failed: answers.filter((a) => !a.verdict).length,
    cost: answers.reduce((total, a) => total + (a.cost ?? 0), 0),
    accept: { ...policy.accept },
    score: scoreAnswers(answers, policy),
    sweeps,
  };
}

const pct = (part: number, whole: number) =>
  whole === 0 ? "-" : `${Math.round((100 * part) / whole)}%`;

export function formatEval(result: EvalResult): string {
  const { score } = result;
  const lines: string[] = [];
  lines.push(
    `${result.cases} prompts from ${result.set}: ${score.scored} answered` +
      `${result.failed ? `, ${result.failed} failed` : ""}` +
      `${result.cost ? `, Jev cost $${result.cost.toFixed(4)}` : ""}`,
  );
  lines.push(`accept: ${TIERS.map((t) => `${t} ${result.accept[t]}`).join(", ")}`);
  lines.push("");
  lines.push("Label ↓ routed →".padEnd(18) + TIERS.map((t) => t.padStart(10)).join(""));
  for (const label of TIERS) {
    lines.push(
      `  ${label.padEnd(16)}${TIERS.map((t) => String(score.confusion[label][t]).padStart(10)).join("")}`,
    );
  }
  lines.push("");
  lines.push(
    `Accuracy ${pct(score.correct, score.scored)} (${score.correct}/${score.scored}). ` +
      `Below the label ${pct(score.under, score.scored)} (quality risk), ` +
      `above it ${pct(score.over, score.scored)} (extra cost).`,
  );
  lines.push("");
  lines.push("Moving one bar at a time (others as configured): accuracy / below / above");
  for (const tier of TIERS) {
    lines.push(`  accept.${tier}`);
    for (const { bar, score: s } of result.sweeps[tier]) {
      const mark = bar === result.accept[tier] ? " ← current" : "";
      lines.push(
        `    ${bar.toFixed(2)}  ${pct(s.correct, s.scored).padStart(4)} / ${pct(s.under, s.scored).padStart(4)} / ` +
          `${pct(s.over, s.scored).padStart(4)}${mark}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Runs `work` over `items` with at most `limit` at once, keeping their order. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** `switchkick eval`. */
export async function evalCommand(argv: string[], io: CommandIo): Promise<number> {
  const { values, positionals } = parseCommand(
    argv,
    {
      set: { type: "string" },
      answers: { type: "string" },
      from: { type: "string" },
      concurrency: { type: "string" },
      json: { type: "boolean" },
      config: { type: "string" },
    },
    EVAL_HELP,
  );
  if (values.help) {
    io.stdout(EVAL_HELP);
    return 0;
  }
  if (positionals.length > 0) {
    throw new CommandError(`unexpected argument: ${positionals[0]}\n\n${EVAL_HELP}`);
  }
  const concurrency = Number(values.concurrency ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new CommandError("--concurrency must be an integer from 1 to 32.");
  }
  const { config } = await loadCommandConfig(values.config, io.env);
  const policy = resolvePolicy(config);

  const read = async (path: string, what: string) => {
    try {
      return await readFile(expandHome(path), "utf8");
    } catch (error) {
      const hint =
        what === "set" && !values.set
          ? " Pass --set, or run from a switchkick checkout, which has a starter set there."
          : "";
      throw new CommandError(`can't read ${path}: ${(error as Error).message}.${hint}`);
    }
  };

  let answers: EvalAnswer[];
  let source: string;
  if (values.from) {
    source = values.from;
    answers = parseAnswers(await read(values.from, "answers"), values.from);
  } else {
    source = values.set ?? DEFAULT_EVAL_SET;
    const cases = parseEvalSet(await read(source, "set"), source);
    let key: string;
    try {
      key = (await io.findApiKey(io.env)).key;
    } catch (error) {
      if (error instanceof CredentialError) throw new CommandError(error.message);
      throw error;
    }
    const jev = createJevClient({
      apiKey: key,
      model: config.jev.model,
      baseUrl: config.jev.baseUrl,
      // Not on a request's path, so slow answers are worth waiting for.
      deadlineMs: Math.max(config.jev.deadlineMs, 15_000),
      headers: config.attribution ? { ...ATTRIBUTION } : {},
      fetch: io.system.fetch,
    });
    let done = 0;
    answers = await mapLimited(cases, concurrency, async (c): Promise<EvalAnswer> => {
      const result = await jev.decide({
        state: jevState(c.prompt, c.previous ?? null, config.jev.requestChars),
        questions: ROUTING_QUESTIONS,
        sessionId: `switchkick-eval-${c.id}`,
      });
      done++;
      if (!values.json) io.stderr(`\r  asked Jev ${done}/${cases.length}`);
      if (!result.ok) {
        const e = result.error;
        return {
          id: c.id,
          tier: c.tier,
          verdict: null,
          error: e.kind === "http" ? `HTTP ${e.status}: ${e.message}` : e.kind,
        };
      }
      const verdict = readVerdict(result.response.answers);
      return {
        id: c.id,
        tier: c.tier,
        verdict,
        ...(verdict ? {} : { error: "unexpected answers" }),
        latencyMs: result.latencyMs,
        ...(result.response.usage.cost !== undefined ? { cost: result.response.usage.cost } : {}),
      };
    });
    if (!values.json) io.stderr("\n");
    const failures = answers.filter((a) => a.error);
    for (const failure of failures.slice(0, 5)) io.stderr(`  ${failure.id}: ${failure.error}\n`);
    if (failures.length === answers.length) {
      throw new CommandError(`Jev answered none of the ${answers.length} prompts.`);
    }
  }

  if (values.answers) {
    await writeFile(
      expandHome(values.answers),
      `${answers.map((a) => JSON.stringify(a)).join("\n")}\n`,
    );
  }
  const result = evaluate(source, answers, policy);
  io.stdout(values.json ? `${JSON.stringify(result, null, 2)}\n` : formatEval(result));
  return 0;
}
