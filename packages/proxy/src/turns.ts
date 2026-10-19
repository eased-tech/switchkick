import type { TurnKind } from "@switchkick/core";
import type { ApiFormat } from "./formats.js";

/** What routing needs to know about a request's conversation. Holds prompt text: never log it. */
export interface TurnInfo {
  turn: TurnKind;
  /**
   * The latest human message: the last one if this is a human turn, otherwise the one that started
   * the current turn. Null if the conversation has none.
   */
  text: string | null;
  /** The assistant message just before {@link text}, if any. */
  previous: string | null;
  /**
   * The system prompt or instructions. In Chat Completions and Responses, only the system and
   * developer messages before the conversation starts count: clients insert others mid-conversation
   * and change them from request to request.
   */
  system: string;
  /** The conversation's first user message. */
  firstUser: string;
  /** The number of human messages in the conversation, this one included. */
  humanMessages: number;
  /**
   * A session id the client sent that names one conversation: Claude Code's, from its
   * `x-claude-code-session-id` header or `metadata.user_id`.
   */
  clientSession: string | null;
  /**
   * `prompt_cache_key`. Apps may set it per conversation, per user or to a constant, so it can
   * only tell sessions apart, never join them.
   */
  cacheKey: string | null;
}

/**
 * A Messages request without tools is something the client does on its own, such as generating a
 * title or suggesting a prompt, rather than a turn of the conversation, if it is this small or
 * comes from a Claude Code session (whose conversation requests always carry tools).
 */
export const SIDE_CALL_MAX_TOKENS = 512;

/** The header Claude Code sends its session id in. */
export const CLAUDE_CODE_SESSION_HEADER = "x-claude-code-session-id";

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The text parts of a content value: a string, or an array of parts with a `text` field. */
function textOf(content: unknown, types: readonly string[]): string {
  if (typeof content === "string") return content;
  return asArray(content)
    .filter((part) => isObject(part) && types.includes(part.type as string))
    .map((part) => asString((part as Json).text) ?? "")
    .join("\n");
}

const CHAT_TEXT = ["text"];
const MESSAGES_TEXT = ["text"];
const RESPONSES_TEXT = ["input_text", "output_text", "text"];

interface Entry {
  role: string;
  human: boolean;
  text: string;
}

/** Instructions rather than turns of the conversation. */
const isInstruction = (role: unknown) => role === "system" || role === "developer";

function summarize(
  entries: Entry[],
  system: string,
  ids: Pick<TurnInfo, "clientSession" | "cacheKey">,
  turn: TurnKind,
): TurnInfo {
  let index = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.human) {
      index = i;
      break;
    }
  }
  const before = index > 0 ? entries[index - 1] : undefined;
  return {
    turn,
    text: index >= 0 ? (entries[index]?.text ?? null) : null,
    previous: before?.role === "assistant" ? before.text : null,
    system,
    firstUser: entries.find((e) => e.role === "user")?.text ?? "",
    humanMessages: entries.filter((e) => e.human).length,
    ...ids,
  };
}

/** Claude Code puts its session id in `metadata.user_id`, as JSON or as `..._session_<uuid>`. */
function messagesSession(body: Json): string | null {
  const userId = isObject(body.metadata) ? asString(body.metadata.user_id) : null;
  if (!userId) return null;
  try {
    const parsed: unknown = JSON.parse(userId);
    if (isObject(parsed) && typeof parsed.session_id === "string" && parsed.session_id !== "") {
      return parsed.session_id;
    }
  } catch {
    // Not JSON.
  }
  return /_session_([0-9A-Za-z-]{8,})/.exec(userId)?.[1] ?? null;
}

