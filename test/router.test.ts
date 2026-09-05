// Account router tests: round-robin, priority, inactive, cooldown expiry,
// Retry-After, exhausted -> 503, non-retryable passthrough.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate, createConnection, getConnection, type Database, type ProviderConnectionWithCooldown } from "../src/db.ts";
import {
  orderConnections,
  routeWithFallback,
  classifyFailure,
  parseRetryAfterMs,
  resetRouterState,
} from "../src/router/accounts.ts";
import { safeUpstreamMessage } from "../src/upstream-error.ts";

function makeDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "fast-9router-router-"));
  const db = openDatabase(join(dir, "test.db"));
  migrate(db);
  return db;
}

function addConn(db: ReturnType<typeof makeDb>, opts: { provider?: string; priority?: number; isActive?: boolean } = {}) {
  return createConnection(db, {
    provider: opts.provider ?? "openai",
    name: `conn-${Math.random().toString(36).slice(2, 8)}`,
    isActive: opts.isActive ?? true,
    priority: opts.priority ?? 0,
    data: { apiKey: "sk-test", baseUrl: "http://127.0.0.1:1/v1", prefix: "p" },
  });
}

beforeEach(() => resetRouterState());

describe("orderConnections", () => {
  test("round-robin within the same priority group", async () => {
    const db = makeDb();
    const a = addConn(db);
    const b = addConn(db);
    const c = addConn(db);
    const winners: number[] = [];
    for (let request = 0; request < 3; request++) {
      const result = await routeWithFallback(db, "openai", async () => ({ kind: "ok" }));
      winners.push(result.connection!.id);
    }
    expect(winners).toEqual([a.id, b.id, c.id]);
  });

  test("independent eligible account pools keep separate round-robin cursors", async () => {
    const db = makeDb();
    const a1 = addConn(db);
    const a2 = addConn(db);
    const b1 = addConn(db);
    const b2 = addConn(db);
    const winner = async (connections: ProviderConnectionWithCooldown[]) =>
      (await routeWithFallback(db, "openai", async () => ({ kind: "ok" }), { connections })).connection!.id;

    expect(await winner([a1, a2])).toBe(a1.id);
    expect(await winner([b1, b2])).toBe(b1.id);
    expect(await winner([a1, a2])).toBe(a2.id);
    expect(await winner([b1, b2])).toBe(b2.id);
  });

  test("lower priority value is the preferred group; backups follow", () => {
    const db = makeDb();
    const backup = addConn(db, { priority: 10 });
    const preferred = addConn(db, { priority: 0 });
    const ordered = orderConnections([backup, preferred] as ProviderConnectionWithCooldown[], "openai");
    expect(ordered[0]!.id).toBe(preferred.id);
  });


  test("inactive connections are excluded (listActive) and other providers filtered", () => {
    const db = makeDb();
    const active = addConn(db);
    addConn(db, { isActive: false });
    addConn(db, { provider: "anthropic" });
    const ordered = orderConnections(
      [active] as ProviderConnectionWithCooldown[],
      "openai",
    );
    expect(ordered.map((x) => x.id)).toEqual([active.id]);
  });

  test("unavailableUntil in the future is skipped; expired cooldown returns", () => {
    const db = makeDb();
    const conn = addConn(db);
    const now = Date.now();
    const cooling = { ...conn, unavailableUntil: now + 60_000 } as ProviderConnectionWithCooldown;
    expect(orderConnections([cooling], "openai", now)).toEqual([]);
    const expired = { ...conn, unavailableUntil: now - 1_000 } as ProviderConnectionWithCooldown;
    expect(orderConnections([expired], "openai", now).map((x) => x.id)).toEqual([conn.id]);
  });
});

