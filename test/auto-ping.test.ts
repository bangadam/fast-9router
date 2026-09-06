import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAutoPingTick } from "../src/auto-ping.ts";
import { createConnection, getConnection, migrate, openDatabase, recordConnectionError, type Database } from "../src/db.ts";
import { Logger } from "../src/log.ts";
import { routeGenerationRequest } from "../src/router/pipeline.ts";

const databases: Database[] = [];
function database(): Database {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "fast9r-autoping-")), "test.db"));
  migrate(db);
  databases.push(db);
  return db;
}
afterEach(() => { while (databases.length) databases.pop()!.close(); });

describe("reset-aware auto-ping", () => {
  test("pings an opted-in connection exactly once after its observed cooldown expires", async () => {
    const db = database();
    const resetAt = 2_000;
    const connection = createConnection(db, {
      provider: "openai", name: "warm", data: { apiKey: "key", baseUrl: "https://example.test/v1", prefix: "px", models: ["m1"], autoPing: true },
    });
    recordConnectionError(db, connection.id, "upstream 429", resetAt);
    const calls: Array<{ model: unknown; ids: readonly number[] | undefined; tokenSaverEnabled?: boolean }> = [];
    const route: typeof routeGenerationRequest = async (_db, _logger, _endpoint, body, options) => {
      calls.push({ model: body.model, ids: options?.onlyConnectionIds, tokenSaverEnabled: options?.tokenSaverEnabled });
      return Response.json({ ok: true });
    };

    await runAutoPingTick(db, new Logger("error"), 1_000, 1_999, route);
    await runAutoPingTick(db, new Logger("error"), 1_000, 2_000, route);
    await runAutoPingTick(db, new Logger("error"), 1_000, 3_000, route);

    expect(calls).toEqual([{ model: "px/m1", ids: [connection.id], tokenSaverEnabled: false }]);
    expect(getConnection(db, connection.id)?.unavailableUntil).toBeNull();
    expect(getConnection(db, connection.id)?.data.autoPing).toBe(true);
  });

  test("does not replay cooldowns observed before scheduler startup", async () => {
    const db = database();
    const connection = createConnection(db, {
      provider: "codex", name: "old", data: { accessToken: "token", autoPing: true },
    });
    recordConnectionError(db, connection.id, "upstream 429", 900);
    let calls = 0;
    const route: typeof routeGenerationRequest = async () => { calls++; return Response.json({ ok: true }); };

    await runAutoPingTick(db, new Logger("error"), 1_000, 2_000, route);

    expect(calls).toBe(0);
  });

  test("disables auto-ping after one failed reset request", async () => {
    const db = database();
    const connection = createConnection(db, {
      provider: "anthropic", name: "broken", data: { apiKey: "key", models: ["claude-haiku-4-5"], autoPing: true },
    });
    recordConnectionError(db, connection.id, "upstream 429", 2_000);
    const route: typeof routeGenerationRequest = async () => Response.json({ error: true }, { status: 503 });

    await runAutoPingTick(db, new Logger("error"), 1_000, 2_000, route);

    expect(getConnection(db, connection.id)?.data.autoPing).toBe(false);
    expect(getConnection(db, connection.id)?.unavailableUntil).toBeNull();
  });
});
