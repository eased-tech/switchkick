# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) for this repository.
Do not open a public issue.

Include what you found, how to reproduce it, and the impact you expect. We aim to acknowledge
reports within 3 business days.

## Scope

switchkick handles API keys and forwards prompts to OpenRouter. Issues of particular interest:

- API key exposure: in logs, error messages, the decision log, or files with loose permissions.
- Prompt text written anywhere switchkick persists data. The decision log must never contain prompts.
- The proxy being reachable from other hosts or origins without a token, including DNS rebinding.
- Routing guards that a crafted prompt can push to a *lower* tier. Guards may only raise the tier.

## Supported versions

Until 1.0, only the latest release receives fixes.
