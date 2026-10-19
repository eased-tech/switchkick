import { describe, expect, it } from "vitest";
import { createApp, VERSION } from "../src/index.js";

describe("app", () => {
  it("answers /healthz", async () => {
    const res = await createApp().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: VERSION });
  });
});
