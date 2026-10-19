/**
 * Detection of credentials in a human message. A hit routes the session to the trusted model and
 * keeps the message away from Jev. Only the kind of secret is reported, never its value.
 */

const KEY_FORMATS: readonly [kind: string, pattern: RegExp][] = [
  ["private_key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ["gitlab_token", /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{32,}/],
  ["openrouter_key", /\bsk-or-v1-[a-f0-9]{48,}\b/],
  ["openai_key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/],
  ["stripe_key", /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/],
  ["slack_token", /\bxox[abposr]-[0-9A-Za-z-]{10,}/],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["npm_token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
];

// Quantifiers below are bounded so a long run of matching characters can't make the scan
// quadratic.

/** `name = value` or `"name": "value"` where the name says the value is a secret. */
const ASSIGNMENT =
  /(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|credential|auth)[A-Za-z0-9_-]{0,40}["']?[ \t]{0,8}[:=][ \t]{0,8}["']?([A-Za-z0-9_\-+/=]{16,512})(?![A-Za-z0-9_\-+/=.$({[])/gi;

/** `scheme://user:password@host`, as in database URLs. */
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:/@]{1,256}:([^\s:/@]{6,256})@[^\s/]/gi;

const PLACEHOLDER =
  /^(?:x+|\*+|\.+|password|passwd|secret|changeme|example|test|dummy|placeholder)$/i;

/** Shannon entropy in bits per character. */
export function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Whether a value looks random enough to be a real credential rather than a word or a name. */
function looksRandom(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, "").length;
  const letters = value.replace(/[^A-Za-z]/g, "").length;
  return digits >= 2 && letters >= 2 && entropy(value) >= 3.5;
}

/**
 * The kind of the first credential found in `text`, e.g. `github_token`, or null. Matches known
 * key formats, plus high-entropy values assigned to secret-sounding names.
 */
export function findSecret(text: string): string | null {
  for (const [kind, pattern] of KEY_FORMATS) {
    if (pattern.test(text)) return kind;
  }
  for (const match of text.matchAll(ASSIGNMENT)) {
    if (match[1] && looksRandom(match[1])) return "assigned_secret";
  }
  for (const match of text.matchAll(URL_PASSWORD)) {
    const password = match[1] ?? "";
    if (!PLACEHOLDER.test(password) && !/[<>{}$%]/.test(password)) return "url_password";
  }
  return null;
}
