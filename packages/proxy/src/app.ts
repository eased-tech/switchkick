import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import pkg from "../package.json" with { type: "json" };
import { type AccessOptions, access, LOOPBACK_HOSTS, requireJson } from "./access.js";
import { type ApiFormat, errorBody, FORMATS, ROUTE_PATHS } from "./formats.js";
import { type ForwardOptions, forward } from "./forward.js";
import { JEV_ROUTER_MODEL, validatePlugin } from "./hosted.js";
import { NO_LOG } from "./log.js";
import { listModels, modelsFormat, retrieveModel } from "./models.js";
import { countTokens } from "./tokens.js";

export const VERSION: string = pkg.version;

export const DEFAULT_UPSTREAM_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_MAX_BODY_BYTES = 20 * 1024 * 1024;

export interface AppOptions
  extends Pick<ForwardOptions, "apiKey" | "route">,
    Partial<Omit<ForwardOptions, "apiKey" | "route">>,
    Partial<AccessOptions> {
  maxBodyBytes?: number;
}

/**
 * The switchkick HTTP app. Passing `hosted` selects hosted mode, with `route` as the fallback.
 * Throws if the hosted plugin entry is one OpenRouter would reject.
 */
export function createApp(options: AppOptions): Hono {
  const hosted = options.hosted
    ? { ...options.hosted, plugin: validatePlugin(options.hosted.plugin) }
    : null;
  const forwardOptions: ForwardOptions = {
    apiKey: options.apiKey,
    route: options.route,
    hosted,
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
  const limit = (format: ApiFormat) =>
    bodyLimit({
      maxSize,
      onError: (c) =>
        c.json(errorBody(format, "too_large", `The request body exceeds ${maxSize} bytes.`), 413),
    });
  // Every request goes to this one model, whatever the client asks for.
  const models = [hosted ? JEV_ROUTER_MODEL : options.route.model];

  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true, version: VERSION }));
  app.get("/v1/models", access(modelsFormat, accessOptions), listModels(models));
  app.get("/v1/models/:id{.+}", access(modelsFormat, accessOptions), retrieveModel(models));
  // Registered before /v1/messages so the more specific path wins.
  app.post(
    "/v1/messages/count_tokens",
    access("messages", accessOptions),
    requireJson("messages"),
    limit("messages"),
    countTokens,
  );
  for (const format of FORMATS) {
    app.post(
      ROUTE_PATHS[format],
      access(format, accessOptions),
      requireJson(format),
      limit(format),
      forward(format, forwardOptions),
    );
  }
  return app;
}
