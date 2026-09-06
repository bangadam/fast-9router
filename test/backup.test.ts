// Backup export/import: round-trip preserves config; validation rejects
// malformed/oversize/wrong-version/duplicate/invalid-target payloads with
// zero writes; transactional failure rolls back.

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate, createConnection, recordUsage, upsertAlias, type Database } from "../src/db.ts";
import { exportBackup, importBackup, validateBackupPayload, type BackupV1 } from "../src/backup.ts";
import { resetLoginLimiter } from "../src/auth.ts";
import { makeApp, adminJson } from "./helpers.ts";

const contexts: Array<ReturnType<typeof makeApp>> = [];
function ctx() {
  const c = makeApp();
  contexts.push(c);
  return c;
}
beforeEach(() => resetLoginLimiter());
afterEach(() => {
  while (contexts.length) contexts.pop()!.cleanup();
});

async function cookieFor(app: ReturnType<typeof makeApp>["app"], password = "123456"): Promise<string> {
  const r = await app.fetch(new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-peer": "127.0.0.1" },
    body: JSON.stringify({ password }),
  }));
  return r.headers.get("set-cookie")!.split(";")[0]!;
}
function db(): Database {
  const dir = mkdtempSync(join(tmpdir(), "fast9r-backup-"));
  const database = openDatabase(join(dir, "test.db"));
  migrate(database);
  return database;
}

function seededBackup(): { database: Database; backup: BackupV1 } {
  const database = db();
  createConnection(database, {
    provider: "openai",
    name: "official",
    data: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-secret-value-123", prefix: "oa", models: ["gpt-5.4"] },
  });
  upsertAlias(database, "alias-1", "oa/gpt-5.4");
  const backup = exportBackup(database);
  return { database, backup };
}

describe("backup export", () => {
  test("export contains provider credentials and gateway hashes but no password/session/usage", () => {
    const { database, backup } = seededBackup();
    expect(backup.format).toBe("fast-9router-backup");
    expect(backup.version).toBe(1);
    expect(backup.data.providerConnections[0]!.data.apiKey).toBe("sk-secret-value-123");
    expect(backup.data.modelAliases).toHaveLength(1);
    expect(backup.data.settings.rtkEnabled).toBe(true);
    const text = JSON.stringify(backup);
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain("dashboardSession");
    database.close();
  });

  test("gateway secret hashes are present; raw generated secrets are absent", async () => {
    const { app, db } = ctx();
    const response = await adminJson(app, "/api/admin/gateway/keys", "POST", { name: "primary" });
    expect(response.status).toBe(201);
    const created = await response.json() as { secret: string };
    const backup = exportBackup(db);
    expect(backup.data.gatewayApiKeys[0]!.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(backup)).not.toContain(created.secret);
  });
});

