// Gateway auth matrix: enforcement on/off, multi-key Bearer/x-api-key
// handling, key lifecycle (create/rename/pause/delete), last-active conflict,
// secret hygiene, and non-loopback startup rejection (validateStartupConfig).
// Admin calls go through the session-authenticated test helpers.

import { describe, test, expect, afterEach } from "bun:test";
import { makeApp, adminJson, adminGet } from "./helpers.ts";
import { resolveOAuthAppOrigin, validateStartupConfig } from "../src/server.ts";
import type { Config } from "../src/config.ts";
import { createApp } from "../src/app.ts";

const baseConfig: Config = {
  host: "127.0.0.1",
  port: 20129,
  dataDir: "~/.fast-9router",
  logLevel: "info",
};

const contexts: Array<ReturnType<typeof makeApp>> = [];
function ctx() {
  const c = makeApp();
  contexts.push(c);
  return c;
}
afterEach(() => {
  while (contexts.length) contexts.pop()!.cleanup();
});

async function createKey(app: ReturnType<typeof makeApp>["app"], name: string): Promise<{ id: string; secret: string }> {
  const response = await adminJson(app, "/api/admin/gateway/keys", "POST", { name });
  expect(response.status).toBe(201);
  const body = await response.json() as { key: { id: string }; secret: string };
  return { id: body.key.id, secret: body.secret };
}

