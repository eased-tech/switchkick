import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileLog, type DecisionLogEntry, defaultLogPath } from "../src/index.js";
import { send, startProxy, startUpstream } from "./helpers.js";

const ENTRY: DecisionLogEntry = {
  ts: "2026-10-19T00:00:00.000Z",
  format: "chat",
  stream: false,
  mode: "static",
  tier: "balanced",
  requestedModel: null,
  model: "test/routed-model",
  effort: null,
  reason: "static",
  status: 200,
  generationId: null,
  upstreamMs: 1,
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "switchkick-log-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createFileLog", () => {
  it("appends one JSON line per entry, creating directories as needed", async () => {
    const path = join(dir, "nested", "decisions.jsonl");
    const log = createFileLog({ path });
    log.write(ENTRY);
    log.write({ ...ENTRY, status: 429 });
    await log.flush();

    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines.map((l) => JSON.parse(l).status)).toEqual([200, 429]);
  });

  it.skipIf(process.platform === "win32")(
    "creates the file readable only by the user",
    async () => {
      const path = join(dir, "decisions.jsonl");
      const log = createFileLog({ path });
      log.write(ENTRY);
      await log.flush();
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    },
  );

  it("rotates to <path>.1 when the file would exceed maxBytes", async () => {
    const path = join(dir, "decisions.jsonl");
    const lineBytes = JSON.stringify(ENTRY).length + 1;
    const log = createFileLog({ path, maxBytes: lineBytes * 2 });
    for (const status of [1, 2, 3]) log.write({ ...ENTRY, status });
    await log.flush();

    const statuses = async (p: string) =>
      (await readFile(p, "utf8"))
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l).status);
    expect(await statuses(`${path}.1`)).toEqual([1, 2]);
    expect(await statuses(path)).toEqual([3]);
  });

  it("reports the first write failure once and never throws", async () => {
    const path = join(dir, "is-a-directory");
    await mkdir(path);
    const onError = vi.fn();
    const log = createFileLog({ path, onError });
    log.write(ENTRY);
    log.write(ENTRY);
    await log.flush();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("doesn't fail requests when the log can't be written", async () => {
    const path = join(dir, "is-a-directory");
    await mkdir(path);
    const onError = vi.fn();
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const proxy = await startProxy({
      apiKey: "sk-test",
      route: { tier: "balanced", model: "test/routed-model" },
      upstreamBaseUrl: upstream.baseUrl,
      log: createFileLog({ path, onError }),
    });
    try {
      const res = await send(`${proxy.url}/v1/chat/completions`, { body: "{}" });
      expect(res.status).toBe(200);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

describe("defaultLogPath", () => {
  it("uses XDG_STATE_HOME when set", () => {
    expect(defaultLogPath({ XDG_STATE_HOME: "/state" })).toBe(
      join("/state", "switchkick", "decisions.jsonl"),
    );
  });

  it("falls back to ~/.local/state", () => {
    expect(defaultLogPath({})).toMatch(/\.local[/\\]state[/\\]switchkick[/\\]decisions\.jsonl$/);
  });
});
