/** The three client APIs switchkick serves. OpenRouter accepts each one natively. */
export type ApiFormat = "chat" | "responses" | "messages";

export const FORMATS: readonly ApiFormat[] = ["chat", "responses", "messages"];

/** The path a client calls on switchkick. */
export const ROUTE_PATHS: Record<ApiFormat, string> = {
  chat: "/v1/chat/completions",
  responses: "/v1/responses",
  messages: "/v1/messages",
};

/** The path switchkick calls on OpenRouter, relative to the upstream base URL. */
export const UPSTREAM_PATHS: Record<ApiFormat, string> = {
  chat: "/chat/completions",
  responses: "/responses",
  messages: "/messages",
};

/** Kinds of error switchkick raises itself, before or instead of calling OpenRouter. */
export type ErrorKind =
  | "invalid_request"
  | "authentication"
  | "permission"
  | "not_found"
  | "too_large"
  | "unsupported_media_type"
  | "upstream_unreachable"
  | "upstream_timeout"
  | "router_rejected"
  | "router_no_model";

const ANTHROPIC_TYPES: Record<ErrorKind, string> = {
  invalid_request: "invalid_request_error",
  authentication: "authentication_error",
  permission: "permission_error",
  not_found: "not_found_error",
  too_large: "request_too_large",
  unsupported_media_type: "invalid_request_error",
  upstream_unreachable: "api_error",
  upstream_timeout: "timeout_error",
  router_rejected: "invalid_request_error",
  router_no_model: "not_found_error",
};

const OPENAI_TYPES: Record<ErrorKind, string> = {
  invalid_request: "invalid_request_error",
  authentication: "authentication_error",
  permission: "permission_error",
  not_found: "invalid_request_error",
  too_large: "invalid_request_error",
  unsupported_media_type: "invalid_request_error",
  upstream_unreachable: "server_error",
  upstream_timeout: "server_error",
  router_rejected: "invalid_request_error",
  router_no_model: "invalid_request_error",
};

/**
 * An error body in the envelope the client's SDK expects: Anthropic's shape for Messages,
 * OpenAI's for Chat Completions and Responses. SDKs read `error.message` from both.
 */
export function errorBody(
  format: ApiFormat,
  kind: ErrorKind,
  message: string,
  param: string | null = null,
): unknown {
  if (format === "messages") {
    return { type: "error", error: { type: ANTHROPIC_TYPES[kind], message } };
  }
  return { error: { message, type: OPENAI_TYPES[kind], param, code: kind } };
}
