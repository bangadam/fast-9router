#!/usr/bin/env bash
# Benchmark: fast-9router (Bun+Hono) vs 9router (Next.js custom server).
# Usage: ./bench.sh <fast9_url> <fast9_pid> <niner_url> <niner_pid>
set -u
FAST_URL="${1:?}"; FAST_PID="${2:?}"; NINE_URL="${3:?}"; NINE_PID="${4:?}"
N="${BENCH_N:-2000}"; C="${BENCH_C:-50}"

rss_mb() { ps -o rss= -p "$1" 2>/dev/null | awk '{printf "%.1f", $1/1024}'; }

run_ab() { # label url
  local label="$1" url="$2"
  echo "== $label =="
  ab -q -s 30 -n "$N" -c "$C" "$url" 2>/dev/null | awk '
    /Requests per second/ {rps=$4}
    /Time per request/ && !seen {tpr=$4; seen=1}
    /Time per request/ && seen && !seen2 {tpr_c=$4; seen2=1}
    /Failed requests/ {fail=$3}
    /Transfer rate/ {kbps=$3}
    END {printf "rps=%s tpr_mean=%s tpr_conc=%s failed=%s kbps=%s\n", rps, tpr, tpr_c, fail, kbps}'
}

echo "---- RSS before ----"
echo "fast9_rss_before=$(rss_mb $FAST_PID)MB  9router_rss_before=$(rss_mb $NINE_PID)MB"

run_ab "fast-9router GET /v1/models" "$FAST_URL/v1/models"
run_ab "9router GET /v1/models" "$NINE_URL/v1/models"

echo "---- RSS after ----"
echo "fast9_rss_after=$(rss_mb $FAST_PID)MB  9router_rss_after=$(rss_mb $NINE_PID)MB"

# percentiles via ab full output (95%)
pct() { ab -q -s 30 -n "$N" -c "$C" "$1" 2>/dev/null | grep -E "^\s+(50|90|95|99)%"; }
echo "== fast-9router percentiles =="
pct "$FAST_URL/v1/models"
echo "== 9router percentiles =="
pct "$NINE_URL/v1/models"