describe("gateway auth", () => {
  test("enforcement off: requests pass without a key", async () => {
    const { app } = ctx();
    const res = await app.fetch(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(200);
  });

  test("enforcement fails closed with zero active keys", async () => {
    const { app, db } = ctx();
    db.query("UPDATE settings SET gatewayEnforce = 1 WHERE id = 1").run();

    const response = await app.fetch(new Request("http://localhost/v1/models"));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.type).toBe("server_error");
  });

  test("enforcement cannot be enabled without an active key", async () => {
    const { app, db } = ctx();
    const response = await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });
    const settings = await (await adminJson(app, "/api/admin/gateway", "GET")).json();

    expect(response.status).toBe(400);
    expect(settings.enforce).toBe(false);
  });

  test("enforcement on: missing key rejected 401", async () => {
    const { app } = ctx();
    await createKey(app, "primary");
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });
    const res = await app.fetch(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("enforcement on: wrong key rejected 401", async () => {
    const { app } = ctx();
    await createKey(app, "primary");
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });
    const res = await app.fetch(
      new Request("http://localhost/v1/models", {
        headers: { authorization: "Bearer wrong-key-value" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("authorization requires the Bearer scheme", async () => {
    const { app } = ctx();
    const { secret } = await createKey(app, "primary");
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });

    const response = await app.fetch(new Request("http://localhost/v1/models", {
      headers: { authorization: secret },
    }));

    expect(response.status).toBe(401);
  });

  test("enforcement on: correct Bearer key passes", async () => {
    const { app } = ctx();
    const { secret } = await createKey(app, "primary");
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });
    const res = await app.fetch(
      new Request("http://localhost/v1/models", {
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  test("x-api-key header also authenticates", async () => {
    const { app } = ctx();
    const { secret } = await createKey(app, "primary");
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });
    const res = await app.fetch(
      new Request("http://localhost/v1/models", {
        headers: { "x-api-key": secret },
      }),
    );
    expect(res.status).toBe(200);
  });

  test("wrong Bearer wins over valid x-api-key", async () => {
    const { app } = ctx();
    const { secret } = await createKey(app, "primary");
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });
    const res = await app.fetch(
      new Request("http://localhost/v1/models", {
        headers: { authorization: "Bearer wrong-key-value", "x-api-key": secret },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("two keys authenticate independently; pausing one revokes only it", async () => {
    const { app } = ctx();
    const first = await createKey(app, "first");
    const second = await createKey(app, "second");
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });

    const pauseResponse = await adminJson(app, `/api/admin/gateway/keys/${first.id}`, "PATCH", { isActive: false });
    expect(pauseResponse.status).toBe(200);

    const paused = await app.fetch(new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${first.secret}` } }));
    expect(paused.status).toBe(401);
    const active = await app.fetch(new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${second.secret}` } }));
    expect(active.status).toBe(200);
  });

  test("deleting a key revokes only it", async () => {
    const { app } = ctx();
    const first = await createKey(app, "first");
    const second = await createKey(app, "second");
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });

    const deleteResponse = await adminJson(app, `/api/admin/gateway/keys/${first.id}`, "DELETE");
    expect(deleteResponse.status).toBe(204);

    const deleted = await app.fetch(new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${first.secret}` } }));
    expect(deleted.status).toBe(401);
    const remaining = await app.fetch(new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${second.secret}` } }));
    expect(remaining.status).toBe(200);
  });

  test("last-active key cannot be paused or deleted under enforcement", async () => {
    const { app } = ctx();
    const only = await createKey(app, "only");
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });

    const pauseResponse = await adminJson(app, `/api/admin/gateway/keys/${only.id}`, "PATCH", { isActive: false });
    expect(pauseResponse.status).toBe(409);
    const deleteResponse = await adminJson(app, `/api/admin/gateway/keys/${only.id}`, "DELETE");
    expect(deleteResponse.status).toBe(409);
  });

  test("CORS preflight bypasses gateway auth on every public API endpoint", async () => {
    const { app } = ctx();
    await createKey(app, "primary");
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });

    for (const path of ["/v1/models", "/v1/chat/completions", "/v1/responses", "/v1/messages"]) {
      const response = await app.fetch(new Request(`http://localhost${path}`, {
        method: "OPTIONS",
        headers: {
          origin: "https://client.example",
          "access-control-request-method": path === "/v1/models" ? "GET" : "POST",
          "access-control-request-headers": "authorization, content-type, x-api-key, x-9router-token-saver",
        },
      }));

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-allow-methods")).toContain("POST");
      expect(response.headers.get("access-control-allow-headers")).toContain("x-api-key");
      expect(response.headers.get("access-control-allow-headers")).toContain("x-9router-token-saver");
    }
  });

  test("dashboard model catalog remains available when public gateway auth is enforced", async () => {
    const { app } = ctx();
    await createKey(app, "primary");
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });

    const publicModels = await app.fetch(new Request("http://localhost/v1/models"));
    expect(publicModels.status).toBe(401);

    const dashboardModels = await adminJson(app, "/api/admin/models", "GET");
    expect(dashboardModels.status).toBe(200);
    expect(await dashboardModels.json()).toEqual({ object: "list", data: [] });
  });

  test("generated secrets never appear in list output or SQLite", async () => {
    const { app, db } = ctx();
    const { secret } = await createKey(app, "primary");

    const listResponse = await adminGet(app, "/api/admin/gateway");
    const text = await listResponse.text();
    expect(text).not.toContain(secret);
    const raw = JSON.stringify(
      (db.query("SELECT * FROM gatewayApiKeys").all() as Array<Record<string, unknown>>),
    );
    expect(raw).not.toContain(secret);
    expect(secret).toMatch(/^f9r_[A-Za-z0-9_-]{40,}$/);
    const body = (await new Response(text).json()) as { keys: Array<{ keyMasked: string; isActive: boolean }> };
    expect(body.keys[0]!.keyMasked).toMatch(/^f9r_.+••••.+$/);
    expect(body.keys[0]!.isActive).toBe(true);
  });

  test("key names are validated and case-insensitively unique", async () => {
    const { app } = ctx();
    await createKey(app, "Primary");
    const dup = await adminJson(app, "/api/admin/gateway/keys", "POST", { name: "primary" });
    expect(dup.status).toBe(409);
    const empty = await adminJson(app, "/api/admin/gateway/keys", "POST", { name: "   " });
    expect(empty.status).toBe(400);
    const control = await adminJson(app, "/api/admin/gateway/keys", "POST", { name: "bad\u0007name" });
    expect(control.status).toBe(400);
  });

  test("patch requires exactly name and/or isActive", async () => {
    const { app } = ctx();
    const { id } = await createKey(app, "primary");
    const none = await adminJson(app, `/api/admin/gateway/keys/${id}`, "PATCH", {});
    expect(none.status).toBe(400);
    const badActive = await adminJson(app, `/api/admin/gateway/keys/${id}`, "PATCH", { isActive: "yes" });
    expect(badActive.status).toBe(400);
    const missing = await adminJson(app, "/api/admin/gateway/keys/nonexistent", "PATCH", { name: "x" });
    expect(missing.status).toBe(404);
  });

  test("required enforcement cannot be disabled while a non-loopback listener is running", async () => {
    const { db } = ctx();
    const app = createApp(
      db,
      undefined,
      () => "127.0.0.1",
      undefined,
      { gatewayEnforcementRequired: true },
    );
    const { secret } = await (async () => {
      const response = await app.fetch(new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-peer": "127.0.0.1" },
        body: JSON.stringify({ password: "123456" }),
      }));
      const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      const createResponse = await app.fetch(new Request("http://localhost/api/admin/gateway/keys", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-peer": "127.0.0.1", cookie },
        body: JSON.stringify({ name: "primary" }),
      }));
      return await createResponse.json() as { key: { id: string }; secret: string };
    })();
    expect(secret).toBeTruthy();

    const cookieRequest = async (path: string, method: string, body?: unknown) => {
      const login = await app.fetch(new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-peer": "127.0.0.1" },
        body: JSON.stringify({ password: "123456" }),
      }));
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      return app.fetch(new Request(`http://localhost${path}`, {
        method,
        headers: { "content-type": "application/json", "x-test-peer": "127.0.0.1", cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      }));
    };
    await cookieRequest("/api/admin/gateway/enforce", "PUT", { enforce: true });
    const response = await cookieRequest("/api/admin/gateway/enforce", "PUT", { enforce: false });
    const settings = await (await cookieRequest("/api/admin/gateway", "GET")).json();

    expect(response.status).toBe(400);
    expect(settings.enforce).toBe(true);
    expect(settings.enforceRequired).toBe(true);
  });

  test("gateway keys never authorize admin routes", async () => {
    const { app } = ctx();
    const { secret } = await createKey(app, "primary");
    const response = await app.fetch(new Request("http://localhost/api/admin/status", {
      headers: { authorization: `Bearer ${secret}`, "x-test-peer": "127.0.0.1" },
    }));
    expect(response.status).toBe(401);
  });
});