function analyzeMessages(body: Json, header: (name: string) => string | undefined): TurnInfo {
  const system = textOf(body.system, MESSAGES_TEXT);
  // Claude Code adds `role: "system"` messages, often last, carrying reminders and context.
  const entries: Entry[] = asArray(body.messages)
    .filter((m): m is Json => isObject(m) && !isInstruction(m.role))
    .map((m) => {
      const role = asString(m.role) ?? "";
      const toolResult = asArray(m.content).some((b) => isObject(b) && b.type === "tool_result");
      return {
        role,
        human: role === "user" && !toolResult,
        text: textOf(m.content, MESSAGES_TEXT),
      };
    });
  const clientSession = header(CLAUDE_CODE_SESSION_HEADER)?.trim() || messagesSession(body);
  let turn: TurnKind = entries.at(-1)?.human ? "human" : "inherit";
  const small = typeof body.max_tokens === "number" && body.max_tokens <= SIDE_CALL_MAX_TOKENS;
  if (turn === "human" && asArray(body.tools).length === 0 && (small || clientSession)) {
    turn = "side_call";
  }
  return summarize(entries, system, { clientSession, cacheKey: null }, turn);
}

/** The text of the instruction messages before the conversation starts. */
function leadingInstructions(items: Json[], text: (item: Json) => string): string[] {
  const end = items.findIndex((item) => !isInstruction(item.role));
  return (end === -1 ? items : items.slice(0, end)).map(text);
}

function analyzeChat(body: Json): TurnInfo {
  const messages = asArray(body.messages).filter(isObject);
  const system = leadingInstructions(messages, (m) => textOf(m.content, CHAT_TEXT)).join("\n");
  const entries: Entry[] = messages
    .filter((m) => !isInstruction(m.role))
    .map((m) => {
      const role = asString(m.role) ?? "";
      return { role, human: role === "user", text: textOf(m.content, CHAT_TEXT) };
    });
  const turn = entries.at(-1)?.human ? "human" : "inherit";
  const ids = { clientSession: null, cacheKey: asString(body.prompt_cache_key) };
  return summarize(entries, system, ids, turn);
}

function analyzeResponses(body: Json): TurnInfo {
  const ids = { clientSession: null, cacheKey: asString(body.prompt_cache_key) };
  const instructions = asString(body.instructions) ?? "";
  if (typeof body.input === "string") {
    const entry = { role: "user", human: true, text: body.input };
    return summarize([entry], instructions, ids, "human");
  }
  const items = asArray(body.input).filter(isObject);
  const isMessage = (item: Json) =>
    (item.type === undefined || item.type === "message") && typeof item.role === "string";
  const system = [
    instructions,
    ...leadingInstructions(items, (i) => textOf(i.content, RESPONSES_TEXT)),
  ]
    .filter((s) => s !== "")
    .join("\n");
  // Tool calls and their outputs are entries too, so a tool output last means an inherited step.
  const entries: Entry[] = items
    .filter((item) => !isInstruction(item.role))
    .map((item) => {
      if (!isMessage(item)) return { role: asString(item.type) ?? "", human: false, text: "" };
      const role = item.role as string;
      return { role, human: role === "user", text: textOf(item.content, RESPONSES_TEXT) };
    });
  const turn = entries.at(-1)?.human ? "human" : "inherit";
  return summarize(entries, system, ids, turn);
}

/**
 * Works out whether a request starts a human turn or continues one, and pulls out the text routing
 * reads. A human turn ends in a user message; anything else (a tool result, an assistant prefill)
 * continues the turn before it. System and developer messages are skipped wherever they appear.
 *
 * - **Messages:** the last message is from the user and has no `tool_result` block. Requests
 *   without tools are side calls if they are small or come from a Claude Code session.
 * - **Chat Completions:** the last message has `role: "user"`.
 * - **Responses:** `input` is a string, or its last item is a user message.
 */
export function analyzeTurn(
  format: ApiFormat,
  body: Json,
  header: (name: string) => string | undefined = () => undefined,
): TurnInfo {
  switch (format) {
    case "messages":
      return analyzeMessages(body, header);
    case "chat":
      return analyzeChat(body);
    case "responses":
      return analyzeResponses(body);
  }
}
