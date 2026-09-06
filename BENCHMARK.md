# fast-9router vs 9router — Benchmark Report

Date: 2026-09-06 · Machine: Apple M1 Pro (arm64), macOS, loopback · Load tool: `ab` (ApacheBench) + custom Python LLM harness (`scripts/bench/`)

## Setup

| | fast-9router | 9router |
|---|---|---|
| Runtime | Bun 1.3.14 + Hono | Node 22 + Next.js 16 standalone (custom-server.js) |
| Mode | production (`bun run src/server.ts`) | `next build` + standalone, `NODE_ENV=production` |

## 1. Gateway overhead (static, no upstream)

| Metric | fast-9router | 9router | Δ |
|---|---|---|---|
| Cold start → first 200 OK (median ×3) | **69 ms** | 426 ms | 6.2× |
| RPS `GET /v1/models` (n=2000, c=50) | **15,166** | 627 | 24× |
| RPS `OPTIONS /v1/models` (minimal handler) | **14,088** | 1,098 | 12.8× |
| RPS 404 path (pure routing overhead) | **19,008** | 1,269 | 15× |
| Latency p50 / p95 / p99 (`/v1/models`) | **2 / 5 / 11 ms** | 62 / 108 / 141 ms | ~28× (p50) |
| Idle RSS | **31 MB** | 56 MB | 1.8× |
| RSS after sustained load | **54 MB** | 167 MB | 3× |
| Production dependencies | **5** | 33 | 6.6× |
| Install size | **177 MB** | 668 MB + 79 MB standalone | 3.8× |
| Failed requests | 0 | 0 | — |

## 2. LLM gateway (identical upstream: surplus `glm-5.3`)

9router's `dewa-glm` combo resolves to `surplus/glm-5.3` on the same upstream host, so both gateways proxied the exact same API and key. Upstream latency dominates (2–35 s, varies with cache/quota); differences below are gateway-side.

| Metric | fast-9router | 9router | Winner |
|---|---|---|---|
| Non-stream median latency (n=3) | 2,315 ms | 1,815 ms | ~tie (within upstream variance) |
| Stream TTFT (first SSE token) | **2,584–2,655 ms** | 4,585–7,469 ms | **fast-9router ~2× faster** |
| Stream end-to-end | **3,091–3,511 ms** | 4,672–7,580 ms | fast-9router |
| 4 parallel requests (per-req) | **2,507–3,475 ms** | 4,723–5,330 ms | **fast-9router ~40% faster** |
| 5 sequential streams (wall) | 15,575 ms | 16,218 ms | tie |
| SSE granularity | 25–28 events (per-token) | 12 events (batched) | fast-9router (smoother UX) |
| Tool call (`get_weather`, valid JSON args) | ✅ 5,226 ms | ✅ 5,415 ms | tie — both correct |
| Usage accounting (`completion_tokens`) | 3/3 | 3/3 | tie |
| Non-stream content-type | ✅ `application/json` | ⚠️ `text/event-stream` + trailing `data: [DONE]` glued to the JSON body | fast-9router (9router violates the OpenAI contract; strict clients fail to parse) |
| RSS under LLM traffic | **43 MB** | 83 MB | fast-9router |
| Stability under burst (4 parallel + streams) | 0 errors, 0 crashes | 0 errors | tie |

## Conclusions

- **fast-9router wins as an LLM gateway**: 2× faster TTFT, 40% faster under concurrency, per-token streaming, OpenAI-compliant non-stream responses, half the memory.
- 9router's non-stream path is protocol-dirty (SSE content-type + `[DONE]` sentinel appended to JSON) — breaks strict OpenAI SDK clients.
- 9router's edge is surrounding features (multi-provider combos with silent fallback, full dashboard), not gateway performance. Note: `dewa-glm` silently fell back to a different upstream (`cb/glm-5.3` via codebuddy) when surplus hit 429 — fallback works, but makes the serving upstream unpredictable.
- Upstream is the true bottleneck for total latency; gateway choice matters for time-to-first-token and concurrent fan-out.

## Reproduce

```sh
# Static: start both servers, then
scripts/bench/bench.sh <fast9_url> <fast9_pid> <niner_url> <niner_pid>

# LLM: register the same upstream provider in both, set ROUTER9_API_KEY, then
python3 scripts/bench/llm-bench2.py all
```
