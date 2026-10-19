import { describe, expect, it } from "vitest";
import { createApp, VERSION } from "../src/index.js";

const app = () =>
  createApp({ apiKey: "sk-test", route: { tier: "balanced", model: "test/routed-model" } });

describe("app", () => {
  it("answers /healthz", async () => {
    const res = await app().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: VERSION });
  });

  it("returns 404 for unknown routes", async () => {
    const res = await app().request("/v1/models", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
