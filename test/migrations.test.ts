// Migrations: empty database to latest, upgrade fixture from the previous
// version, and transactional rollback when a migration fails.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate, migrationVersion, MIGRATIONS } from "../src/db.ts";

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "fast-9router-mig-")), "test.db");
}

describe("migrations", () => {
  test("empty database migrates to the latest version with the full schema", () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    expect(migrationVersion(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    const tables = (
      db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const expected of ["settings", "providerConnections", "modelAliases", "migrations", "dailyUsageAggregates", "hourlyUsageAggregates", "hourlyEndpointUsageAggregates", "hourlyApiKeyUsageAggregates", "requestUsageRecords"]) {
      expect(tables).toContain(expected);
    }
    // settings singleton seeded
    const settings = db.query("SELECT gatewayKey, gatewayEnforce FROM settings WHERE id = 1").get();
    expect(settings).toEqual({ gatewayKey: "", gatewayEnforce: 0 });
    const connectionColumns = (
      db.query("PRAGMA table_info(providerConnections)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(connectionColumns).toContain("lastError");
    expect(connectionColumns).toContain("healthVersion");
    const requestColumns = (db.query("PRAGMA table_info(requestUsageRecords)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(requestColumns).toContain("keyName");
    expect(requestColumns).toContain("ttftMs");
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
      db.exec(MIGRATIONS[0]!.sql);
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
});
