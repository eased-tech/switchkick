import { describe, expect, it } from "vitest";
import { parseTierTag } from "../src/index.js";

describe("parseTierTag", () => {
  it.each([
    ["#frontier redesign the cache layer", { tier: "frontier", force: false }],
    ["rename this variable #fast", { tier: "fast", force: false }],
    ["#FAST fix the typo", { tier: "fast", force: false }],
    ["context first\n#balanced\nthen the ask", { tier: "balanced", force: false }],
    ["#fast! just this once", { tier: "fast", force: true }],
    ["#frontier plan it\n...then do it #fast", { tier: "fast", force: false }],
  ])("reads %j", (text, tag) => {
    expect(parseTierTag(text)).toEqual(tag);
  });

  it.each([
    "use the #fast path in the router",
    "color: #fastest",
    "#fasttrack this",
    "issue #frontier-123 is open",
    "a##fast b",
    "no tag at all",
  ])("ignores %j", (text) => {
    expect(parseTierTag(text)).toBeNull();
  });
});
