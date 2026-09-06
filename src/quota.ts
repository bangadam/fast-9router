// Codex-only quota tracking: reads `GET /wham/usage` through the
// authenticated Codex transport, normalizes primary/secondary/review/Spark
// windows, caches snapshots for 60 seconds with in-flight coalescing, and
// never calls a model or mutates routing cooldown. Failures are sanitized
// against all token material.
//
// Parsing mirrors 9Router's usage handler
// (9router/open-sse/services/usage/codex.js), MIT License.

import type { Database } from "bun:sqlite";
import { fetchAuthenticated } from "./network.ts";
import { readResponseTextLimited, sanitizeErrorText } from "./upstream-error.ts";
import { ensureFreshCodexTokens } from "./oauth/codex.ts";
import { isJsonResponse } from "./adapters/types.ts";
import type { ProviderConnectionWithCooldown } from "./db.ts";

export const QUOTA_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuotaRow {
  id: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetAt: string | null;
}

export interface CodexQuotaSnapshot {
  connectionId: number;
  connectionName: string;
  active: boolean;
  plan: string | null;
  quotas: QuotaRow[];
  message: string | null;
  error: string | null;
  fetchedAt: number;
  stale: boolean;
  unavailableUntil: number | null;
}

// ---------------------------------------------------------------------------
// Normalization (legacy parity)
// ---------------------------------------------------------------------------

function toFiniteNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Normalize reset seconds / milliseconds / ISO strings to ISO or null. */
export function normalizeResetAt(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    const ms = value < 1e12 ? value * 1000 : value;
    const time = new Date(ms).getTime();
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  }
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  }
  return null;
}

interface RateLimitWindow {
  used_percent?: unknown;
  percent_used?: unknown;
  usedPercent?: unknown;
  reset_at?: unknown;
  resets_at?: unknown;
  resetAt?: unknown;
}

function formatCodexWindow(window: RateLimitWindow): QuotaRow | null {
  const usedRaw = window.used_percent ?? window.percent_used ?? window.usedPercent;
  if (usedRaw === undefined) return null;
  const used = Math.max(0, Math.min(100, toFiniteNumber(usedRaw)));
  return {
    id: "",
    label: "",
    usedPercent: used,
    remainingPercent: Math.max(0, 100 - used),
    resetAt: normalizeResetAt(window.reset_at ?? window.resets_at ?? window.resetAt ?? null),
  };
}

function getRateLimitBody(snapshot: unknown): Record<string, unknown> | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const record = snapshot as Record<string, unknown>;
  if (record.rate_limit && typeof record.rate_limit === "object" && !Array.isArray(record.rate_limit)) {
    return record.rate_limit as Record<string, unknown>;
  }
  return record;
}

