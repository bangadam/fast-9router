// Account router: one indexed query of active provider connections, in-memory
// selection (priority groups + round-robin within the top group), and bounded
// fallback on retryable upstream failures.
//
// Cooldowns persist through `unavailableUntil` (db migration v3) and have a
// process-local overlay so concurrent request snapshots cannot retry them.

import type { Database } from "bun:sqlite";
import {
  listActiveConnections,
  recordConnectionError,
  clearConnectionError,
  type ProviderConnectionWithCooldown,
} from "../db.ts";
import { safeUpstreamMessage, sanitizeErrorText } from "../upstream-error.ts";

/** Bounded backoff when no valid Retry-After is present. */
const DEFAULT_COOLDOWN_MS = 30_000;
/** Upper bound for any cooldown, even a large Retry-After. */
const MAX_COOLDOWN_MS = 60 * 60_000;

/** Round-robin cursor per eligible top-priority account pool. */
const cursors = new Map<string, number>();
let runtimeCooldowns = new WeakMap<Database, Map<number, number>>();

function runtimeCooldownUntil(db: Database, connectionId: number): number | null {
  return runtimeCooldowns.get(db)?.get(connectionId) ?? null;
}

function safeConnectionError(connection: ProviderConnectionWithCooldown, message: string): string {
  const data = connection.data;
  const secrets = [data.apiKey, data.accessToken, data.refreshToken, data.idToken]
    .filter((value): value is string => typeof value === "string");
  return sanitizeErrorText(message, secrets);
}

function setCooldown(db: Database, connection: ProviderConnectionWithCooldown, until: number, reason: string): void {
  let cooldowns = runtimeCooldowns.get(db);
  if (!cooldowns) {
    cooldowns = new Map();
    runtimeCooldowns.set(db, cooldowns);
  }
  cooldowns.set(connection.id, until);
  recordConnectionError(db, connection.id, safeConnectionError(connection, reason), until);
}

export function cooldownConnection(
  db: Database,
  connection: ProviderConnectionWithCooldown,
  reason: string,
  cooldownMs = DEFAULT_COOLDOWN_MS,
): void {
  setCooldown(db, connection, Date.now() + cooldownMs, reason);
}

export function recoverConnectionHealth(
  db: Database,
  connection: ProviderConnectionWithCooldown,
): boolean {
  if (!clearConnectionError(db, connection.id, connection.healthVersion)) return false;
  runtimeCooldowns.get(db)?.delete(connection.id);
  return true;
}

/** Parse a Retry-After header (delta-seconds or HTTP-date). */
export function parseRetryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return null;
    return Math.min(seconds * 1000, MAX_COOLDOWN_MS);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(date - now, 0), MAX_COOLDOWN_MS);
}


function cursorKey(provider: string, priority: number, connections: ProviderConnectionWithCooldown[]): string {
  const ids = connections.map((connection) => connection.id).sort((left, right) => left - right).join(",");
  return `${provider}:${priority}:${ids}`;
}

function advanceCursor(provider: string, group: ProviderConnectionWithCooldown[]): void {
  if (group.length <= 1) return;
  const key = cursorKey(provider, group[0]!.priority, group);
  cursors.set(key, ((cursors.get(key) ?? 0) + 1) % group.length);
}
/**
 * Ordered candidate list for a provider: priority ascending, round-robin
 * rotation inside every equal-priority group. Unavailable connections are
 * skipped until their cooldown expires.
 */
export function orderConnections(
  connections: ProviderConnectionWithCooldown[],
  provider: string,
  now = Date.now(),
): ProviderConnectionWithCooldown[] {
  const usable = connections.filter(
    (connection) => connection.provider === provider
      && (connection.unavailableUntil === null || connection.unavailableUntil <= now),
  );
  usable.sort((left, right) => left.priority - right.priority || left.id - right.id);

  const ordered: ProviderConnectionWithCooldown[] = [];
  for (let start = 0; start < usable.length;) {
    const priority = usable[start]!.priority;
    let end = start + 1;
    while (end < usable.length && usable[end]!.priority === priority) end++;
    const length = end - start;
    if (length === 1) {
      ordered.push(usable[start]!);
    } else {
      const group = usable.slice(start, end);
      const key = cursorKey(provider, priority, group);
      const cursor = cursors.get(key) ?? 0;
      for (let offset = 0; offset < length; offset++) {
        ordered.push(usable[start + ((cursor + offset) % length)]!);
      }
    }
    start = end;
  }
  return ordered;
}

/** What one attempt against a connection produced. */
export type AttemptOutcome =
  | { kind: "ok" }
  | {
      /** Retryable failure: router cools the connection down and tries the next. */
      kind: "retryable";
      cooldownMs: number | null;
      reason: string;
    }
  | {
      /** Non-retryable failure: return this status/message to the client. */
      kind: "fatal";
      status: number;
      message: string;
      /** Upstream error payload safe to forward (already JSON). */
      errorBody?: unknown;
    };

export interface RouteOptions {
  signal?: AbortSignal;
  /**
   * Pre-fetched active connections. The pipeline queries once per request
   * and shares the list with model resolution — no N+1.
   */
  connections?: ProviderConnectionWithCooldown[];
}

/**
 * Classify an upstream failure for fallback decisions.
 *
 * Retryable: authentication failures, HTTP 408, 429, capacity/quota responses,
 * 5xx, timeouts, and network errors. Non-authentication 4xx are fatal.
 * A client-initiated abort is never retried — it propagates as a fatal 499.
 */