describe("admin peer trust", () => {
  test("spoofed x-test-peer header cannot override the trusted socket peer", async () => {
    const { db } = ctx();
    const app = createApp(db, undefined, () => "203.0.113.10");
    const response = await app.fetch(new Request("http://localhost/api/admin/status", {
      headers: { "x-test-peer": "127.0.0.1" },
    }));

    expect(response.status).toBe(403);
  });

  test("admin access fails closed when no peer resolver is configured", async () => {
    const { db } = ctx();
    const app = createApp(db);
    const response = await app.fetch(new Request("http://localhost/api/admin/status"));

    expect(response.status).toBe(403);
  });
});

describe("non-loopback startup validation", () => {
  test("non-loopback bind with zero active keys is rejected", () => {
    const err = validateStartupConfig({ ...baseConfig, host: "0.0.0.0" }, 0);
    expect(err).not.toBeNull();
    expect(err!.message).toContain("0.0.0.0");
  });

  test("non-loopback bind with an active key but disabled enforcement is rejected", () => {
    const err = validateStartupConfig({ ...baseConfig, host: "0.0.0.0" }, 1, false);
    expect(err).not.toBeNull();
    expect(err!.message).toContain("enforcement");
  });

  test("non-loopback bind with an active key and enabled enforcement is accepted", () => {
    const err = validateStartupConfig({ ...baseConfig, host: "0.0.0.0" }, 1, true);
    expect(err).toBeNull();
  });

  test("loopback bind without keys is accepted", () => {
    expect(validateStartupConfig(baseConfig, 0)).toBeNull();
    expect(validateStartupConfig({ ...baseConfig, host: "localhost" }, 0)).toBeNull();
    expect(validateStartupConfig({ ...baseConfig, host: "::1" }, 0)).toBeNull();
  });

  test("empty and wildcard bind hosts require authentication", () => {
    for (const host of ["", "0.0.0.0", "::"]) {
      const error = validateStartupConfig({ ...baseConfig, host }, 0, false);
      expect(error).not.toBeNull();
    }
  });

  test("the complete IPv4 loopback range is accepted", () => {
    expect(validateStartupConfig({ ...baseConfig, host: "127.0.0.2" }, 0)).toBeNull();
    expect(validateStartupConfig({ ...baseConfig, host: "127.255.255.254" }, 0)).toBeNull();
  });

  test("invalid port is rejected", () => {
    expect(validateStartupConfig({ ...baseConfig, port: 0 }, 0)).not.toBeNull();
    expect(validateStartupConfig({ ...baseConfig, port: 70000 }, 0)).not.toBeNull();
  });
});

describe("OAuth application origin", () => {
  test("uses the configured alternate IPv4 loopback address", () => {
    expect(resolveOAuthAppOrigin({ ...baseConfig, host: "127.0.0.2" }))
      .toBe("http://127.0.0.2:20129");
    expect(resolveOAuthAppOrigin({ ...baseConfig, host: "localhost" }))
      .toBe("http://localhost:20129");
  });

  test("formats the IPv6 loopback address as a valid URL origin", () => {
    expect(resolveOAuthAppOrigin({ ...baseConfig, host: "::1" }))
      .toBe("http://[::1]:20129");
  });
  test("uses loopback to reach wildcard listeners", () => {
    expect(resolveOAuthAppOrigin({ ...baseConfig, host: "" })).toBe("http://127.0.0.1:20129");
    expect(resolveOAuthAppOrigin({ ...baseConfig, host: "0.0.0.0" })).toBe("http://127.0.0.1:20129");
    expect(resolveOAuthAppOrigin({ ...baseConfig, host: "::" })).toBe("http://[::1]:20129");
  });
});
