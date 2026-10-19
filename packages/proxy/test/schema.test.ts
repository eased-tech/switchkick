import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_SCHEMA_URL, configJsonSchema } from "../src/index.js";

// The committed schema is public API: editors load it from CONFIG_SCHEMA_URL. Regenerate it with
// `pnpm schema` after changing the config, and call the change out in the pull request.
const path = new URL("../../../schema/v1.json", import.meta.url);

describe("config JSON Schema", () => {
  const generated = `${JSON.stringify(configJsonSchema(), null, 2)}\n`;

  if (process.env.UPDATE_SCHEMA) writeFileSync(path, generated);

  it("matches the committed schema/v1.json", () => {
    expect(readFileSync(path, "utf8")).toBe(generated);
  });

  it("is published under the documented URL", () => {
    expect(configJsonSchema().$id).toBe(CONFIG_SCHEMA_URL);
  });
});
