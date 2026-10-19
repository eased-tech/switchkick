import { Hono } from "hono";
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

export function createApp(): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true, version: VERSION }));
  return app;
}
