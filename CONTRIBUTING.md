# Contributing

Contributions should preserve Fast 9Router's narrow scope: Codex OAuth, official Anthropic, and OpenAI-compatible providers running in one Bun process.

Participation follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Before opening a change

Use an issue for behavior changes, new provider scope, persistence changes, or protocol changes. Small bug fixes and documentation corrections can go directly to a pull request.

Do not include provider credentials, gateway keys, OAuth tokens, databases, logs, captured prompts, or upstream responses in issues, tests, commits, or screenshots.

## Local setup

```sh
git clone https://github.com/bangadam/fast-9router.git
cd fast-9router
bun install
bun run typecheck
bun test
```

Rebuild dashboard assets after changing `dashboard/`:

```sh
bun run build:dashboard
```

Commit the matching `public/` output with the dashboard source change.

## Change guidelines

- Keep strict TypeScript enabled.
- Prefer existing modules and platform APIs over new dependencies.
- Preserve streaming backpressure and cancellation.
- Keep fallback within one provider. Do not introduce implicit cross-provider routing.
- Keep model listing and routing eligibility consistent.
- Keep database migrations ordered, transactional, and forward-only.
- Avoid per-candidate or per-row database queries in routing and analytics paths.
- Treat request bodies, tool arguments, provider responses, and credentials as sensitive.
- Test observable behavior, boundaries, failure classification, and concurrency.

## Pull requests

A pull request should include:

1. The problem and the behavior change.
2. The affected endpoint, provider, or dashboard flow.
3. Tests that fail without the fix and pass with it.
4. Any migration, security, compatibility, or performance risk.
5. Dashboard screenshots when visual behavior changes. Remove personal data first.

Run before submission:

```sh
bun run typecheck
bun test
```

For dashboard changes, also run:

```sh
bun run build:dashboard
```

## Licensing

By contributing, you agree that your contribution is licensed under the repository's MIT License. Preserve attribution on code substantially derived from 9Router or another source.
