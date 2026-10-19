import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionState, SessionStore } from "@switchkick/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSessions, persistSessions } from "../src/sessions.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const STATE: SessionState = {
  tier: "frontier",
  provisional: false,
  trusted: false,
  lastSeenAt: 1_800_000_000_000,
  root: "0123456789abcdef",
};

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "switchkick-sessions-"));
  path = join(dir, "state", "sessions.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseSessions", () => {
  it("keeps valid entries and skips malformed ones", () => {
    const text = JSON.stringify({
      version: 1,
      sessions: [
        [KEY_A, STATE],
        ["not-a-hash", STATE],
        [KEY_B, { ...STATE, tier: "turbo" }],
        [KEY_B, { ...STATE, lastSeenAt: "yesterday" }],
        [KEY_B],
      ],
    });
    expect(parseSessions(text)).toEqual([[KEY_A, STATE]]);
  });

  it.each(["", "not json", "[]", '{"version":2,"sessions":[]}'])("reads %j as empty", (text) => {
    expect(parseSessions(text)).toEqual([]);
  });
});

describe("persistSessions", () => {
  it("saves sessions in a 0600 file and restores them in LRU order", async () => {
    const store = new SessionStore();
    const persisted = await persistSessions({ path, store });
    store.set(KEY_A, STATE);
    store.set(KEY_B, { ...STATE, tier: "fast", trusted: true });
    await persisted.close();

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const restored = new SessionStore(1);
    await (await persistSessions({ path, store: restored })).close();
    // A cap of 1 keeps the most recently used session.
    expect(restored.entries()).toEqual([[KEY_B, { ...STATE, tier: "fast", trusted: true }]]);
  });

  it("only writes when something changed", async () => {
    const store = new SessionStore();
    const persisted = await persistSessions({ path, store });
    await persisted.save();
    await expect(stat(path)).rejects.toThrow();
    store.set(KEY_A, STATE);
    await persisted.save();
    const first = await readFile(path, "utf8");
    await writeFile(path, "changed behind our back");
    await persisted.save();
    expect(await readFile(path, "utf8")).toBe("changed behind our back");
    expect(JSON.parse(first)).toEqual({ version: 1, sessions: [[KEY_A, STATE]] });
  });

  it("saves periodically", async () => {
    const store = new SessionStore();
    const persisted = await persistSessions({ path, store, intervalMs: 20 });
    store.set(KEY_A, STATE);
    await vi.waitFor(async () =>
      expect(parseSessions(await readFile(path, "utf8"))).toHaveLength(1),
    );
    await persisted.close();
  });

  it("starts empty from a missing or corrupt file, and reports write failures once", async () => {
    await writeFile(join(dir, "corrupt.json"), "{");
    const store = new SessionStore();
    const onError = vi.fn();
    const persisted = await persistSessions({ path: join(dir, "corrupt.json"), store, onError });
    expect(store.size).toBe(0);
    expect(onError).not.toHaveBeenCalled();
    await persisted.close();

    // A directory where the file should be makes every write fail.
    const blocked = await persistSessions({ path: dir, store, onError });
    store.set(KEY_A, STATE);
    await blocked.save();
    store.set(KEY_B, STATE);
    await blocked.close();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
