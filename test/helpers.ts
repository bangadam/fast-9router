// Shared test helpers: temp SQLite database + migrated app per test.
// Admin helpers lazily log in with the default password once per App and
// cache the session cookie in a WeakMap. Tests that exercise unauthenticated
// behavior use `app.fetch` directly.

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

const sessionCookies = new WeakMap<App, Promise<string>>();

async function loginCookie(app: App): Promise<string> {
  const response = await app.fetch(new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-peer": "127.0.0.1" },
    body: JSON.stringify({ password: "123456" }),
  }));
  if (response.status !== 200) {
    throw new Error(`test login failed with status ${response.status}`);
  }
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("test login returned no session cookie");
  return setCookie.split(";")[0]!;
}

async function cookieFor(app: App): Promise<string> {
  let cookie = sessionCookies.get(app);
  if (cookie === undefined) {
    cookie = loginCookie(app).catch((error) => {
      sessionCookies.delete(app);
      throw error;
    });
    sessionCookies.set(app, cookie);
  }
  return cookie;
}

/** Reset the cached login (e.g. after a password change in a test). */
export function invalidateTestSession(app: App): void {
  sessionCookies.delete(app);
}

export async function adminGet(app: App, path: string, peer = "127.0.0.1"): Promise<Response> {
  const cookie = await cookieFor(app);
  return app.fetch(new Request(`http://localhost${path}`, { headers: { "x-test-peer": peer, cookie } }));
}

export async function adminJson(
  app: App,
  path: string,
  method: string,
  body?: unknown,
  peer = "127.0.0.1",
): Promise<Response> {
  const cookie = await cookieFor(app);
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json", "x-test-peer": peer, cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