function appendQuotaWindows(quotas: QuotaRow[], prefix: string, snapshot: unknown): boolean {
  const rateLimit = getRateLimitBody(snapshot);
  if (!rateLimit) return false;
  const primary = rateLimit.primary_window ?? rateLimit.primary
    ?? (isRecord(snapshot) ? (snapshot as Record<string, unknown>).primary_window ?? (snapshot as Record<string, unknown>).primary : undefined);
  const secondary = rateLimit.secondary_window ?? rateLimit.secondary
    ?? (isRecord(snapshot) ? (snapshot as Record<string, unknown>).secondary_window ?? (snapshot as Record<string, unknown>).secondary : undefined);
  let added = false;
  if (isRecord(primary)) {
    const row = formatCodexWindow(primary as RateLimitWindow);
    if (row) { quotas.push({ ...row, id: prefix ? `${prefix}_session` : "session", label: prefix ? `${prefix} session` : "Session" }); added = true; }
  }
  if (isRecord(secondary)) {
    const row = formatCodexWindow(secondary as RateLimitWindow);
    if (row) { quotas.push({ ...row, id: prefix ? `${prefix}_weekly` : "weekly", label: prefix ? `${prefix} weekly` : "Weekly" }); added = true; }
  }
  return added;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getReviewRateLimit(data: Record<string, unknown>): unknown {
  if (isRecord(data.code_review_rate_limit)) return data.code_review_rate_limit;
  if (isRecord(data.review_rate_limit)) return data.review_rate_limit;
  const byLimitId = data.rate_limits_by_limit_id;
  if (isRecord(byLimitId)) {
    const candidate = byLimitId.code_review ?? byLimitId.codex_review ?? byLimitId.review;
    if (candidate !== undefined) return candidate;
  }
  const additional = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [];
  return additional.find((entry) => {
    if (!isRecord(entry)) return false;
    const id = String(entry.limit_name ?? entry.metered_feature ?? entry.id ?? "").toLowerCase();
    return id === "code_review" || id === "codex_review" || id === "review" || id.includes("review");
  }) ?? null;
}

function getSparkRateLimit(data: Record<string, unknown>): unknown {
  if (isRecord(data.spark_rate_limit)) return data.spark_rate_limit;
  if (isRecord(data.gpt_5_3_codex_spark_rate_limit)) return data.gpt_5_3_codex_spark_rate_limit;
  const byLimitId = data.rate_limits_by_limit_id;
  if (isRecord(byLimitId)) {
    const candidate = byLimitId["gpt-5.3-codex-spark"] ?? byLimitId.gpt_5_3_codex_spark ?? byLimitId.spark;
    if (candidate !== undefined) return candidate;
  }
  const additional = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [];
  return additional.find((entry) => {
    if (!isRecord(entry)) return false;
    const id = String(entry.limit_name ?? entry.metered_feature ?? entry.id ?? "").toLowerCase();
    return id.includes("spark") || id.includes("5.3-codex-spark");
  }) ?? null;
}

/** Parse a WHAM usage payload into normalized quota rows + plan. */
export function parseCodexUsagePayload(payload: unknown): { plan: string | null; quotas: QuotaRow[] } {
  const data = isRecord(payload) ? payload : {};
  const normalRateLimit = data.rate_limit ?? data.rate_limits
    ?? (isRecord(data.rate_limits_by_limit_id) ? (data.rate_limits_by_limit_id as Record<string, unknown>).codex : undefined)
    ?? {};
  const reviewRateLimit = getReviewRateLimit(data);
  const sparkRateLimit = getSparkRateLimit(data);
  const quotas: QuotaRow[] = [];
  appendQuotaWindows(quotas, "", normalRateLimit);
  appendQuotaWindows(quotas, "review", reviewRateLimit);
  appendQuotaWindows(quotas, "spark", sparkRateLimit);
  const plan = typeof data.plan_type === "string"
    ? data.plan_type
    : isRecord(data.summary) && typeof data.summary.plan === "string"
      ? data.summary.plan
      : null;
  return { plan, quotas };
}

// ---------------------------------------------------------------------------
// Fetch + cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  snapshot: CodexQuotaSnapshot;
  fetchedAt: number;
  inflight?: Promise<CodexQuotaSnapshot>;
}

const cache = new Map<number, CacheEntry>();

/** Test hook. */
export function resetQuotaCache(): void {
  cache.clear();
}

function snapshotBase(connection: ProviderConnectionWithCooldown): CodexQuotaSnapshot {
  return {
    connectionId: connection.id,
    connectionName: connection.name,
    active: connection.isActive === 1,
    plan: connection.data.planType ?? null,
    quotas: [],
    message: null,
    error: null,
    fetchedAt: Date.now(),
    stale: false,
    unavailableUntil: connection.unavailableUntil,
  };
}