export function classifyFailure(
  status: number,
  bodyText: string,
  retryAfter: string | null,
  sensitiveValues: readonly string[] = [],
): AttemptOutcome {
  const retryAfterMs = parseRetryAfterMs(retryAfter);
  const capacity = /capacity|overloaded|insufficient_quota/i.test(bodyText.slice(0, 2048));
  if (status === 401 || status === 403 || status === 408 || status === 429 || capacity || status >= 500) {
    return {
      kind: "retryable",
      cooldownMs: retryAfterMs ?? DEFAULT_COOLDOWN_MS,
      reason: `upstream ${status}`,
    };
  }
  return {
    kind: "fatal",
    status,
    message: safeUpstreamMessage(status, bodyText, sensitiveValues),
  };
}


export type RouteResult =
  | { connection: ProviderConnectionWithCooldown; error?: undefined }
  | { connection?: undefined; error: { status: number; message: string; type: string; connectionId?: number; errorBody?: unknown; retryAfterSeconds?: number } };

/**
 * Try connections of `provider` in fallback order. `attempt` performs the
 * upstream call and reports an AttemptOutcome; on "ok" the caller's response
 * stands. All accounts exhausted -> 503; fatal -> upstream status passed
 * through with a sanitized message.
 */
export async function routeWithFallback(
  db: Database,
  provider: string,
  attempt: (connection: ProviderConnectionWithCooldown) => Promise<AttemptOutcome>,
  opts: RouteOptions = {},
): Promise<RouteResult> {
  const sourceConnections = opts.connections ?? listActiveConnections(db);
  const candidates = orderConnections(sourceConnections, provider);
  if (candidates.length === 0) {
    const now = Date.now();
    const cooling = sourceConnections
      .filter((connection) =>
        connection.provider === provider &&
        connection.unavailableUntil !== null &&
        connection.unavailableUntil > now)
      .sort((a, b) => a.unavailableUntil! - b.unavailableUntil!);
    const nextConnection = cooling[0];
    if (nextConnection?.unavailableUntil !== null && nextConnection?.unavailableUntil !== undefined) {
      const retryAfterSeconds = Math.max(1, Math.ceil((nextConnection.unavailableUntil - now) / 1000));
      return {
        error: {
          status: 503,
          message: `all ${provider} connections cooling down; retry in ${retryAfterSeconds}s`,
          type: "server_error",
          connectionId: nextConnection.id,
          retryAfterSeconds,
        },
      };
    }
  }
  let lastReason = "no active connection";
  let lastConnectionId: number | undefined;
  let nextCooldown: { connectionId: number; until: number } | undefined;
  let enteredPriority: number | undefined;
  const candidateGroups = new Map<number, ProviderConnectionWithCooldown[]>();
  for (const candidate of candidates) {
    const group = candidateGroups.get(candidate.priority);
    if (group) group.push(candidate);
    else candidateGroups.set(candidate.priority, [candidate]);
  }
  for (const connection of candidates) {
    const now = Date.now();
    const unavailableUntil = Math.max(
      connection.unavailableUntil ?? 0,
      runtimeCooldownUntil(db, connection.id) ?? 0,
    );
    if (unavailableUntil > now) {
      if (!nextCooldown || unavailableUntil < nextCooldown.until) {
        nextCooldown = { connectionId: connection.id, until: unavailableUntil };
      }
      continue;
    }
    if (enteredPriority !== connection.priority) {
      enteredPriority = connection.priority;
      advanceCursor(provider, candidateGroups.get(connection.priority)!);
    }
    lastConnectionId = connection.id;
    let outcome: AttemptOutcome;
    try {
      outcome = await attempt(connection);
    } catch (err) {
      if (opts.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        return { error: { status: 499, message: "request aborted by client", type: "aborted", connectionId: connection.id } };
      }
      // Network / timeout failure: retryable.
      outcome = { kind: "retryable", cooldownMs: null, reason: (err as Error).message };
    }
    if (outcome.kind === "ok") {
      recoverConnectionHealth(db, connection);
      return { connection };
    }
    if (outcome.kind === "fatal") {
      recordConnectionError(db, connection.id, safeConnectionError(connection, outcome.message));
      return { error: { status: outcome.status, message: outcome.message, type: upstreamErrorType(outcome.status), connectionId: connection.id, errorBody: outcome.errorBody } };
    }
    lastReason = outcome.reason;
    const cooldownMs = outcome.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const until = Date.now() + cooldownMs;
    cooldownConnection(db, connection, outcome.reason, cooldownMs);
    if (!nextCooldown || until < nextCooldown.until) {
      nextCooldown = { connectionId: connection.id, until };
    }
  }
  const retryAfterSeconds = nextCooldown
    ? Math.max(1, Math.ceil((nextCooldown.until - Date.now()) / 1000))
    : undefined;
  return {
    error: {
      status: 503,
      message: `no available ${provider} connection (${lastReason})`,
      type: "server_error",
      connectionId: lastConnectionId ?? nextCooldown?.connectionId,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    },
  };
}

function upstreamErrorType(status: number): string {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 402) return "payment_required";
  if (status === 400 || status === 404 || status === 422) return "invalid_request_error";
  if (status === 429) return "rate_limit_error";
  return "server_error";
}

/** Test hook: reset round-robin cursors. */
export function resetRouterState(): void {
  cursors.clear();
  runtimeCooldowns = new WeakMap();
}
