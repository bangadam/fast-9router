// SQLite database layer: open with narrow permissions, sequential
// transactional migrations, and small repository functions.
//
// Schema (minimum per PRD): singleton settings, provider connections, model
// aliases, migration metadata, daily usage aggregates. No request-detail
// table.

import { Database } from "bun:sqlite";
export type { Database } from "bun:sqlite";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ConnectionData {
  baseUrl?: string;
  apiKey?: string;
  prefix?: string;
  models?: string[];
  /** Codex OAuth material (never returned by read interfaces in full). */
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
  accountId?: string;
  email?: string;
  planType?: string;
  autoPing?: boolean;
}
export interface ProviderConnection {
  id: number;
  provider: string;
  name: string;
  isActive: number;
  priority: number;
  data: ConnectionData;
  createdAt: string;
  updatedAt: string;
}

export interface ModelAlias {
  id: number;
  name: string;
  target: string;
  createdAt: string;
}

export interface UsageRow {
  dateKey: string;
  provider: string;
  model: string;
  connectionId: number;
  requests: number;
  promptTokens: number | null;
  cachedTokens: number | null;
  completionTokens: number | null;
  failedRequests: number;
}

export interface RequestUsageRecord {
  id: number;
  createdAt: number;
  endpoint: string | null;
  provider: string;
  model: string;
  connectionId: number;
  status: number;
  latencyMs: number | null;
  ttftMs: number | null;
  promptTokens: number | null;
  cachedTokens: number | null;
  completionTokens: number | null;
  keyName: string;
}

export interface ProviderConnectionWithCooldown extends ProviderConnection {
  unavailableUntil: number | null;
  lastError: string | null;
  healthVersion: number;
}

