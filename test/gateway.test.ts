// Gateway auth matrix: enforcement on/off, key correct/incorrect/absent,
// and non-loopback startup rejection (validateStartupConfig).

import { describe, test, expect, afterEach } from "bun:test";
import { makeApp, adminJson } from "./helpers.ts";
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

describe("gateway auth", () => {
  test("enforcement off: requests pass without a key", async () => {
    const { app } = ctx();
    const res = await app.fetch(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(200);
  });

  test("enforcement fails closed when persisted key is empty", async () => {
    const { app, db } = ctx();
    db.query("UPDATE settings SET gatewayEnforce = 1, gatewayKey = '' WHERE id = 1").run();

    const response = await app.fetch(new Request("http://localhost/v1/models"));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.type).toBe("server_error");
  });

  test("enforcement fails closed when persisted key is too short", async () => {
    const { app, db } = ctx();
    db.query("UPDATE settings SET gatewayEnforce = 1, gatewayKey = 'x' WHERE id = 1").run();

    const response = await app.fetch(new Request("http://localhost/v1/models", {
      headers: { authorization: "Bearer x" },
    }));

    expect(response.status).toBe(503);
  });

  test("malformed persisted key cannot enable enforcement", async () => {
    const { app, db } = ctx();
    db.query("UPDATE settings SET gatewayKey = 'x' WHERE id = 1").run();

    const response = await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });
    const settings = await (await adminJson(app, "/api/admin/gateway", "GET")).json();

    expect(response.status).toBe(400);
    expect(settings.enforce).toBe(false);
    expect(settings.keyConfigured).toBe(false);
  });

  test("enforcement on with key: missing key rejected 401", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/gateway/key", "PUT", { key: "test-gateway-key-123" });
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });
    const res = await app.fetch(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("enforcement on with key: wrong key rejected 401", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/gateway/key", "PUT", { key: "test-gateway-key-123" });
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });
    const res = await app.fetch(
      new Request("http://localhost/v1/models", {
        headers: { authorization: "Bearer wrong-key" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("authorization requires the Bearer scheme", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/gateway/key", "PUT", { key: "test-gateway-key-123" });
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });

    const response = await app.fetch(new Request("http://localhost/v1/models", {
      headers: { authorization: "test-gateway-key-123" },
    }));

    expect(response.status).toBe(401);
  });

  test("enforcement on with key: correct Bearer key passes", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/gateway/key", "PUT", { key: "test-gateway-key-123" });
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });
    const res = await app.fetch(
      new Request("http://localhost/v1/models", {
        headers: { authorization: "Bearer test-gateway-key-123" },
      }),
    );
    expect(res.status).toBe(200);
  });

  test("CORS preflight bypasses gateway auth on every public API endpoint", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/gateway/key", "PUT", { key: "test-gateway-key-123" });
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });

    for (const path of ["/v1/models", "/v1/chat/completions", "/v1/responses", "/v1/messages"]) {
      const response = await app.fetch(new Request(`http://localhost${path}`, {
        method: "OPTIONS",
        headers: {
          origin: "https://client.example",
          "access-control-request-method": path === "/v1/models" ? "GET" : "POST",
          "access-control-request-headers": "authorization, content-type",
        },
      }));

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-allow-methods")).toContain("POST");
      expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
    }
  });

  test("authenticated API errors include CORS response headers", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/gateway/key", "PUT", { key: "test-gateway-key-123" });
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });

    const response = await app.fetch(new Request("http://localhost/v1/models", {
      headers: { origin: "https://client.example" },
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("dashboard model catalog remains available when public gateway auth is enforced", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/gateway/key", "PUT", { key: "test-gateway-key-123" });
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });

    const publicModels = await app.fetch(new Request("http://localhost/v1/models"));
    expect(publicModels.status).toBe(401);

    const dashboardModels = await adminJson(app, "/api/admin/models", "GET");
    expect(dashboardModels.status).toBe(200);
    expect(await dashboardModels.json()).toEqual({ object: "list", data: [] });
  });

  test("key rotation: old key rejected, new key accepted", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/gateway/key", "PUT", { key: "first-gateway-key-1" });
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });
    await adminJson(app, "/api/admin/gateway/key", "PUT", { key: "second-gateway-key" });
    const oldRes = await app.fetch(
      new Request("http://localhost/v1/models", {
        headers: { authorization: "Bearer first-gateway-key-1" },
      }),
    );
    expect(oldRes.status).toBe(401);
    const newRes = await app.fetch(
      new Request("http://localhost/v1/models", {
        headers: { authorization: "Bearer second-gateway-key" },
      }),
    );
    expect(newRes.status).toBe(200);
  });

  test("gateway key must not be returned in full by the admin API", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/gateway/key", "PUT", { key: "test-gateway-key-123" });
    const res = await adminJson(app, "/api/admin/gateway", "GET");
    const text = await res.text();
    expect(text).not.toContain("test-gateway-key-123");
    const body = (await new Response(text).json()) as { keyMasked: string | null; keyConfigured: boolean };
    expect(body.keyConfigured).toBe(true);
    expect(body.keyMasked).toMatch(/^\*+$/);
  });

  test("gateway key minimum length is checked after normalization", async () => {
    const { app } = ctx();
    const response = await adminJson(app, "/api/admin/gateway/key", "PUT", {
      key: "       x",
    });

    expect(response.status).toBe(400);
    const settings = await (await adminJson(app, "/api/admin/gateway", "GET")).json();
    expect(settings.keyConfigured).toBe(false);
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
    await adminJson(app, "/api/admin/gateway/key", "PUT", { key: "test-gateway-key-123" });
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });

    const response = await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: false });
    const settings = await (await adminJson(app, "/api/admin/gateway", "GET")).json();

    expect(response.status).toBe(400);
    expect(settings.enforce).toBe(true);
    expect(settings.enforceRequired).toBe(true);
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
  test("non-loopback bind with empty gateway key is rejected", () => {
    const err = validateStartupConfig({ ...baseConfig, host: "0.0.0.0" }, "");
    expect(err).not.toBeNull();
    expect(err!.message).toContain("0.0.0.0");
  });

  test("non-loopback bind with a key but disabled enforcement is rejected", () => {
    const err = validateStartupConfig({ ...baseConfig, host: "0.0.0.0" }, "some-key", false);
    expect(err).not.toBeNull();
    expect(err!.message).toContain("enforcement");
  });

  test("non-loopback bind with a key and enabled enforcement is accepted", () => {
    const err = validateStartupConfig({ ...baseConfig, host: "0.0.0.0" }, "some-key", true);
    expect(err).toBeNull();
  });

  test("non-loopback bind rejects an enforced but too-short key", () => {
    const error = validateStartupConfig({ ...baseConfig, host: "0.0.0.0" }, "x", true);

    expect(error).not.toBeNull();
    expect(error!.message).toContain("gateway API key");
  });

  test("loopback bind without a key is accepted", () => {
    expect(validateStartupConfig(baseConfig, "")).toBeNull();
    expect(validateStartupConfig({ ...baseConfig, host: "localhost" }, "")).toBeNull();
    expect(validateStartupConfig({ ...baseConfig, host: "::1" }, "")).toBeNull();
  });

  test("empty and wildcard bind hosts require authentication", () => {
    for (const host of ["", "0.0.0.0", "::"]) {
      const error = validateStartupConfig({ ...baseConfig, host }, "", false);
      expect(error).not.toBeNull();
    }
  });

  test("the complete IPv4 loopback range is accepted", () => {
    expect(validateStartupConfig({ ...baseConfig, host: "127.0.0.2" }, "")).toBeNull();
    expect(validateStartupConfig({ ...baseConfig, host: "127.255.255.254" }, "")).toBeNull();
  });

  test("invalid port is rejected", () => {
    expect(validateStartupConfig({ ...baseConfig, port: 0 }, "")).not.toBeNull();
    expect(validateStartupConfig({ ...baseConfig, port: 70000 }, "")).not.toBeNull();
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
