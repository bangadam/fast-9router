// Dashboard auth: login/logout/status, default password, lockout, password
// change with session revocation, and loopback-only enforcement.

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { makeApp } from "./helpers.ts";
import { resetLoginLimiter } from "../src/auth.ts";

beforeEach(() => resetLoginLimiter());

const contexts: Array<ReturnType<typeof makeApp>> = [];
function ctx() {
  const c = makeApp();
  contexts.push(c);
  return c;
}
afterEach(() => {
  while (contexts.length) contexts.pop()!.cleanup();
});

async function login(app: ReturnType<typeof makeApp>["app"], password: string, peer = "127.0.0.1"): Promise<Response> {
  return app.fetch(new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-peer": peer },
    body: JSON.stringify({ password }),
  }));
}

function cookieOf(response: Response): string {
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

describe("auth status", () => {
  test("unauthenticated status reports default password in use", async () => {
    const { app } = ctx();
    const response = await app.fetch(new Request("http://localhost/api/auth/status"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({ authenticated: false, hasPassword: false, usesDefaultPassword: true, expiresAt: null });
  });

  test("authenticated status reports the session expiry", async () => {
    const { app } = ctx();
    const cookie = cookieOf(await login(app, "123456"));
    const response = await app.fetch(new Request("http://localhost/api/auth/status", { headers: { cookie } }));
    const body = await response.json();
    expect(body.authenticated).toBe(true);
    expect(body.hasPassword).toBe(false);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  test("expired session cookie reports unauthenticated and prunes the row", async () => {
    const { app, db } = ctx();
    const cookie = cookieOf(await login(app, "123456"));
    db.query("UPDATE dashboardSessions SET expiresAt = 1").run();
    const response = await app.fetch(new Request("http://localhost/api/auth/status", { headers: { cookie } }));
    const body = await response.json();
    expect(body.authenticated).toBe(false);
    const rows = db.query("SELECT COUNT(*) AS n FROM dashboardSessions").get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

describe("auth login", () => {
  test("default password 123456 succeeds while no password is set", async () => {
    const { app } = ctx();
    const response = await login(app, "123456");
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain("fast9r_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Max-Age=86400");
    const body = await response.json();
    expect(body.authenticated).toBe(true);
  });

  test("malformed body is 400", async () => {
    const { app } = ctx();
    const response = await app.fetch(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-peer": "127.0.0.1" },
      body: JSON.stringify({}),
    }));
    expect(response.status).toBe(400);
  });

  test("wrong password is 401 with a generic message", async () => {
    const { app } = ctx();
    const response = await login(app, "wrong-password");
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.message).toBe("invalid password");
  });

  test("fifth failure arms the lock; the next attempt gets 429 with Retry-After", async () => {
    const { app } = ctx();
    for (let i = 0; i < 5; i++) {
      expect((await login(app, "nope")).status).toBe(401);
    }
    const locked = await login(app, "nope");
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    // Even the correct password is rejected while locked.
    expect((await login(app, "123456")).status).toBe(429);
  });

  test("success clears the lockout", async () => {
    const { app } = ctx();
    for (let i = 0; i < 3; i++) await login(app, "nope");
    expect((await login(app, "123456")).status).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect((await login(app, "nope")).status).toBe(401);
    }
    // Failures reset on success: the sixth attempt is locked out.
    expect((await login(app, "nope")).status).toBe(429);
  });

  test("non-loopback peers cannot log in", async () => {
    const { app } = ctx();
    const response = await login(app, "123456", "203.0.113.5");
    expect(response.status).toBe(403);
  });
});

describe("auth logout", () => {
  test("logout is idempotent and revokes the presented session", async () => {
    const { app } = ctx();
    const cookie = cookieOf(await login(app, "123456"));
    const first = await app.fetch(new Request("http://localhost/api/auth/logout", { method: "POST", headers: { cookie } }));
    expect(first.status).toBe(204);
    const second = await app.fetch(new Request("http://localhost/api/auth/logout", { method: "POST", headers: { cookie } }));
    expect(second.status).toBe(204);

    const adminResponse = await app.fetch(new Request("http://localhost/api/admin/status", { headers: { cookie, "x-test-peer": "127.0.0.1" } }));
    expect(adminResponse.status).toBe(401);
  });
});

describe("admin session enforcement", () => {
  test("raw admin request without a session is 401", async () => {
    const { app } = ctx();
    const response = await app.fetch(new Request("http://localhost/api/admin/status", { headers: { "x-test-peer": "127.0.0.1" } }));
    expect(response.status).toBe(401);
  });

  test("valid session cookie unlocks admin routes", async () => {
    const { app } = ctx();
    const cookie = cookieOf(await login(app, "123456"));
    const response = await app.fetch(new Request("http://localhost/api/admin/status", { headers: { cookie, "x-test-peer": "127.0.0.1" } }));
    expect(response.status).toBe(200);
  });

  test("cross-origin non-loopback requests remain 403 even with a session", async () => {
    const { app } = ctx();
    const cookie = cookieOf(await login(app, "123456"));
    const response = await app.fetch(new Request("http://localhost/api/admin/status", {
      headers: { cookie, origin: "https://attacker.example", "x-test-peer": "127.0.0.1" },
    }));
    expect(response.status).toBe(403);
  });
});

describe("password change", () => {
  test("requires the current password and 8-256 byte new password", async () => {
    const { app } = ctx();
    const cookie = cookieOf(await login(app, "123456"));
    const request = (body: unknown) => app.fetch(new Request("http://localhost/api/admin/profile/password", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie, "x-test-peer": "127.0.0.1" },
      body: JSON.stringify(body),
    }));

    expect((await request({ currentPassword: "wrong", newPassword: "new-password-1" })).status).toBe(401);
    expect((await request({ currentPassword: "123456", newPassword: "short" })).status).toBe(400);
    expect((await request({ currentPassword: "123456", newPassword: "x".repeat(257) })).status).toBe(400);
  });

  test("change keeps this browser and revokes a second session", async () => {
    const { app } = ctx();
    const firstCookie = cookieOf(await login(app, "123456"));
    const secondCookie = cookieOf(await login(app, "123456"));

    const response = await app.fetch(new Request("http://localhost/api/admin/profile/password", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: firstCookie, "x-test-peer": "127.0.0.1" },
      body: JSON.stringify({ currentPassword: "123456", newPassword: "new-password-1" }),
    }));
    expect(response.status).toBe(200);
    const replacementCookie = cookieOf(response);

    // This browser stays authenticated via the replacement session.
    const stillOk = await app.fetch(new Request("http://localhost/api/admin/status", { headers: { cookie: replacementCookie, "x-test-peer": "127.0.0.1" } }));
    expect(stillOk.status).toBe(200);

    // The other browser's session is revoked.
    const revoked = await app.fetch(new Request("http://localhost/api/admin/status", { headers: { cookie: secondCookie, "x-test-peer": "127.0.0.1" } }));
    expect(revoked.status).toBe(401);

    // Old default password no longer works; new one does.
    expect((await login(app, "123456")).status).toBe(401);
    expect((await login(app, "new-password-1")).status).toBe(200);
  });
});