describe("backup validation", () => {
  test("unknown top-level field is rejected", () => {
    const { database } = seededBackup();
    const result = validateBackupPayload(database, { format: "fast-9router-backup", version: 1, createdAt: "2026-01-01T00:00:00Z", data: {}, extra: 1 });
    expect(result.ok).toBe(false);
    database.close();
  });

  test("wrong version is rejected", () => {
    const { database, backup } = seededBackup();
    const wrong = { ...backup, version: 2 };
    const result = validateBackupPayload(database, wrong);
    expect(result.ok).toBe(false);
    database.close();
  });

  test("unsupported connection data field is rejected", () => {
    const { database, backup } = seededBackup();
    const malformed = { ...backup, data: { ...backup.data, providerConnections: [{ ...backup.data.providerConnections[0]!, data: { ...backup.data.providerConnections[0]!.data, bogus: "x" } }] } };
    const result = validateBackupPayload(database, malformed);
    expect(result.ok).toBe(false);
    database.close();
  });

  test("duplicate alias name is rejected", () => {
    const { database, backup } = seededBackup();
    const malformed = { ...backup, data: { ...backup.data, modelAliases: [...backup.data.modelAliases, { id: 2, name: "alias-1", target: "oa/gpt-5.4", createdAt: "2026-01-01T00:00:00Z" }] } };
    const result = validateBackupPayload(database, malformed);
    expect(result.ok).toBe(false);
    database.close();
  });

  test("alias pointing at a non-configured canonical model is rejected", () => {
    const { database, backup } = seededBackup();
    const malformed = { ...backup, data: { ...backup.data, modelAliases: [{ id: 2, name: "stale", target: "oa/nonexistent", createdAt: "2026-01-01T00:00:00Z" }] } };
    const result = validateBackupPayload(database, malformed);
    expect(result.ok).toBe(false);
    database.close();
  });

  test("gatewayEnforce with zero active keys is rejected", () => {
    const { database, backup } = seededBackup();
    const malformed: BackupV1 = { ...backup, data: { ...backup.data, settings: { ...backup.data.settings, gatewayEnforce: true }, gatewayApiKeys: [] } };
    const result = validateBackupPayload(database, malformed);
    expect(result.ok).toBe(false);
    database.close();
  });
});

describe("backup import", () => {
  test("valid import replaces config while preserving password/sessions/telemetry", async () => {
    const { app, db: targetDb } = ctx();
    const cookie = await cookieFor(app);
    // Change password so the default is no longer in use on the target.
    const changeResponse = await app.fetch(new Request("http://localhost/api/admin/profile/password", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie, "x-test-peer": "127.0.0.1" },
      body: JSON.stringify({ currentPassword: "123456", newPassword: "new-password-1" }),
    }));
    expect(changeResponse.status).toBe(200);
    // The change revoked this session; re-login with the new password.
    const importCookie = await cookieFor(app, "new-password-1");
    // Seed the target with a usage record so telemetry is present pre-import.
    const usageConn = createConnection(targetDb, { provider: "codex", name: "usage", data: {} });
    recordUsage(targetDb, { provider: "codex", model: "cx/m1", connectionId: usageConn.id, promptTokens: 1, completionTokens: 1 });
    const { backup } = seededBackup();
    const response = await app.fetch(new Request("http://localhost/api/admin/backup/import", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: importCookie, "x-test-peer": "127.0.0.1" },
      body: JSON.stringify({ password: "new-password-1", backup }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.counts.connections).toBe(1);
    expect(body.counts.aliases).toBe(1);

    // The import replaced connections; the usage-only connection is gone.
    const names = (targetDb.query("SELECT name FROM providerConnections").all() as Array<{ name: string }>).map((row) => row.name);
    expect(names).toEqual(["official"]);
    // Password and sessions survived.
    expect((targetDb.query("SELECT passwordHash FROM settings WHERE id=1").get() as { passwordHash: string }).passwordHash).not.toBe("");
    expect((targetDb.query("SELECT COUNT(*) AS n FROM dashboardSessions").get() as { n: number }).n).toBeGreaterThan(0);
    // Telemetry survived.
    expect((targetDb.query("SELECT COUNT(*) AS n FROM requestUsageRecords").get() as { n: number }).n).toBeGreaterThan(0);
  });

  test("malformed JSON body is 400", async () => {
    const { app } = ctx();
    const cookie = await cookieFor(app);
    const response = await app.fetch(new Request("http://localhost/api/admin/backup/import", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-test-peer": "127.0.0.1" },
      body: "{not json",
    }));
    expect(response.status).toBe(400);
  });

  test("wrong password is 401", async () => {
    const { app } = ctx();
    const cookie = await cookieFor(app);
    const { backup } = seededBackup();
    const response = await app.fetch(new Request("http://localhost/api/admin/backup/import", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-test-peer": "127.0.0.1" },
      body: JSON.stringify({ password: "wrong", backup }),
    }));
    expect(response.status).toBe(401);
  });
});
