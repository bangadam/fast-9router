// Migrations: empty database to latest, upgrade fixture from the previous
// version, and transactional rollback when a migration fails.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { openDatabase, migrate, migrationVersion, MIGRATIONS } from "../src/db.ts";
import { join } from "node:path";

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "fast-9router-mig-")), "test.db");
}

describe("migrations", () => {
  test("empty database migrates to the latest version with the full schema", () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    // settings singleton seeded
    const settings = db.query("SELECT gatewayEnforce, passwordHash, authVersion, rtkEnabled, cavemanEnabled, cavemanLevel, ponytailEnabled, ponytailLevel FROM settings WHERE id = 1").get();
    expect(settings).toEqual({ gatewayEnforce: 0, passwordHash: "", authVersion: 1, rtkEnabled: 1, cavemanEnabled: 0, cavemanLevel: "full", ponytailEnabled: 0, ponytailLevel: "full" });
    const settingsColumns = (db.query("PRAGMA table_info(settings)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(settingsColumns).not.toContain("gatewayKey");
    const tables = (
      db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const expected of ["settings", "providerConnections", "modelAliases", "migrations", "dailyUsageAggregates", "hourlyUsageAggregates", "hourlyEndpointUsageAggregates", "hourlyApiKeyUsageAggregates", "requestUsageRecords", "dashboardSessions", "gatewayApiKeys"]) {
      expect(tables).toContain(expected);
    }
    const connectionColumns = (
      db.query("PRAGMA table_info(providerConnections)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(connectionColumns).toContain("lastError");
    expect(connectionColumns).toContain("healthVersion");
    const requestColumns = (db.query("PRAGMA table_info(requestUsageRecords)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(requestColumns).toContain("keyCategory");
    expect(requestColumns).toContain("gatewayKeyId");
    expect(requestColumns).toContain("gatewayKeyName");
    expect(requestColumns).toContain("ttftMs");
    expect(requestColumns).not.toContain("keyName");
    expect(requestColumns).not.toContain("request");
    expect(requestColumns).not.toContain("response");
    db.close();
  });

  test("upgrade fixture: database at version 1 upgrades to latest without data loss", () => {
    const path = tempDbPath();
    // Build a version-1 database by running only migration 1.
    const db = openDatabase(path);
    db.exec("CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, appliedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
    db.transaction(() => {
      if ("sql" in MIGRATIONS[0]!) db.exec(MIGRATIONS[0]!.sql);
      db.query("INSERT INTO migrations (version, name) VALUES (?, ?)").run(MIGRATIONS[0]!.version, MIGRATIONS[0]!.name);
    })();
    db.query(
      "INSERT INTO dailyUsageAggregates (dateKey, provider, model, connectionId, requests, promptTokens, completionTokens) VALUES ('2026-09-01', 'codex', 'cx/gpt-5.5', 1, 3, 100, 200)",
    ).run();
    db.close();

    // Reopen and migrate: should apply migration 2 and keep the row.
    const db2 = openDatabase(path);
    migrate(db2);
    expect(migrationVersion(db2)).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    const row = db2
      .query("SELECT requests, promptTokens, completionTokens, totalTokens, failedRequests FROM dailyUsageAggregates")
      .get() as { requests: number; promptTokens: number; completionTokens: number; totalTokens: number | null; failedRequests: number };
    expect(row).toEqual({ requests: 3, promptTokens: 100, completionTokens: 200, totalTokens: null, failedRequests: 0 });
    const connectionColumns = (
      db2.query("PRAGMA table_info(providerConnections)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(connectionColumns).toContain("lastError");
    expect(connectionColumns).toContain("healthVersion");
    db2.close();
  });

  test("migrations are idempotent: running twice applies nothing new", () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    const v1 = migrationVersion(db);
    migrate(db);
    expect(migrationVersion(db)).toBe(v1);
    const count = (db.query("SELECT COUNT(*) AS n FROM migrations").get() as { n: number }).n;
    expect(count).toBe(MIGRATIONS.length);
    db.close();
  });

  test("a failing migration rolls back and leaves the DB at the prior version", () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    const before = migrationVersion(db);

    // A migration that fails partway: valid DDL then invalid DDL in one
    // transaction. bun:sqlite Database#transaction rethrows and rolls back.
    const failingSql = `
      CREATE TABLE tempThing (id INTEGER PRIMARY KEY);
      INSERT INTO nonexistent_table VALUES (1);
    `;
    expect(() => {
      db.transaction(() => {
        db.exec(failingSql);
        db.query("INSERT INTO migrations (version, name) VALUES (?, ?)").run(before + 1, "failing");
      })();
    }).toThrow();

    expect(migrationVersion(db)).toBe(before);
    // no partial state: tempThing must not exist
    const leftover = db.query("SELECT name FROM sqlite_master WHERE name='tempThing'").get();
    expect(leftover).toBeNull();
    db.close();
  });

  test("database file and directory use narrow permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "fast-9router-perm-"));
    const path = join(dir, "sub", "test.db");
    const db = openDatabase(path);
    const mode = (statSync(path).mode & 0o777).toString(8);
    const dirMode = (statSync(join(dir, "sub")).mode & 0o777).toString(8);
    expect(mode).toBe("600");
    expect(dirMode).toBe("700");
    db.close();
  });

  test("v12 fixture with singleton key and usage upgrades to latest with attribution intact", () => {
    const path = tempDbPath();
    const db = openDatabase(path);
    // Build a version-12 database by applying migrations 1..12 only.
    db.exec("CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, appliedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
    for (const m of MIGRATIONS) {
      if (m.version > 12) break;
      db.transaction(() => {
        if ("sql" in m) db.exec(m.sql);
        db.query("INSERT INTO migrations (version, name) VALUES (?, ?)").run(m.version, m.name);
      })();
    }
    // Seed: singleton key + enforcement, one connection, one alias, usage rows.
    db.query("UPDATE settings SET gatewayKey = 'legacy-secret-key-99', gatewayEnforce = 1 WHERE id = 1").run();
    db.query("INSERT INTO providerConnections (provider, name, data) VALUES ('openai', 'main', ?)")
      .run(JSON.stringify({ apiKey: "sk-x", baseUrl: "https://example.test/v1", prefix: "px", models: ["m1"] }));
    db.query("INSERT INTO modelAliases (name, target) VALUES ('fast', 'px/m1')").run();
    db.query("INSERT INTO requestUsageRecords (createdAt, endpoint, provider, model, connectionId, status, promptTokens, completionTokens, keyName) VALUES (1000, '/v1/chat/completions', 'openai', 'px/m1', 1, 200, 10, 20, 'Gateway API Key')").run();
    db.query("INSERT INTO requestUsageRecords (createdAt, endpoint, provider, model, connectionId, status, promptTokens, completionTokens, keyName) VALUES (2000, '/v1/chat/completions', 'openai', 'px/m1', 1, 200, 5, 7, 'Local (No API Key)')").run();
    db.query("INSERT INTO requestUsageRecords (createdAt, endpoint, provider, model, connectionId, status, promptTokens, completionTokens, keyName) VALUES (3000, NULL, 'openai', 'px/m1', 1, 200, 1, 2, 'Internal Auto-ping')").run();
    db.query("INSERT INTO requestUsageRecords (createdAt, endpoint, provider, model, connectionId, status, promptTokens, completionTokens, keyName) VALUES (4000, NULL, 'openai', 'px/m1', 1, 200, 3, 4, 'Unknown (Historical)')").run();
    db.query("INSERT INTO hourlyApiKeyUsageAggregates (hourKey, keyName, provider, model, connectionId, requests, failedRequests, promptTokens, completionTokens) VALUES ('2026-09-05T10', 'Gateway API Key', 'openai', 'px/m1', 1, 3, 0, 30, 60)").run();
    db.close();

    // Reopen and migrate through 13 and 14.
    const db2 = openDatabase(path);
    migrate(db2);
    expect(migrationVersion(db2)).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);

    // The old raw key is absent from SQLite.
    const raw = JSON.stringify(db2.query("SELECT * FROM gatewayApiKeys").all() as Array<Record<string, unknown>>);
    expect(raw).not.toContain("legacy-secret-key-99");
    const settingsColumns = (db2.query("PRAGMA table_info(settings)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(settingsColumns).not.toContain("gatewayKey");

    // One migrated key exists, active, named Default Key.
    const keys = db2.query("SELECT id, name, secretHash, isActive FROM gatewayApiKeys").all() as Array<{ id: string; name: string; secretHash: string; isActive: number }>;
    expect(keys).toHaveLength(1);
    expect(keys[0]!.name).toBe("Default Key");
    expect(keys[0]!.isActive).toBe(1);
    expect(keys[0]!.secretHash).toBe(createHash("sha256").update("legacy-secret-key-99").digest("hex"));

    // Usage attribution migrated: gateway rows carry the key id/name; others map to their categories.
    const records = db2.query("SELECT keyCategory, gatewayKeyId, gatewayKeyName, promptTokens, completionTokens FROM requestUsageRecords ORDER BY createdAt").all() as Array<Record<string, unknown>>;
    expect(records[0]).toMatchObject({ keyCategory: "gateway", gatewayKeyId: keys[0]!.id, gatewayKeyName: "Default Key", promptTokens: 10, completionTokens: 20 });
    expect(records[1]).toMatchObject({ keyCategory: "local", gatewayKeyName: "Local (No API Key)" });
    expect(records[2]).toMatchObject({ keyCategory: "internal", gatewayKeyName: "Internal Auto-ping" });
    expect(records[3]).toMatchObject({ keyCategory: "historical", gatewayKeyName: "Unknown (Historical)" });

    // Hourly aggregate totals preserved with gateway attribution.
    const aggregate = db2.query("SELECT keyCategory, gatewayKeyName, requests, promptTokens, completionTokens FROM hourlyApiKeyUsageAggregates").get() as Record<string, unknown>;
    expect(aggregate).toMatchObject({ keyCategory: "gateway", gatewayKeyName: "Default Key", requests: 3, promptTokens: 30, completionTokens: 60 });

    // Auth and Token Saver defaults match the plan.
    const settings = db2.query("SELECT passwordHash, authVersion, rtkEnabled, cavemanEnabled, cavemanLevel, ponytailEnabled, ponytailLevel FROM settings WHERE id = 1").get();
    expect(settings).toEqual({ passwordHash: "", authVersion: 1, rtkEnabled: 1, cavemanEnabled: 0, cavemanLevel: "full", ponytailEnabled: 0, ponytailLevel: "full" });
    db2.close();
  });
});
