import type { Context, Handler } from "hono";
import { type ApiFormat, errorBody } from "./formats.js";

/** Anthropic SDKs always send `anthropic-version`; OpenAI SDKs never do. */
export function modelsFormat(c: Context): ApiFormat {
  return c.req.header("anthropic-version") ? "messages" : "chat";
}

function openAiModel(id: string) {
  return { id, object: "model", created: 0, owned_by: id.split("/")[0] ?? id };
}

function anthropicModel(id: string) {
  return { type: "model", id, display_name: id, created_at: "1970-01-01T00:00:00Z" };
}

/**
 * `GET /v1/models`: the models switchkick routes to, in the shape the client's SDK expects. That
 * is a single model, since any model a client picks is rewritten to it: the tier's model in static
 * mode, or the Jev router in hosted mode.
 */
export function listModels(models: readonly string[]): Handler {
  return (c) => {
    if (modelsFormat(c) === "messages") {
      return c.json({
        data: models.map(anthropicModel),
        has_more: false,
        first_id: models[0] ?? null,
        last_id: models.at(-1) ?? null,
      });
    }
    return c.json({ object: "list", data: models.map(openAiModel) });
  };
}

/** `GET /v1/models/{id}`, where the id contains a slash, e.g. `anthropic/claude-sonnet-5.5`. */
export function retrieveModel(models: readonly string[]): Handler {
  return (c) => {
    const format = modelsFormat(c);
    const id = decodeURIComponent(c.req.path.slice("/v1/models/".length));
    if (!models.includes(id)) {
      return c.json(errorBody(format, "not_found", `Model "${id}" is not served here.`), 404);
    }
    return c.json(format === "messages" ? anthropicModel(id) : openAiModel(id));
  };
}