/** Opens (creating if needed) the database at `path` with 0700 dir / 0600 file. */
export function openDatabase(path: string): Database {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  const db = new Database(path);
  chmodSync(path, 0o600);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial-schema",
    sql: `
      CREATE TABLE settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        gatewayKey TEXT NOT NULL DEFAULT '',
        gatewayEnforce INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO settings (id, gatewayKey, gatewayEnforce) VALUES (1, '', 0);

      CREATE TABLE providerConnections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        isActive INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX idx_connections_active
        ON providerConnections (isActive, priority);

      CREATE TABLE modelAliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        target TEXT NOT NULL,
        createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE TABLE dailyUsageAggregates (
        dateKey TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        connectionId INTEGER NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0,
        promptTokens INTEGER,
        completionTokens INTEGER,
        PRIMARY KEY (dateKey, provider, model, connectionId)
      );
    `,
  },
  {
    version: 2,
    name: "usage-totals",
    sql: `
      ALTER TABLE dailyUsageAggregates ADD COLUMN totalTokens INTEGER;
    `,
  },
  {
    version: 3,
    name: "connection-unavailable-until",
    sql: `
      ALTER TABLE providerConnections ADD COLUMN unavailableUntil INTEGER;
    `,
  },
  {
    version: 4,
    name: "usage-failed-requests",
    sql: `
      ALTER TABLE dailyUsageAggregates
        ADD COLUMN failedRequests INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 5,
    name: "connection-last-error",
    sql: `
      ALTER TABLE providerConnections ADD COLUMN lastError TEXT;
      ALTER TABLE providerConnections ADD COLUMN healthVersion INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 6,
    name: "disabled-models",
    sql: `
      ALTER TABLE settings ADD COLUMN disabledModels TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 7,
    name: "usage-analytics",
    sql: `
      ALTER TABLE dailyUsageAggregates ADD COLUMN cachedTokens INTEGER;
      ALTER TABLE settings ADD COLUMN modelPricing TEXT NOT NULL DEFAULT '{}';
      CREATE TABLE hourlyUsageAggregates (
        hourKey TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        connectionId INTEGER NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0,
        failedRequests INTEGER NOT NULL DEFAULT 0,
        promptTokens INTEGER,
        cachedTokens INTEGER,
        completionTokens INTEGER,
        PRIMARY KEY (hourKey, provider, model, connectionId)
      );
      CREATE TABLE requestUsageRecords (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        createdAt INTEGER NOT NULL,
        endpoint TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        connectionId INTEGER NOT NULL,
        status INTEGER NOT NULL,
        latencyMs INTEGER,
        promptTokens INTEGER,
        cachedTokens INTEGER,
        completionTokens INTEGER
      );
      CREATE INDEX idx_request_usage_created ON requestUsageRecords (createdAt DESC);
      INSERT INTO hourlyUsageAggregates
        (hourKey, provider, model, connectionId, requests, failedRequests, promptTokens, cachedTokens, completionTokens)
      SELECT dateKey || 'T00', provider, model, connectionId, requests, failedRequests, promptTokens, NULL, completionTokens
      FROM dailyUsageAggregates;
    `,
  },
  {
    version: 8,
    name: "hourly-usage-coverage",
    sql: `
      ALTER TABLE hourlyUsageAggregates ADD COLUMN unknownPromptRequests INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE hourlyUsageAggregates ADD COLUMN unknownCachedRequests INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE hourlyUsageAggregates ADD COLUMN unknownCompletionRequests INTEGER NOT NULL DEFAULT 0;
      UPDATE hourlyUsageAggregates SET
        unknownPromptRequests = CASE WHEN promptTokens IS NULL THEN requests ELSE 0 END,
        unknownCachedRequests = CASE WHEN cachedTokens IS NULL THEN requests ELSE 0 END,
        unknownCompletionRequests = CASE WHEN completionTokens IS NULL THEN requests ELSE 0 END;
    `,
  },
  {
    version: 9,
    name: "remove-custom-pricing",
    sql: `ALTER TABLE settings DROP COLUMN modelPricing;`,
  },
  {
    version: 10,
    name: "endpoint-usage-analytics",
    sql: `
      CREATE TABLE hourlyEndpointUsageAggregates (
        hourKey TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        connectionId INTEGER NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0,
        failedRequests INTEGER NOT NULL DEFAULT 0,
        promptTokens INTEGER,
        cachedTokens INTEGER,
        completionTokens INTEGER,
        PRIMARY KEY (hourKey, endpoint, provider, model, connectionId)
      );
    `,
  },
  {
    version: 11,
    name: "api-key-usage-analytics",
    sql: `
      ALTER TABLE requestUsageRecords ADD COLUMN keyName TEXT NOT NULL DEFAULT 'Unknown (Historical)';
      CREATE TABLE hourlyApiKeyUsageAggregates (
        hourKey TEXT NOT NULL,
        keyName TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        connectionId INTEGER NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0,
        failedRequests INTEGER NOT NULL DEFAULT 0,
        promptTokens INTEGER,
        cachedTokens INTEGER,
        completionTokens INTEGER,
        PRIMARY KEY (hourKey, keyName, provider, model, connectionId)
      );
      INSERT INTO hourlyApiKeyUsageAggregates
        (hourKey, keyName, provider, model, connectionId, requests, failedRequests, promptTokens, cachedTokens, completionTokens)
      SELECT hourKey, 'Unknown (Historical)', provider, model, connectionId, requests, failedRequests, promptTokens, cachedTokens, completionTokens
      FROM hourlyUsageAggregates;
    `,
  },
  {
    version: 12,
    name: "request-ttft",
    sql: `ALTER TABLE requestUsageRecords ADD COLUMN ttftMs INTEGER;`,
  },
];

export function migrate(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    appliedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  const applied = new Set(
    (db.query("SELECT version FROM migrations").all() as Array<{ version: number }>)
      .map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    // Each migration runs in its own transaction; a failure rolls back that
    // migration entirely and leaves the DB at the prior version.
    db.transaction(() => {
      db.exec(m.sql);
      db
        .query("INSERT INTO migrations (version, name) VALUES (?, ?)")
        .run(m.version, m.name);
    })();
  }
}

/** Current applied version (0 when no migrations have run). */
export function migrationVersion(db: Database): number {
  const has = db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'",
  ).get();
  if (!has) return 0;
  const row = db.query("SELECT MAX(version) AS v FROM migrations").get() as { v: number | null };
  return row.v ?? 0;
}

// ---------------------------------------------------------------------------
// Settings repository (singleton row id=1)
// ---------------------------------------------------------------------------

export interface Settings {
  gatewayKey: string;
  gatewayEnforce: boolean;
  disabledModels: string[];
}

export function getSettings(db: Database): Settings {
  const row = db
    .query("SELECT gatewayKey, gatewayEnforce, disabledModels FROM settings WHERE id = 1")
    .get() as { gatewayKey: string; gatewayEnforce: number; disabledModels: string };
  return { gatewayKey: row.gatewayKey, gatewayEnforce: row.gatewayEnforce === 1, disabledModels: JSON.parse(row.disabledModels) as string[] };
}

export function setGatewayKey(db: Database, key: string): void {
  db.query("UPDATE settings SET gatewayKey = ? WHERE id = 1").run(key);
}

export function setGatewayEnforce(db: Database, enforce: boolean): void {
  db.query("UPDATE settings SET gatewayEnforce = ? WHERE id = 1").run(enforce ? 1 : 0);
}

export function setModelsDisabled(db: Database, changed: readonly string[], disabled: boolean): string[] {
  const models = new Set(getSettings(db).disabledModels);
  for (const model of changed) {
    if (disabled) models.add(model);
    else models.delete(model);
  }
  const next = [...models].sort();
  db.query("UPDATE settings SET disabledModels = ? WHERE id = 1").run(JSON.stringify(next));
  return next;
}


// ---------------------------------------------------------------------------
// Connections repository
// ---------------------------------------------------------------------------

interface ConnectionRow {
  id: number;
  provider: string;
  name: string;
  isActive: number;
  priority: number;
  data: string;
  unavailableUntil: number | null;
  lastError: string | null;
  healthVersion: number;
  createdAt: string;
  updatedAt: string;
}

function rowToConnection(row: ConnectionRow): ProviderConnectionWithCooldown {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    isActive: row.isActive,
    priority: row.priority,
    data: JSON.parse(row.data) as ConnectionData,
    unavailableUntil: row.unavailableUntil ?? null,
    lastError: row.lastError ?? null,
    healthVersion: row.healthVersion ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listConnections(db: Database): ProviderConnectionWithCooldown[] {
  const rows = db
    .query("SELECT * FROM providerConnections ORDER BY provider, priority, id")
    .all() as ConnectionRow[];
  return rows.map(rowToConnection);
}

/** One indexed query of all active connections — the account router's only input. */
export function listActiveConnections(db: Database): ProviderConnectionWithCooldown[] {
  const rows = db
    .query("SELECT * FROM providerConnections WHERE isActive = 1 ORDER BY priority, id")
    .all() as ConnectionRow[];
  return rows.map(rowToConnection);
}

export function getConnection(db: Database, id: number): ProviderConnectionWithCooldown | undefined {
  const row = db
    .query("SELECT * FROM providerConnections WHERE id = ?")
    .get(id) as ConnectionRow | undefined;
  return row ? rowToConnection(row) : undefined;
}


/** Persist one sanitized health error, optionally with a cooldown. */
export function recordConnectionError(
  db: Database,
  id: number,
  lastError: string,
  unavailableUntil?: number | null,
): void {
  if (unavailableUntil === undefined) {
    db.query(
      `UPDATE providerConnections
       SET lastError = ?, healthVersion = healthVersion + 1,
           updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
    ).run(lastError, id);
    return;
  }
  db.query(
    `UPDATE providerConnections
     SET unavailableUntil = ?, lastError = ?, healthVersion = healthVersion + 1,
         updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`,
  ).run(unavailableUntil, lastError, id);
}

