// Shared test helpers: temp SQLite database + migrated app per test.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import type { Database } from "bun:sqlite";
import type { App } from "../src/app.ts";

export interface TestContext {
  app: App;
  db: Database;
  cleanup: () => void;
}

export function makeApp(): TestContext {
  const dir = mkdtempSync(join(tmpdir(), "fast-9router-test-"));
  const db = openDatabase(join(dir, "test.db"));
  migrate(db);
  const app = createApp(
    db,
    undefined,
    (context) => context.req.header("x-test-peer") ?? "127.0.0.1",
  );
  return {
    app,
    db,
    cleanup: () => {
      db.close();
    },
  };
}

/** Injected peer consumed only by this test-only resolver. */
export function withPeer(request: Request, peer: string): Request {
  return new Request(request, { headers: { "x-test-peer": peer } });
}

export function adminGet(app: App, path: string, peer = "127.0.0.1"): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`http://localhost${path}`, { headers: { "x-test-peer": peer } })));
}

export function adminJson(
  app: App,
  path: string,
  method: string,
  body?: unknown,
  peer = "127.0.0.1",
): Promise<Response> {
  return Promise.resolve(app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json", "x-test-peer": peer },
      body: body === undefined ? undefined : JSON.stringify(body),
    })),
  );
}
