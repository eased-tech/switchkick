import { describe, expect, it } from "vitest";
import { analyzeTurn } from "../src/turns.js";

const toolUse = { type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } };
const toolResult = { type: "tool_result", tool_use_id: "t1", content: "file contents" };

describe("analyzeTurn: Anthropic Messages", () => {
  const base = {
    model: "claude-sonnet-4-5",
    max_tokens: 32000,
    system: [{ type: "text", text: "You are a coding agent." }],
    tools: [{ name: "Read" }],
  };

  it("reads a user text message as a human turn", () => {
    const info = analyzeTurn("messages", {
      ...base,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "text", text: "Shall I refactor it?" }] },
        { role: "user", content: [{ type: "text", text: "yes" }] },
      ],
    });
    expect(info).toEqual({
      turn: "human",
      text: "yes",
      previous: "Shall I refactor it?",
      system: "You are a coding agent.",
      firstUser: "first",
      humanMessages: 2,
      clientSession: null,
      cacheKey: null,
    });
  });

  it("reads a tool result as an inherited step, keeping the message that started the turn", () => {
    const info = analyzeTurn("messages", {
      ...base,
      messages: [
        { role: "user", content: "fix the bug" },
        { role: "assistant", content: [toolUse] },
        { role: "user", content: [toolResult, { type: "text", text: "<system-reminder>" }] },
      ],
    });
    expect(info).toMatchObject({ turn: "inherit", text: "fix the bug" });
  });

  it("reads a small request without tools as a side call", () => {
    const info = analyzeTurn("messages", {
      model: "claude-haiku-4-5",
      max_tokens: 512,
      messages: [{ role: "user", content: "Write a 5-word title for this chat" }],
    });
    expect(info.turn).toBe("side_call");
  });

  it("doesn't treat a small request with tools as a side call", () => {
    const info = analyzeTurn("messages", {
      ...base,
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(info.turn).toBe("human");
  });

  it("reads an assistant prefill as an inherited step", () => {
    const info = analyzeTurn("messages", {
      ...base,
      messages: [
        { role: "user", content: "list files" },
        { role: "assistant", content: "{" },
      ],
    });
    expect(info.turn).toBe("inherit");
  });

  it.each([
    ['{"device_id":"d","account_uuid":"a","session_id":"5f3c-sess"}', "5f3c-sess"],
    [
      "user_abc_account_def_session_0b1c2d3e-aaaa-bbbb-cccc-0123456789ab",
      "0b1c2d3e-aaaa-bbbb-cccc-0123456789ab",
    ],
    ["just-a-user", null],
  ])("reads the client's session id from metadata.user_id %j", (userId, session) => {
    const info = analyzeTurn("messages", {
      ...base,
      metadata: { user_id: userId },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(info.clientSession).toBe(session);
  });

  describe("as Claude Code 2.1 sends them", () => {
    const session = "0b3a0d74-97c4-4b63-b1b4-0e0fb2963496";
    const header = (name: string) => (name === "x-claude-code-session-id" ? session : undefined);
    const reminder = { role: "system", content: [{ type: "text", text: "<context>" }] };

    it("skips the trailing system message when reading a human turn", () => {
      const info = analyzeTurn(
        "messages",
        { ...base, messages: [{ role: "user", content: "list the files" }, reminder] },
        header,
      );
      expect(info).toMatchObject({
        turn: "human",
        text: "list the files",
        humanMessages: 1,
        system: "You are a coding agent.",
        clientSession: session,
      });
    });

    it("reads a tool result followed by a system message as an inherited step", () => {
      const info = analyzeTurn("messages", {
        ...base,
        messages: [
          { role: "user", content: "list the files" },
          reminder,
          { role: "assistant", content: [toolUse] },
          { role: "user", content: [toolResult] },
          reminder,
        ],
      });
      expect(info).toMatchObject({ turn: "inherit", text: "list the files" });
    });

    it("reads a request without tools in a Claude Code session as a side call, at any size", () => {
      const info = analyzeTurn(
        "messages",
        {
          model: "claude-opus-5-5",
          max_tokens: 128000,
          messages: [{ role: "user", content: "x" }],
        },
        header,
      );
      expect(info.turn).toBe("side_call");
    });

    it("still reads a large request without tools from another client as a human turn", () => {
      const info = analyzeTurn("messages", {
        max_tokens: 4096,
        messages: [{ role: "user", content: "write a poem" }],
      });
      expect(info.turn).toBe("human");
    });
  });

  it("copes with a body that has no messages", () => {
    expect(analyzeTurn("messages", {})).toMatchObject({ turn: "inherit", text: null });
  });
});

describe("analyzeTurn: Chat Completions", () => {
  it("reads a user message as a human turn", () => {
    const info = analyzeTurn("chat", {
      prompt_cache_key: "conv-1",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url" }] },
      ],
    });
    expect(info).toEqual({
      turn: "human",
      text: "hello",
      previous: null,
      system: "Be brief.",
      firstUser: "hello",
      humanMessages: 1,
      clientSession: null,
      cacheKey: "conv-1",
    });
  });

  it.each([
    ["a tool result", { role: "tool", tool_call_id: "c1", content: "42" }],
    ["an assistant tool call", { role: "assistant", tool_calls: [{ id: "c1" }] }],
  ])("reads %s as an inherited step", (_name, last) => {
    const info = analyzeTurn("chat", {
      messages: [{ role: "user", content: "compute it" }, last],
    });
    expect(info).toMatchObject({ turn: "inherit", text: "compute it" });
  });
});

describe("analyzeTurn: system messages mid-conversation", () => {
  it("leave Chat Completions turns and the system prompt alone", () => {
    const info = analyzeTurn("chat", {
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "and now?" },
        { role: "system", content: "reminder that changes every request" },
      ],
    });
    expect(info).toMatchObject({
      turn: "human",
      text: "and now?",
      previous: "hi",
      system: "Be brief.",
      humanMessages: 2,
    });
  });

  it("leave Responses turns and the instructions alone", () => {
    const info = analyzeTurn("responses", {
      instructions: "sys",
      input: [
        { role: "user", content: "go" },
        { role: "developer", content: "late note" },
      ],
    });
    expect(info).toMatchObject({ turn: "human", text: "go", system: "sys" });
  });
});

describe("analyzeTurn: Responses", () => {
  it("reads string input as a human turn", () => {
    expect(analyzeTurn("responses", { instructions: "sys", input: "hi" })).toEqual({
      turn: "human",
      text: "hi",
      previous: null,
      system: "sys",
      firstUser: "hi",
      humanMessages: 1,
      clientSession: null,
      cacheKey: null,
    });
  });

  it("reads a trailing user message as a human turn", () => {
    const info = analyzeTurn("responses", {
      prompt_cache_key: "codex-conv",
      input: [
        { type: "message", role: "developer", content: "rules" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "start" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done?" }] },
        { role: "user", content: "ship it" },
      ],
    });
    expect(info).toEqual({
      turn: "human",
      text: "ship it",
      previous: "Done?",
      system: "rules",
      firstUser: "start",
      humanMessages: 2,
      clientSession: null,
      cacheKey: "codex-conv",
    });
  });

  it("reads a function call output as an inherited step", () => {
    const info = analyzeTurn("responses", {
      input: [
        { type: "message", role: "user", content: "run the tests" },
        { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
    });
    expect(info).toMatchObject({ turn: "inherit", text: "run the tests", previous: null });
  });
});