async function fetchQuotaSnapshot(db: Database, connection: ProviderConnectionWithCooldown): Promise<CodexQuotaSnapshot> {
  const base = snapshotBase(connection);
  let data;
  try {
    data = await ensureFreshCodexTokens(db, connection);
  } catch (error) {
    const secrets = [connection.data.accessToken, connection.data.refreshToken, connection.data.idToken].filter((v): v is string => typeof v === "string");
    base.error = sanitizeErrorText(`token refresh failed: ${(error as Error).message}`, secrets);
    return base;
  }
  const secrets = [data.accessToken, data.refreshToken, data.idToken].filter((v): v is string => typeof v === "string");
  try {
    const response = await fetchAuthenticated(QUOTA_USAGE_URL, {
      headers: {
        authorization: `Bearer ${data.accessToken}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      base.error = sanitizeErrorText(`usage API returned status ${response.status}`, secrets);
      return base;
    }
    if (!isJsonResponse(response)) {
      await response.body?.cancel().catch(() => {});
      base.error = "usage API returned a non-JSON response";
      return base;
    }
    const text = await readResponseTextLimited(response, MAX_BODY_BYTES);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      base.error = "usage API returned invalid or oversized JSON";
      return base;
    }
    const { plan, quotas } = parseCodexUsagePayload(payload);
    if (quotas.length === 0) {
      base.error = "usage API response contained no quota windows";
      base.message = "Codex connected. Usage API temporarily unavailable.";
      return base;
    }
    base.plan = plan ?? base.plan;
    base.quotas = quotas;
    return base;
  } catch (error) {
    base.error = sanitizeErrorText(`quota fetch failed: ${(error as Error).message}`, secrets);
    return base;
  }
}

/**
 * Snapshot for one connection. Fresh cache wins; `force` bypasses a completed
 * cache but joins an in-flight fetch. On transient failure the last successful
 * snapshot is retained as `stale: true` plus a safe error.
 */
export async function quotaSnapshotForConnection(
  db: Database,
  connection: ProviderConnectionWithCooldown,
  force = false,
): Promise<CodexQuotaSnapshot> {
  const cached = cache.get(connection.id);
  const now = Date.now();
  if (cached?.inflight) return cached.inflight;
  if (!force && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.snapshot;
  }
  const inflight = fetchQuotaSnapshot(db, connection).then((snapshot) => {
    const previous = cache.get(connection.id);
    const isError = snapshot.error !== null;
    const entry: CacheEntry = isError && previous && previous.fetchedAt > 0 && previous.snapshot.error === null
      ? { snapshot: { ...previous.snapshot, stale: true, error: snapshot.error }, fetchedAt: now }
      : isError
        ? { snapshot, fetchedAt: now }
        : { snapshot, fetchedAt: Date.now() };
    cache.set(connection.id, entry);
    return entry.snapshot;
  });
  cache.set(connection.id, { snapshot: cached?.snapshot ?? snapshotBase(connection), fetchedAt: cached?.fetchedAt ?? 0, inflight });
  return inflight;
}

// ---------------------------------------------------------------------------
// Overview (admin list endpoint)
// ---------------------------------------------------------------------------

export interface QuotaOverviewQuery {
  page: number;
  pageSize: number;
  accountStatus: "all" | "active" | "inactive";
  force: boolean;
}

const MAX_CONCURRENT_FETCHES = 4;

export async function quotaOverview(
  db: Database,
  query: QuotaOverviewQuery,
): Promise<{
  accounts: CodexQuotaSnapshot[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  generatedAt: number;
}> {
  const { listConnections } = await import("./db.ts");
  const codex = listConnections(db)
    .filter((connection) => connection.provider === "codex")
    .sort((a, b) => b.priority - a.priority || a.id - b.id);
  const filtered = query.accountStatus === "all"
    ? codex
    : codex.filter((connection) => (query.accountStatus === "active" ? connection.isActive === 1 : connection.isActive !== 1));
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(query.page, totalPages);
  const start = (page - 1) * query.pageSize;
  const pageConnections = filtered.slice(start, start + query.pageSize);

  // At most four upstream calls concurrently; quota reads never mutate cooldown.
  const accounts: CodexQuotaSnapshot[] = [];
  for (let i = 0; i < pageConnections.length; i += MAX_CONCURRENT_FETCHES) {
    const batch = pageConnections.slice(i, i + MAX_CONCURRENT_FETCHES);
    const results = await Promise.all(
      batch.map((connection) => quotaSnapshotForConnection(db, connection, query.force)),
    );
    accounts.push(...results);
  }
  return {
    accounts,
    pagination: { page, pageSize: query.pageSize, total, totalPages },
    generatedAt: Date.now(),
  };
}