/** Clear health only if no failure was recorded after the caller's snapshot. */
export function clearConnectionError(db: Database, id: number, expectedHealthVersion: number): boolean {
  const result = db.query(
    `UPDATE providerConnections
     SET unavailableUntil = NULL, lastError = NULL,
         updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND healthVersion = ?`,
  ).run(id, expectedHealthVersion) as { changes: number };
  return result.changes > 0;
}

/** Persist Codex OAuth tokens atomically after login or refresh. */
export function updateConnectionTokens(
  db: Database,
  id: number,
  tokens: {
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    expiresAt: number;
    accountId?: string;
    email?: string;
    planType?: string;
  },
): ProviderConnectionWithCooldown | undefined {
  const current = getConnection(db, id);
  if (!current) return undefined;
  const data: ConnectionData = {
    ...current.data,
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
  };
  for (const key of ["refreshToken", "idToken", "accountId", "email", "planType"] as const) {
    const value = tokens[key];
    if (value !== undefined) data[key] = value;
  }
  return db.transaction(() => {
    updateConnection(db, id, { data });
    clearConnectionError(db, id, current.healthVersion);
    return getConnection(db, id);
  })() ?? getConnection(db, id);
}

export function createConnection(
  db: Database,
  input: { provider: string; name: string; isActive?: boolean; priority?: number; data: ConnectionData },
): ProviderConnectionWithCooldown {
  const result = db
    .query(
      `INSERT INTO providerConnections (provider, name, isActive, priority, data)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.provider,
      input.name,
      (input.isActive ?? true) ? 1 : 0,
      input.priority ?? 0,
      JSON.stringify(input.data),
    ) as { lastInsertRowid: number | bigint; changes: number };
  return getConnection(db, Number(result.lastInsertRowid))!;
}

export function updateConnection(
  db: Database,
  id: number,
  patch: {
    name?: string;
    isActive?: boolean;
    priority?: number;
    data?: ConnectionData;
  },
): ProviderConnectionWithCooldown | undefined {
  const current = getConnection(db, id);
  if (!current) return undefined;
  db.query(
    `UPDATE providerConnections
     SET name = ?, isActive = ?, priority = ?, data = ?,
         updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`,
  ).run(
    patch.name ?? current.name,
    (patch.isActive ?? current.isActive === 1) ? 1 : 0,
    patch.priority ?? current.priority,
    JSON.stringify(patch.data ?? current.data),
    id,
  );
  return getConnection(db, id);
}

export function deleteConnection(db: Database, id: number): boolean {
  const result = db.query("DELETE FROM providerConnections WHERE id = ?").run(id) as { lastInsertRowid: number | bigint; changes: number };
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Aliases repository
// ---------------------------------------------------------------------------

export function listAliases(db: Database): ModelAlias[] {
  return db
    .query("SELECT * FROM modelAliases ORDER BY name")
    .all() as ModelAlias[];
}

export function getAlias(db: Database, name: string): ModelAlias | undefined {
  return db
    .query("SELECT * FROM modelAliases WHERE name = ?")
    .get(name) as ModelAlias | undefined;
}

export function upsertAlias(db: Database, name: string, target: string): ModelAlias {
  db.query(
    `INSERT INTO modelAliases (name, target) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET target = excluded.target`,
  ).run(name, target);
  return getAlias(db, name)!;
}

export function deleteAlias(db: Database, name: string): boolean {
  const result = db.query("DELETE FROM modelAliases WHERE name = ?").run(name) as { lastInsertRowid: number | bigint; changes: number };
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Usage repository
// ---------------------------------------------------------------------------
export interface UsageDelta {
  provider: string;
  model: string;
  connectionId: number;
  promptTokens: number | null;
  cachedTokens?: number | null;
  completionTokens: number | null;
  failed?: boolean;
  endpoint?: string;
  status?: number;
  latencyMs?: number;
  createdAt?: number;
  ttftMs?: number;
  keyName?: string;
}

function addNullable(existing: string, excluded: string): string {
  return `CASE WHEN ${excluded} IS NULL THEN ${existing} WHEN ${existing} IS NULL THEN ${excluded} ELSE ${existing} + ${excluded} END`;
}

export function recordUsage(db: Database, delta: UsageDelta): void {
  const createdAt = delta.createdAt ?? Date.now();
  const dateKey = new Date(createdAt).toISOString().slice(0, 10);
  const hourKey = new Date(createdAt).toISOString().slice(0, 13);
  db.transaction(() => {
    db.query(
      `INSERT INTO dailyUsageAggregates
         (dateKey, provider, model, connectionId, requests, promptTokens, cachedTokens, completionTokens, failedRequests)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(dateKey, provider, model, connectionId) DO UPDATE SET
         requests = requests + 1,
         failedRequests = failedRequests + excluded.failedRequests,
         promptTokens = ${addNullable("dailyUsageAggregates.promptTokens", "excluded.promptTokens")},
         cachedTokens = ${addNullable("dailyUsageAggregates.cachedTokens", "excluded.cachedTokens")},
         completionTokens = ${addNullable("dailyUsageAggregates.completionTokens", "excluded.completionTokens")}`,
    ).run(dateKey, delta.provider, delta.model, delta.connectionId, delta.promptTokens, delta.cachedTokens ?? null, delta.completionTokens, delta.failed ? 1 : 0);
    db.query(
      `INSERT INTO hourlyUsageAggregates
         (hourKey, provider, model, connectionId, requests, failedRequests, promptTokens, cachedTokens, completionTokens, unknownPromptRequests, unknownCachedRequests, unknownCompletionRequests)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hourKey, provider, model, connectionId) DO UPDATE SET
         requests = requests + 1,
         failedRequests = failedRequests + excluded.failedRequests,
         unknownPromptRequests = unknownPromptRequests + excluded.unknownPromptRequests,
         unknownCachedRequests = unknownCachedRequests + excluded.unknownCachedRequests,
         unknownCompletionRequests = unknownCompletionRequests + excluded.unknownCompletionRequests,
         promptTokens = ${addNullable("hourlyUsageAggregates.promptTokens", "excluded.promptTokens")},
         cachedTokens = ${addNullable("hourlyUsageAggregates.cachedTokens", "excluded.cachedTokens")},
         completionTokens = ${addNullable("hourlyUsageAggregates.completionTokens", "excluded.completionTokens")}`,
    ).run(hourKey, delta.provider, delta.model, delta.connectionId, delta.failed ? 1 : 0, delta.promptTokens, delta.cachedTokens ?? null, delta.completionTokens, delta.promptTokens === null ? 1 : 0, delta.cachedTokens == null ? 1 : 0, delta.completionTokens === null ? 1 : 0);
    const inserted = db.query(
      `INSERT INTO requestUsageRecords
         (createdAt, endpoint, provider, model, connectionId, status, latencyMs, ttftMs, promptTokens, cachedTokens, completionTokens, keyName)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(createdAt, delta.endpoint ?? null, delta.provider, delta.model, delta.connectionId, delta.status ?? (delta.failed ? 500 : 200), delta.latencyMs ?? null, delta.ttftMs ?? null, delta.promptTokens, delta.cachedTokens ?? null, delta.completionTokens, delta.keyName ?? "Local (No API Key)") as { lastInsertRowid: number | bigint };
    if (delta.endpoint) {
      db.query(
        `INSERT INTO hourlyEndpointUsageAggregates
           (hourKey, endpoint, provider, model, connectionId, requests, failedRequests, promptTokens, cachedTokens, completionTokens)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(hourKey, endpoint, provider, model, connectionId) DO UPDATE SET
           requests = requests + 1,
           failedRequests = failedRequests + excluded.failedRequests,
           promptTokens = ${addNullable("hourlyEndpointUsageAggregates.promptTokens", "excluded.promptTokens")},
           cachedTokens = ${addNullable("hourlyEndpointUsageAggregates.cachedTokens", "excluded.cachedTokens")},
           completionTokens = ${addNullable("hourlyEndpointUsageAggregates.completionTokens", "excluded.completionTokens")}`,
      ).run(hourKey, delta.endpoint, delta.provider, delta.model, delta.connectionId, delta.failed ? 1 : 0, delta.promptTokens, delta.cachedTokens ?? null, delta.completionTokens);
    }
    const keyName = delta.keyName ?? "Local (No API Key)";
    db.query(
      `INSERT INTO hourlyApiKeyUsageAggregates
         (hourKey, keyName, provider, model, connectionId, requests, failedRequests, promptTokens, cachedTokens, completionTokens)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(hourKey, keyName, provider, model, connectionId) DO UPDATE SET
         requests = requests + 1,
         failedRequests = failedRequests + excluded.failedRequests,
         promptTokens = ${addNullable("hourlyApiKeyUsageAggregates.promptTokens", "excluded.promptTokens")},
         cachedTokens = ${addNullable("hourlyApiKeyUsageAggregates.cachedTokens", "excluded.cachedTokens")},
         completionTokens = ${addNullable("hourlyApiKeyUsageAggregates.completionTokens", "excluded.completionTokens")}`,
    ).run(hourKey, keyName, delta.provider, delta.model, delta.connectionId, delta.failed ? 1 : 0, delta.promptTokens, delta.cachedTokens ?? null, delta.completionTokens);
    if (Number(inserted.lastInsertRowid) % 500 === 0) {
      db.query("DELETE FROM requestUsageRecords WHERE id NOT IN (SELECT id FROM requestUsageRecords ORDER BY id DESC LIMIT 5000)").run();
    }
  })();
}

