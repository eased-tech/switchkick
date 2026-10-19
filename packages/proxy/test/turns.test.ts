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
