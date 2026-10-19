import { describe, expect, it } from "vitest";
import { createScanner, routerDecision } from "../src/index.js";
import { MAX_SCAN_BYTES } from "../src/metadata.js";

const encode = (text: string) => new TextEncoder().encode(text);

function scan(contentType: string | null, text: string, pieceSize = text.length) {
  const scanner = createScanner(contentType);
  const bytes = encode(text);
  for (let i = 0; i < bytes.length; i += pieceSize) scanner.push(bytes.subarray(i, i + pieceSize));
  return scanner.finish();
}

const METADATA = {
  pipeline: [
    { name: "other", data: { resolved_models: ["wrong"] } },
    { type: "plugin", name: "jev-router", data: { resolved_models: ["vendor/a-20260101"] } },
  ],
};

describe("createScanner", () => {
  it("reads a JSON body", () => {
    const body = JSON.stringify({ model: "vendor/a", openrouter_metadata: METADATA });
    expect(scan("application/json; charset=utf-8", body, 3)).toEqual({
      servedModel: "vendor/a",
      metadata: METADATA,
    });
  });

  it("reads an event stream split one byte at a time, with CRLF line endings", () => {
    const stream = [
      ": OPENROUTER PROCESSING",
      "",
      "event: message_start",
      `data: ${JSON.stringify({ type: "message_start", message: { model: "vendor/é" } })}`,
      "",
      `data: ${JSON.stringify({ type: "message_stop", openrouter_metadata: METADATA })}`,
      "",
      "event: data",
      "data: [DONE]",
      "",
    ].join("\r\n");
    expect(scan("text/event-stream", stream, 1)).toEqual({
      servedModel: "vendor/é",
      metadata: METADATA,
    });
  });

  it("finds metadata nested under Responses' response.completed", () => {
    const stream = [
      `data: ${JSON.stringify({ type: "response.created", response: { model: "vendor/r" } })}`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { model: "vendor/r", openrouter_metadata: METADATA },
      })}`,
      "data: [DONE]",
    ].join("\n\n");
    expect(scan("text/event-stream", stream, 7)).toEqual({
      servedModel: "vendor/r",
      metadata: METADATA,
    });
  });

  it("handles a final event with no trailing blank line", () => {
    expect(scan("text/event-stream", 'data: {"model":"m"}')).toMatchObject({ servedModel: "m" });
  });

  it("ignores bodies of other types and malformed JSON", () => {
    expect(scan("text/plain", '{"model":"m"}')).toEqual({ servedModel: null, metadata: null });
    expect(scan("application/json", "{not json")).toEqual({ servedModel: null, metadata: null });
  });

  it("gives up on oversized bodies instead of buffering them", () => {
    const scanner = createScanner("application/json");
    scanner.push(encode('{"model":"m",'));
    scanner.push(new Uint8Array(MAX_SCAN_BYTES));
    expect(scanner.finish()).toEqual({ servedModel: null, metadata: null });
  });
});

describe("routerDecision", () => {
  it("keeps the documented fields and the policy version, in camelCase", () => {
    const decision = routerDecision({
      pipeline: [
        {
          name: "jev-router",
          data: {
            resolved_models: ["vendor/a", 3],
            candidates: [{ model: "vendor/a", effort: "low", tier: "basic", estimated_cost: 1e-5 }],
            reason: "initial",
            pipeline: "default",
            version: "policy-1",
            list_fallback: "models_ignored",
            answers: { task: { choice: "x" } },
            signal_vector: [1, 2],
          },
        },
      ],
    });
    expect(decision).toEqual({
      resolvedModels: ["vendor/a"],
      candidates: [{ model: "vendor/a", effort: "low", tier: "basic", estimatedCost: 1e-5 }],
      reason: "initial",
      pipeline: "default",
      version: "policy-1",
      listFallback: "models_ignored",
    });
  });

  it.each([
    ["no metadata", null],
    ["no pipeline", { requested: "x" }],
    ["no router stage", { pipeline: [{ name: "other", data: {} }] }],
    ["a stage without data", { pipeline: [{ name: "jev-router" }] }],
  ])("returns null for %s", (_name, metadata) => {
    expect(routerDecision(metadata)).toBeNull();
  });
});