export function usageSummary(db: Database, dateKey?: string): UsageRow[] {
  const select = "SELECT dateKey, provider, model, connectionId, requests, promptTokens, cachedTokens, completionTokens, failedRequests FROM dailyUsageAggregates";
  return dateKey === undefined
    ? db.query(`${select} ORDER BY dateKey DESC, provider, model, connectionId`).all() as UsageRow[]
    : db.query(`${select} WHERE dateKey = ? ORDER BY provider, model, connectionId`).all(dateKey) as UsageRow[];
}

export interface HourlyUsageRow extends Omit<UsageRow, "dateKey"> {
  hourKey: string;
  unknownPromptRequests: number;
  unknownCachedRequests: number;
  unknownCompletionRequests: number;
}

export function hourlyUsageSince(db: Database, sinceHour: string): HourlyUsageRow[] {
  return db.query(
    `SELECT hourKey, provider, model, connectionId, requests, promptTokens, cachedTokens, completionTokens, failedRequests,
       unknownPromptRequests, unknownCachedRequests, unknownCompletionRequests
     FROM hourlyUsageAggregates WHERE hourKey >= ? ORDER BY hourKey, provider, model, connectionId`,
  ).all(sinceHour) as HourlyUsageRow[];
}

export function recentUsageSince(db: Database, since: number, limit = 100, offset = 0): RequestUsageRecord[] {
  return db.query(
    `SELECT id, createdAt, endpoint, provider, model, connectionId, status, latencyMs, ttftMs, promptTokens, cachedTokens, completionTokens, keyName
     FROM requestUsageRecords WHERE createdAt >= ? ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
  ).all(since, Math.min(Math.max(limit, 1), 5000), Math.max(offset, 0)) as RequestUsageRecord[];
}

export interface EndpointUsageRow extends Omit<UsageRow, "dateKey"> {
  hourKey: string;
  endpoint: string;
}

export function endpointUsageSince(db: Database, sinceHour: string): EndpointUsageRow[] {
  return db.query(
    `SELECT hourKey, endpoint, provider, model, connectionId, requests, promptTokens, cachedTokens, completionTokens, failedRequests
     FROM hourlyEndpointUsageAggregates WHERE hourKey >= ? ORDER BY endpoint, provider, model, connectionId`,
  ).all(sinceHour) as EndpointUsageRow[];
}

export interface ApiKeyUsageRow extends Omit<UsageRow, "dateKey"> {
  hourKey: string;
  keyName: string;
}

export function apiKeyUsageSince(db: Database, sinceHour: string): ApiKeyUsageRow[] {
  return db.query(
    `SELECT hourKey, keyName, provider, model, connectionId, requests, promptTokens, cachedTokens, completionTokens, failedRequests
     FROM hourlyApiKeyUsageAggregates WHERE hourKey >= ? ORDER BY keyName, provider, model, connectionId`,
  ).all(sinceHour) as ApiKeyUsageRow[];
}

export interface RequestUsageFilter {
  page: number;
  pageSize: number;
  provider?: string;
  startAt?: number;
  endAt?: number;
}

export function requestUsageDetails(db: Database, filter: RequestUsageFilter): {
  details: RequestUsageRecord[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
} {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (filter.provider) { conditions.push("provider = ?"); params.push(filter.provider); }
  if (filter.startAt !== undefined) { conditions.push("createdAt >= ?"); params.push(filter.startAt); }
  if (filter.endAt !== undefined) { conditions.push("createdAt <= ?"); params.push(filter.endAt); }
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const totalItems = (db.query(`SELECT COUNT(*) AS count FROM requestUsageRecords${where}`).get(...params) as { count: number }).count;
  const details = db.query(
    `SELECT id, createdAt, endpoint, provider, model, connectionId, status, latencyMs, ttftMs, promptTokens, cachedTokens, completionTokens, keyName
     FROM requestUsageRecords${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
  ).all(...params, filter.pageSize, (filter.page - 1) * filter.pageSize) as RequestUsageRecord[];
  return { details, pagination: { page: filter.page, pageSize: filter.pageSize, totalItems, totalPages: Math.ceil(totalItems / filter.pageSize) } };
}