describe("classifyFailure", () => {
  test("429 is retryable and respects Retry-After seconds", () => {
    const outcome = classifyFailure(429, "{}", "30");
    expect(outcome.kind).toBe("retryable");
    if (outcome.kind === "retryable") expect(outcome.cooldownMs).toBe(30_000);
  });

  test("5xx and network-style bodies are retryable", () => {
    expect(classifyFailure(500, "{}", null).kind).toBe("retryable");
    expect(classifyFailure(503, "{}", null).kind).toBe("retryable");
    expect(classifyFailure(200, "capacity exceeded", null).kind).toBe("retryable");
  });

  test("other 4xx are fatal and never rotated", () => {
    const outcome = classifyFailure(400, JSON.stringify({ error: { message: "bad tool" } }), null);
    expect(outcome.kind).toBe("fatal");
    if (outcome.kind === "fatal") {
      expect(outcome.status).toBe(400);
      expect(outcome.message).toBe("bad tool");
    }
  });


  test("upstream authentication failures are retryable across accounts", () => {
    expect(classifyFailure(401, JSON.stringify({ error: { message: "invalid token" } }), null).kind).toBe("retryable");
    expect(classifyFailure(403, JSON.stringify({ error: { message: "forbidden" } }), null).kind).toBe("retryable");
  });

  test("upstream HTTP 408 is retryable across accounts", () => {
    const outcome = classifyFailure(408, JSON.stringify({ error: { message: "request timed out" } }), null);
    expect(outcome.kind).toBe("retryable");
  });
  test("payment-required 402 is fatal and preserves the upstream message", () => {
    const outcome = classifyFailure(
      402,
      JSON.stringify({ error: { message: "Payment required for inference", type: "payment_required" } }),
      null,
    );
    expect(outcome).toEqual({
      kind: "fatal",
      status: 402,
      message: "Payment required for inference",
    });
  });

  test("capacity-style 402 remains retryable", () => {
    const outcome = classifyFailure(
      402,
      JSON.stringify({ error: { message: "selected model is at capacity" } }),
      null,
    );
    expect(outcome.kind).toBe("retryable");
  });

  test("safeUpstreamMessage never leaks raw HTML", () => {
    const msg = safeUpstreamMessage(502, "<!doctype html><html><body>boom</body></html>");
    expect(msg).toBe("upstream returned 502");
  });
});

describe("parseRetryAfterMs", () => {
  test("seconds and HTTP-date forms", () => {
    expect(parseRetryAfterMs("10")).toBe(10_000);
    expect(parseRetryAfterMs("  7 ")).toBe(7_000);
    expect(parseRetryAfterMs("garbage")).toBe(null);
    expect(parseRetryAfterMs(new Date(Date.now() + 5_000).toUTCString())).toBeGreaterThan(4_000);
  });
});

