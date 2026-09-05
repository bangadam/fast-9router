# Fast 9Router

A focused rewrite of [9Router](https://github.com/decolua/9router): a local gateway for Codex OAuth, Anthropic, and OpenAI-compatible APIs. Fast 9Router translates OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages requests through one Bun process with SQLite persistence and a built-in Preact dashboard.

[![CI](https://github.com/bangadam/fast-9router/actions/workflows/ci.yml/badge.svg)](https://github.com/bangadam/fast-9router/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Why Fast 9Router

- One Bun process. No Docker, Redis, ORM, or external database.
- Three provider paths: Codex OAuth, official Anthropic, and OpenAI-compatible endpoints.
- Protocol translation across Chat Completions, Responses, and Messages.
- Streaming with backpressure, terminal-event validation, usage accounting, and client-abort handling.
- Multi-account priority, deterministic round-robin, cooldowns, and same-provider fallback.
- Model discovery, manual model configuration, aliases, visibility controls, and thinking-effort suffixes.
- Local dashboard for providers, gateway keys, routing state, and live usage analytics.
- Loopback-only administration, strict gateway authentication, bounded diagnostics, redirect checks, and credential masking.

## Requirements

- [Bun](https://bun.sh/) 1.3 or newer
- A provider credential or Codex OAuth account

## Quick start

```sh
git clone https://github.com/bangadam/fast-9router.git
cd fast-9router
bun install
bun run start
```

Open <http://127.0.0.1:20129/>.

The first run creates `~/.fast-9router/fast-9router.db`. Provider credentials are stored there and never belong in the repository.

## Configure a provider

Open **Providers** in the dashboard, then choose one of these paths:

| Provider | Authentication | Models |
| --- | --- | --- |
| OpenAI Codex | ChatGPT OAuth with PKCE | Built-in catalog, manual additions |
| Anthropic | Anthropic API key | Built-in catalog, manual additions, `/models` import when supported |
| OpenAI-compatible | Bearer API key | Manual additions or `{base_url}/models` import |

Codex OAuth uses a fixed callback on `localhost:1455`. The dashboard starts a short-lived loopback callback proxy for the sign-in flow.

> [!WARNING]
> Codex uses a subscription OAuth session that is not officially licensed for proxy or router use. The account may be restricted or banned. Use it at your own risk.

## Client endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/models` | Routable model catalog |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions input |
| `POST` | `/v1/responses` | OpenAI Responses input |
| `POST` | `/v1/messages` | Anthropic Messages input |

Example:

```sh
curl http://127.0.0.1:20129/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "provider-prefix/model-id",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

When gateway-key enforcement is enabled:

```sh
curl http://127.0.0.1:20129/v1/models \
  -H 'authorization: Bearer YOUR_GATEWAY_KEY'
```

## Routing

Canonical model IDs use `provider/model` form:

```text
cx/gpt-5.6-sol
anthropic/claude-sonnet-4-5
my-provider/my-model
```

A thinking suffix can set reasoning effort while preserving the upstream model ID:

```text
my-provider/my-model(high)
```

Connections with lower priority values run first. Connections sharing a priority use round-robin. Retryable failures can fall back only within the same provider. Ordinary client errors do not silently switch vendors.

## Usage analytics

The dashboard follows the 9Router usage flow:

- Today, 24-hour, 7-day, 30-day, and 60-day periods
- Request, input, cached, output, and estimated-cost summaries
- Live provider topology and recent requests over SSE
- Token and cost charts
- Grouping by model, account, API-key category, or endpoint
- Paginated request metadata with TTFT and total latency

Telemetry stores routing metadata and token counts. It does not store prompts, response bodies, tool arguments, request headers, or credentials. Recent request metadata is bounded to 5,000 rows.

Estimated cost uses the internal 9Router pricing resolver. It is an estimate, not provider billing data.

## Configuration

CLI arguments override environment variables. Environment variables override defaults.

| Environment variable | CLI option | Default | Description |
| --- | --- | --- | --- |
| `FAST9R_HOST` | `--host` | `127.0.0.1` | Listener address |
| `FAST9R_PORT` | `--port` | `20129` | Listener port |
| `FAST9R_DATA_DIR` | `--data-dir` | `~/.fast-9router` | SQLite and local state directory |
| `FAST9R_LOG_LEVEL` | `--log-level` | `info` | `debug`, `info`, `warn`, or `error` |
| `FAST9R_MAX_BODY_MB` | none | `128` | Generation request body limit in MiB |

Examples:

```sh
bun run start -- --port 8080
FAST9R_LOG_LEVEL=debug bun run start
```

## Security model

- Administrative APIs under `/api/admin` require a loopback TCP peer and same-origin browser requests.
- Public gateway authentication uses strict Bearer parsing and timing-safe comparison.
- Non-loopback listeners fail closed unless a valid gateway key is configured and enforcement is enabled.
- Provider secrets are masked in administrative responses and sanitized from upstream errors.
- Authenticated upstream redirects remain on the original origin.
- Codex image prefetch blocks private and reserved networks after DNS resolution and redirects.

Keep the default loopback binding unless remote access is required. Do not publish the data directory, database, logs, or environment files.

## Development

```sh
bun install
bun run typecheck
bun test
bun run build:dashboard
bun run bench
```

The dashboard source lives in `dashboard/`. Its production assets live in `public/` because the server serves them directly.

Project layout:

```text
src/adapters/       Provider transports
src/translate/      Request, response, and stream translation
src/router/         Model resolution, routing, fallback, cooldowns
src/oauth/          Codex OAuth and callback proxy
dashboard/src/      Preact dashboard
public/             Prebuilt dashboard assets
test/               Integration and contract tests
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Security issues follow [SECURITY.md](SECURITY.md).

## Attribution

Fast 9Router is derived from [9Router](https://github.com/decolua/9router). Translation logic, provider behavior, catalog data, pricing logic, and provider icons retain the original MIT attribution. Provider icon details are in [`public/providers/ATTRIBUTION.txt`](public/providers/ATTRIBUTION.txt).

## License

[MIT](LICENSE)
