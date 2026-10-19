import { describe, expect, it } from "vitest";
import { entropy, findSecret } from "../src/index.js";

// Built at runtime so the repository itself never contains strings that look like live keys.
const random = (length: number, alphabet = "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY") =>
  Array.from({ length }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join("");

describe("findSecret", () => {
  it.each([
    ["private_key", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n"],
    ["private_key", "-----BEGIN RSA PRIVATE KEY-----"],
    ["aws_access_key", `export AWS_ACCESS_KEY_ID=${"AKIA"}${"Q".repeat(8)}${"7".repeat(8)}`],
    ["github_token", `token ${"ghp_"}${random(36)}`],
    ["anthropic_key", `${"sk-ant-"}api03-${random(40)}`],
    ["openrouter_key", `${"sk-or-v1-"}${"0123456789abcdef".repeat(4)}`],
    ["openai_key", `OPENAI_API_KEY=${"sk-proj-"}${random(40)}`],
    ["stripe_key", `${"sk_"}live_${random(24)}`],
    ["slack_token", `${"xoxb-"}1234567890-abcdefghij`],
    ["google_api_key", `${"AIza"}${random(35)}`],
    ["jwt", `Bearer ${"eyJ"}hbGciOiJIUzI1NiJ9.${"eyJ"}zdWIiOiIxMjM0In0.${random(20)}`],
    ["assigned_secret", `const apiKey = "${random(24)}";`],
    ["assigned_secret", `"client_secret": "${random(30)}"`],
    ["assigned_secret", `DB_PASSWORD=${random(18)}`],
    ["url_password", `DATABASE_URL=postgres://app:${"Xk29"}fLq0pZ@db.internal:5432/app`],
  ])("finds %s", (kind, text) => {
    expect(findSecret(`Please check this: ${text} and tell me why it fails.`)).toBe(kind);
  });

  it.each([
    ["a git SHA", "Revert commit 3f9a2c4e8b1d7f6a5c0e9b8d7a6f5e4c3b2a1d0e please"],
    ["a UUID", "session 123e4567-e89b-12d3-a456-426614174000 crashed"],
    ["base64 test data", 'expect(decode("SGVsbG8sIFdvcmxkIQ==")).toBe("Hello, World!")'],
    ["an env var reference", "const apiKey = process.env.OPENROUTER_API_KEY;"],
    ["a variable name", "token = parseAuthorizationHeader(request)"],
    ["a placeholder URL", "postgres://user:password@localhost:5432/db"],
    ["a templated URL", `postgres://app:${"$"}{DB_PASSWORD}@db:5432/app`],
    ["a placeholder key", 'OPENAI_API_KEY="sk-..."'],
    ["prose about tokens", "The tokenizer splits the password reset flow into secret steps."],
    ["a long hex digest", `sha256: ${"9f86d081884c7d659a2feaa0c55ad015".repeat(2)}`],
  ])("ignores %s", (_name, text) => {
    expect(findSecret(text)).toBeNull();
  });

  it("measures entropy in bits per character", () => {
    expect(entropy("aaaa")).toBe(0);
    expect(entropy("abcd")).toBe(2);
  });
});