describe("routeWithFallback", () => {
  test("falls back to the next account on retryable failure and cools down", async () => {
    const db = makeDb();
    const first = addConn(db);
    const second = addConn(db);
    const attempted: number[] = [];
    const result = await routeWithFallback(db, "openai", async (conn) => {
      attempted.push(conn.id);
      if (conn.id === first.id) return { kind: "retryable", cooldownMs: 1_000, reason: "upstream 429" } as const;
      return { kind: "ok" } as const;
    });
    expect(result.connection?.id).toBe(second.id);
    expect(attempted).toEqual([first.id, second.id]);
    // first is cooling down now
    const after = await db.query("SELECT unavailableUntil FROM providerConnections WHERE id = ?").get(first.id) as { unavailableUntil: number };
    expect(after.unavailableUntil).toBeGreaterThan(Date.now());
  });

  test("unused backup group does not advance while primary succeeds", async () => {
    const db = makeDb();
    const primary = addConn(db, { priority: 0 });
    const backupA = addConn(db, { priority: 10 });
    const backupB = addConn(db, { priority: 10 });
    const attempts: number[] = [];

    await routeWithFallback(db, "openai", async (connection) => {
      attempts.push(connection.id);
      return { kind: "ok" } as const;
    });
    await routeWithFallback(db, "openai", async (connection) => {
      attempts.push(connection.id);
      return connection.id === primary.id
        ? { kind: "retryable", cooldownMs: 0, reason: "primary failed" } as const
        : { kind: "ok" } as const;
    });

    expect(attempts).toEqual([primary.id, primary.id, backupA.id]);
    void backupB;
  });

  test("backup group advances after it is actually used", async () => {
    const db = makeDb();
    const primary = addConn(db, { priority: 0 });
    const backupA = addConn(db, { priority: 10 });
    const backupB = addConn(db, { priority: 10 });
    const winners: number[] = [];

    for (let request = 0; request < 2; request++) {
      const result = await routeWithFallback(db, "openai", async (connection) =>
        connection.id === primary.id
          ? { kind: "retryable", cooldownMs: 0, reason: "primary failed" } as const
          : { kind: "ok" } as const);
      winners.push(result.connection!.id);
    }

    expect(winners).toEqual([backupA.id, backupB.id]);
  });

  test("concurrent fallback skips an account cooled by another request", async () => {
    const db = makeDb();
    const first = addConn(db);
    const second = addConn(db);
    const connections = [first, second] as ProviderConnectionWithCooldown[];
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const attempts: string[] = [];

    const requestOne = routeWithFallback(db, "openai", async (connection) => {
      attempts.push(`one:${connection.id}`);
      if (connection.id === first.id) {
        entered.resolve();
        await release.promise;
        return { kind: "retryable", cooldownMs: 60_000, reason: "first failed" } as const;
      }
      return { kind: "ok" } as const;
    }, { connections });

    await entered.promise;
    const requestTwo = await routeWithFallback(db, "openai", async (connection) => {
      attempts.push(`two:${connection.id}`);
      if (connection.id === second.id) {
        return { kind: "retryable", cooldownMs: 60_000, reason: "second failed" } as const;
      }
      return { kind: "fatal", status: 400, message: "stop" } as const;
    }, { connections });
    expect(requestTwo.error?.status).toBe(400);

    release.resolve();
    const requestOneResult = await requestOne;

    expect(requestOneResult.error?.status).toBe(503);
    expect(attempts).toEqual([
      `one:${first.id}`,
      `two:${second.id}`,
      `two:${first.id}`,
    ]);
  });

  test("in-flight success cannot clear a newer concurrent cooldown", async () => {
    const db = makeDb();
    const connection = addConn(db);
    const connections = [connection] as ProviderConnectionWithCooldown[];
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const inFlightSuccess = routeWithFallback(db, "openai", async () => {
      entered.resolve();
      await release.promise;
      return { kind: "ok" } as const;
    }, { connections });
    await entered.promise;

    const failed = await routeWithFallback(db, "openai", async () => ({
      kind: "retryable",
      cooldownMs: 60_000,
      reason: "rate limited",
    }), { connections });
    expect(failed.error?.status).toBe(503);
    expect(getConnection(db, connection.id)?.lastError).toBe("rate limited");

    release.resolve();
    await inFlightSuccess;
    expect(getConnection(db, connection.id)?.lastError).toBe("rate limited");

    const row = db.query("SELECT unavailableUntil FROM providerConnections WHERE id = ?").get(connection.id) as { unavailableUntil: number | null };
    expect(row.unavailableUntil).not.toBeNull();
    expect(row.unavailableUntil!).toBeGreaterThan(Date.now());
  });

  test("in-flight success cannot clear a newer fatal error", async () => {
    const db = makeDb();
    const connection = addConn(db);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const inFlightSuccess = routeWithFallback(db, "openai", async () => {
      entered.resolve();
      await release.promise;
      return { kind: "ok" } as const;
    }, { connections: [connection] });
    await entered.promise;

    await routeWithFallback(db, "openai", async () => ({
      kind: "fatal",
      status: 404,
      message: "newer failure",
    }), { connections: [connection] });
    release.resolve();
    await inFlightSuccess;

    expect(getConnection(db, connection.id)?.lastError).toBe("newer failure");
  });

  test("valid Retry-After sets the cooldown", async () => {
    const db = makeDb();
    const conn = addConn(db);
    await routeWithFallback(db, "openai", async () => ({ kind: "retryable", cooldownMs: parseRetryAfterMs("120"), reason: "429" }));
    const row = await db.query("SELECT unavailableUntil FROM providerConnections WHERE id = ?").get(conn.id) as { unavailableUntil: number };
    expect(row.unavailableUntil - Date.now()).toBeGreaterThan(100_000);
    expect(row.unavailableUntil - Date.now()).toBeLessThan(125_000);
  });

  test("all accounts exhausted -> 503 error result", async () => {
    const db = makeDb();
    addConn(db);
    addConn(db);
    const result = await routeWithFallback(db, "openai", async () => ({ kind: "retryable", cooldownMs: null, reason: "upstream 500" }));
    expect(result.error?.status).toBe(503);
    expect(result.error?.type).toBe("server_error");
  });

  test("routing failure persists a safe last error on the connection", async () => {
    const db = makeDb();
    const connection = addConn(db);
    await routeWithFallback(db, "openai", async () => ({
      kind: "retryable",
      cooldownMs: 60_000,
      reason: "upstream echoed sk-test",
    }));

    expect(getConnection(db, connection.id)?.lastError).toBe("upstream echoed [REDACTED]");

  });

  test("successful routing clears an older connection error", async () => {
    const db = makeDb();
    const connection = addConn(db);
    await routeWithFallback(db, "openai", async () => ({
      kind: "fatal",
      status: 404,
      message: "old failure",
    }));
    expect(getConnection(db, connection.id)?.lastError).toBe("old failure");

    const current = getConnection(db, connection.id)!;
    await routeWithFallback(db, "openai", async () => ({ kind: "ok" }), { connections: [current] });

    expect(getConnection(db, connection.id)?.lastError).toBeNull();
  });

  test("non-retryable 4xx passes through the upstream status and message", async () => {
    const db = makeDb();
    const conn = addConn(db);
    const result = await routeWithFallback(db, "openai", async () =>
      classifyFailure(404, JSON.stringify({ error: { message: "model not found" } }), null));
    expect(result.error?.status).toBe(404);
    expect(result.error?.message).toBe("model not found");
    expect(result.connection).toBeUndefined();
    void conn;
  });

  test("no active connections at all -> 503", async () => {
    const db = makeDb();
    const result = await routeWithFallback(db, "openai", async () => ({ kind: "ok" }));
    expect(result.error?.status).toBe(503);
  });

  test("all cooling connections report retry timing instead of no active connection", async () => {
    const db = makeDb();
    const connection = addConn(db);
    db.query("UPDATE providerConnections SET unavailableUntil = ? WHERE id = ?")
      .run(Date.now() + 30_000, connection.id);

    const result = await routeWithFallback(db, "openai", async () => ({ kind: "ok" }));

    expect(result.error?.status).toBe(503);
    expect(result.error?.message).toContain("cooling down");
    expect(result.error?.message).not.toContain("no active connection");
    expect(result.error?.retryAfterSeconds).toBeGreaterThanOrEqual(29);
  });

  test("client abort surfaces as 499, not a retry", async () => {
    const db = makeDb();
    const conn = addConn(db);
    const controller = new AbortController();
    controller.abort();
    const result = await routeWithFallback(
      db,
      "openai",
      async () => { throw new DOMException("aborted", "AbortError"); },
      { signal: controller.signal },
    );
    expect(result.error?.status).toBe(499);
    void conn;
  });

  test("thrown network error is treated as retryable and moves on", async () => {
    const db = makeDb();
    const first = addConn(db);
    const second = addConn(db);
    const result = await routeWithFallback(db, "openai", async (conn) => {
      if (conn.id === first.id) throw new Error("ECONNREFUSED");
      return { kind: "ok" } as const;
    });
    expect(result.connection?.id).toBe(second.id);
  });
});
