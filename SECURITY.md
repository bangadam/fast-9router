# Security Policy

## Supported version

Security fixes target the latest code on the default branch.

## Report a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not open a public issue for credential exposure, authentication bypass, request forgery, unsafe redirects, OAuth problems, or data disclosure.

Include:

- Affected commit or version
- Impact and attack prerequisites
- Minimal reproduction steps
- Relevant endpoint or provider
- Suggested mitigation, if known

Remove all real API keys, OAuth tokens, account identifiers, prompts, and provider responses. Use synthetic values in reproductions.

## Operational guidance

- Keep the administrative dashboard on loopback.
- Configure gateway authentication before using a non-loopback listener.
- Protect `~/.fast-9router/` as credential-bearing local state.
- Never publish SQLite databases, WAL files, logs, environment files, or OAuth callback data.
- Review third-party OpenAI-compatible endpoints before sending traffic to them.

Codex uses a subscription OAuth session that is not officially licensed for proxy or router use. This is an account-policy risk separate from a software vulnerability.
