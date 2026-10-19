import type { Effort } from "./config.js";
import type { ApiFormat } from "./formats.js";

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/**
 * Sets the tier's reasoning effort on a request body, in the field each API uses on OpenRouter.
 * The client's other reasoning settings (summaries, exclusion, task budgets) are kept, but any
 * effort or token budget it sent is replaced: OpenRouter rejects a request that carries both
 * an effort and `reasoning.max_tokens`, or two conflicting efforts.
 */
export function applyEffort(
  format: ApiFormat,
  body: Record<string, unknown>,
  effort: Effort,
): void {
  if (format === "messages") {
    // Anthropic's own field. `thinking` is left alone: Claude accepts it alongside an effort.
    body.output_config = { ...asObject(body.output_config), effort };
    return;
  }
  const { max_tokens: _maxTokens, ...reasoning } = asObject(body.reasoning);
  body.reasoning = { ...reasoning, effort };
  delete body.reasoning_effort;
}
