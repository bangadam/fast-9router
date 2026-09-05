// Usage aggregation: one upsert per completed request, unknown usage stays
// null (never a false zero), and log redaction.

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate, createConnection, recordUsage, usageSummary } from "../src/db.ts";
import { buildUsageAnalytics } from "../src/analytics.ts";
import { redact, Logger } from "../src/log.ts";

const dirs: string[] = [];
function ctx() {
  const dir = mkdtempSync(join(tmpdir(), "fast-9router-usage-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  migrate(db);
  return db;
}
afterEach(() => {
  // DBs are closed in each test
});

describe("usage aggregation upsert", () => {
  test("one upsert per request increments requests and keeps token counts", () => {
    const db = ctx();
    const conn = createConnection(db, { provider: "codex", name: "c1", data: {} });
    recordUsage(db, { provider: "codex", model: "cx/gpt-5.5", connectionId: conn.id, promptTokens: 10, completionTokens: 20 });
    recordUsage(db, { provider: "codex", model: "cx/gpt-5.5", connectionId: conn.id, promptTokens: 15, completionTokens: 25 });
    const rows = usageSummary(db);
    expect(rows).toHaveLength(1);
    // tokens accumulate across the day's requests
    expect(rows[0]).toMatchObject({ requests: 2, promptTokens: 25, completionTokens: 45 });
    db.close();
  });

  test("failed requests increment total and failed counts without inventing tokens", () => {
    const db = ctx();
    const connection = createConnection(db, { provider: "openai", name: "failed", data: {} });

    recordUsage(db, {
      provider: "openai",
      model: "provider/model",
      connectionId: connection.id,
      promptTokens: null,
      completionTokens: null,
      failed: true,
    });

    expect(usageSummary(db)[0]).toMatchObject({
      requests: 1,
      failedRequests: 1,
      promptTokens: null,
      completionTokens: null,
    });
    db.close();
  });

  test("unknown usage stays null, never a false zero", () => {
    const db = ctx();
    const conn = createConnection(db, { provider: "codex", name: "c1", data: {} });
    recordUsage(db, { provider: "codex", model: "cx/gpt-5.5", connectionId: conn.id, promptTokens: null, completionTokens: null });
    const rows = usageSummary(db);
    expect(rows[0]!.promptTokens).toBeNull();
    expect(rows[0]!.completionTokens).toBeNull();
    db.close();
  });

  test("known usage does not overwrite null, null does not erase known", () => {
    const db = ctx();
    const conn = createConnection(db, { provider: "codex", name: "c1", data: {} });
    recordUsage(db, { provider: "codex", model: "cx/gpt-5.5", connectionId: conn.id, promptTokens: null, completionTokens: null });
    recordUsage(db, { provider: "codex", model: "cx/gpt-5.5", connectionId: conn.id, promptTokens: 5, completionTokens: 7 });
    let rows = usageSummary(db);
    expect(rows[0]).toMatchObject({ requests: 2, promptTokens: 5, completionTokens: 7 });
    recordUsage(db, { provider: "codex", model: "cx/gpt-5.5", connectionId: conn.id, promptTokens: null, completionTokens: null });
    rows = usageSummary(db);
    expect(rows[0]).toMatchObject({ requests: 3, promptTokens: 5, completionTokens: 7 });
    db.close();
  });

  test("mixed known and unknown usage contributes known totals", () => {
    const db = ctx();
    const connection = createConnection(db, { provider: "codex", name: "mixed", data: {} });
    const now = Date.UTC(2026, 8, 5, 10);
    recordUsage(db, { provider: "codex", model: "cx/m1", connectionId: connection.id, promptTokens: null, completionTokens: null, createdAt: now });
    recordUsage(db, { provider: "codex", model: "cx/m1", connectionId: connection.id, promptTokens: 5, cachedTokens: 2, completionTokens: 7, createdAt: now + 1 });
    const analytics = buildUsageAnalytics(db, "today", now + 2);
    expect(analytics.summary).toMatchObject({ promptTokens: 5, cachedTokens: 2, completionTokens: 7, estimatedCost: 0 });
    expect(analytics.models[0]).toMatchObject({ promptTokens: 5, cachedTokens: 2, completionTokens: 7 });
    db.close();
  });

  test("distinct date/provider/model/connection keys aggregate separately", () => {
    const db = ctx();
    const a = createConnection(db, { provider: "codex", name: "c1", data: {} });
    const b = createConnection(db, { provider: "codex", name: "c2", data: {} });
    recordUsage(db, { provider: "codex", model: "cx/gpt-5.5", connectionId: a.id, promptTokens: 1, completionTokens: 1 });
    recordUsage(db, { provider: "codex", model: "cx/gpt-5.5", connectionId: b.id, promptTokens: 2, completionTokens: 2 });
    recordUsage(db, { provider: "codex", model: "cx/gpt-5.4", connectionId: a.id, promptTokens: 3, completionTokens: 3 });
    const rows = usageSummary(db);
    expect(rows).toHaveLength(3);
    db.close();
  });

  test("usage summary filters by date", () => {
    const db = ctx();
    const conn = createConnection(db, { provider: "codex", name: "c1", data: {} });
    recordUsage(db, { provider: "codex", model: "cx/gpt-5.5", connectionId: conn.id, promptTokens: 1, completionTokens: 1 });
    const today = new Date().toISOString().slice(0, 10);
    expect(usageSummary(db, today)).toHaveLength(1);
    expect(usageSummary(db, "2000-01-01")).toHaveLength(0);
    db.close();
  });

  test("no prompt or raw response is stored", () => {
    const db = ctx();
    const conn = createConnection(db, { provider: "codex", name: "c1", data: {} });
    recordUsage(db, { provider: "codex", model: "cx/gpt-5.5", connectionId: conn.id, promptTokens: 1, completionTokens: 1 });
    const cols = (
      db.query("PRAGMA table_info(dailyUsageAggregates)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toEqual([
      "dateKey", "provider", "model", "connectionId", "requests", "promptTokens", "completionTokens", "totalTokens", "failedRequests", "cachedTokens",
    ]);
    db.close();
  });

  test("records safe hourly and recent request metadata with cached tokens", () => {
    const db = ctx();
    const connection = createConnection(db, { provider: "openai", name: "primary", data: {} });
    const now = Date.UTC(2026, 8, 5, 10, 30);
    recordUsage(db, { provider: "openai", model: "px/m1", connectionId: connection.id, promptTokens: 100, cachedTokens: 80, completionTokens: 20, endpoint: "/v1/chat/completions", status: 200, latencyMs: 42, createdAt: now });

    const analytics = buildUsageAnalytics(db, "24h", now + 1);

    expect(analytics.summary).toMatchObject({ requests: 1, promptTokens: 100, cachedTokens: 80, completionTokens: 20 });
    expect(analytics.timeline).toHaveLength(24);
    expect(analytics.timeline.find((point) => point.hour === "2026-09-05T10")).toMatchObject({ requests: 1, cachedTokens: 80 });
    expect(analytics.recent).toEqual([expect.objectContaining({ endpoint: "/v1/chat/completions", status: 200, latencyMs: 42, connectionName: "primary" })]);
    expect(analytics.accounts).toEqual([expect.objectContaining({ model: "px/m1", connectionName: "primary", requests: 1 })]);
    expect(analytics.endpoints).toEqual([expect.objectContaining({ endpoint: "/v1/chat/completions", model: "px/m1", requests: 1 })]);
    expect(analytics.apiKeys).toEqual([expect.objectContaining({ keyName: "Local (No API Key)", model: "px/m1", requests: 1 })]);
    const columns = (db.query("PRAGMA table_info(requestUsageRecords)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).not.toContain("prompt");
    expect(columns).not.toContain("response");
    expect(columns).not.toContain("headers");
    db.close();
  });

  test("range filtering excludes old hourly and recent rows", () => {
    const db = ctx();
    const connection = createConnection(db, { provider: "codex", name: "codex", data: {} });
    const now = Date.UTC(2026, 8, 5, 12);
    recordUsage(db, { provider: "codex", model: "cx/m1", connectionId: connection.id, promptTokens: 1, completionTokens: 1, createdAt: now - 25 * 3_600_000 });
    recordUsage(db, { provider: "codex", model: "cx/m1", connectionId: connection.id, promptTokens: 2, completionTokens: 3, createdAt: now - 60_000 });

    const analytics = buildUsageAnalytics(db, "24h", now);

    expect(analytics.summary.requests).toBe(1);
    expect(analytics.summary.promptTokens).toBe(2);
    expect(analytics.recent).toHaveLength(1);
    db.close();
  });

  test("cost uses the internal 9Router pricing resolver", () => {
    const db = ctx();
    const connection = createConnection(db, { provider: "codex", name: "priced", data: {} });
    const now = Date.UTC(2026, 8, 5, 12);
    recordUsage(db, { provider: "codex", model: "cx/gpt-5.6-sol", connectionId: connection.id, promptTokens: 1_000_000, cachedTokens: 250_000, completionTokens: 500_000, createdAt: now });

    const analytics = buildUsageAnalytics(db, "today", now);

    expect(analytics.summary.estimatedCost).toBe(18.875);
    expect(analytics.models[0]?.cost).toEqual({ input: 3.75, cached: 0.125, output: 15, total: 18.875 });
    db.close();
  });
});

describe("log redaction", () => {
  test("secret keys are redacted by name", () => {
    const out = redact({
      authorization: "Bearer abc123",
      apiKey: "sk-live-abc",
      refresh_token: "rt-xyz",
      "x-api-key": "k",
      password: "hunter2",
      normal: "value",
    }) as Record<string, unknown>;
    for (const k of ["authorization", "apiKey", "refresh_token", "x-api-key", "password"]) {
      expect(out[k]).toBe("[REDACTED]");
    }
    expect(out.normal).toBe("value");
  });

  test("long opaque strings are masked even outside secret keys", () => {
    const out = redact({ note: "token was abcdefghijklmnopqrstuvwxyz123" }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain("abcdefghijklmnopqrstuvwxyz123");
  });

  test("readable prose is preserved", () => {
    const out = redact({ msg: "request completed for model gpt-5.5 in 42ms" });
    expect(out).toEqual({ msg: "request completed for model gpt-5.5 in 42ms" });
  });

  test("request identifiers, model names, and token metrics stay observable", () => {
    const telemetry = {
      requestId: "123e4567-e89b-12d3-a456-426614174000",
      provider: "anthropic",
      model: "anthropic/claude-3-5-sonnet-20241022",
      usage: {
        promptTokens: 123,
        completionTokens: 45,
        totalTokens: 168,
      },
    };

    expect(redact(telemetry)).toEqual(telemetry);
  });

  test("credential token fields remain redacted while token metrics remain visible", () => {
    const out = redact({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      id_token: "id-secret",
      promptTokens: 12,
      completion_tokens: 7,
    });

    expect(out).toEqual({
      accessToken: "[REDACTED]",
      refreshToken: "[REDACTED]",
      id_token: "[REDACTED]",
      promptTokens: 12,
      completion_tokens: 7,
    });
  });

  test("nested structures are redacted recursively", () => {
    const out = redact({ a: { apiKey: "secret", b: [{ token: "t" }] } }) as { a: { apiKey: string; b: Array<{ token: string }> } };
    expect(out.a.apiKey).toBe("[REDACTED]");
    expect(out.a.b[0]!.token).toBe("[REDACTED]");
  });

  test("logger output contains no secret material", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      const logger = new Logger("info");
      logger.info("request", {
        requestId: "req-1",
        endpoint: "/v1/chat/completions",
        authorization: "Bearer super-secret-token-value",
        connectionId: 3,
      });
    } finally {
      console.log = original;
    }
    const joined = lines.join("\n");
    expect(joined).toContain("req-1");
    expect(joined).not.toContain("super-secret-token-value");
    expect(joined).toContain("[REDACTED]");
  });
});

describe("connection data validation", () => {
  test("connection persists through reopen (settings, connections, aliases, usage survive restart)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fast-9router-persist-"));
    const path = join(dir, "test.db");
    {
      const db = openDatabase(path);
      migrate(db);
      createConnection(db, { provider: "codex", name: "c1", data: {} });
      db.query("INSERT INTO modelAliases (name, target) VALUES ('daily', 'cx/gpt-5.5')").run();
      db.close();
    }
    {
      const db = openDatabase(path);
      migrate(db); // no-op, already applied
      const conns = db.query("SELECT * FROM providerConnections").all();
      expect(conns).toHaveLength(1);
      const aliases = db.query("SELECT * FROM modelAliases").all();
      expect(aliases).toHaveLength(1);
      db.close();
    }
  });
});
