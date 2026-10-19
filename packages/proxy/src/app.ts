import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import pkg from "../package.json" with { type: "json" };
import { type AccessOptions, access, LOOPBACK_HOSTS } from "./access.js";
import { errorBody, FORMATS, ROUTE_PATHS } from "./formats.js";
import { type ForwardOptions, forward } from "./forward.js";
import { NO_LOG } from "./log.js";

export const VERSION: string = pkg.version;

export const DEFAULT_UPSTREAM_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_MAX_BODY_BYTES = 20 * 1024 * 1024;

export interface AppOptions
  extends Pick<ForwardOptions, "apiKey" | "route">,
    Partial<Omit<ForwardOptions, "apiKey" | "route">>,
    Partial<AccessOptions> {
  maxBodyBytes?: number;
}

export function createApp(options: AppOptions): Hono {
  const forwardOptions: ForwardOptions = {
    apiKey: options.apiKey,
    route: options.route,
    upstreamBaseUrl: options.upstreamBaseUrl ?? DEFAULT_UPSTREAM_BASE_URL,
    fetch: options.fetch ?? fetch,
    log: options.log ?? NO_LOG,
    attribution: options.attribution ?? true,
  };
  const accessOptions: AccessOptions = {
    token: options.token ?? null,
    allowedHosts: options.allowedHosts ?? LOOPBACK_HOSTS,
  };
  const maxSize = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true, version: VERSION }));
  for (const format of FORMATS) {
    app.post(
      ROUTE_PATHS[format],
      access(format, accessOptions),
      bodyLimit({
        maxSize,
        onError: (c) =>
          c.json(errorBody(format, "too_large", `The request body exceeds ${maxSize} bytes.`), 413),
      }),
      forward(format, forwardOptions),
    );
  }
  return app;
}
