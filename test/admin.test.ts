// Admin API: connections CRUD with secret masking, activate/deactivate,
// priority, aliases CRUD, and non-loopback admin rejection.

import { describe, test, expect, afterEach } from "bun:test";
import { makeApp, adminGet, adminJson } from "./helpers.ts";

import type { App } from "../src/app.ts";

async function testSessionCookie(app: App): Promise<string> {
  const login = await app.fetch(new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-peer": "127.0.0.1" },
    body: JSON.stringify({ password: "123456" }),
  }));
  return login.headers.get("set-cookie")!.split(";")[0]!;
}

const contexts: Array<ReturnType<typeof makeApp>> = [];
function ctx() {
  const c = makeApp();
  contexts.push(c);
  return c;
}
afterEach(() => {
  while (contexts.length) contexts.pop()!.cleanup();
});

const OA_CONN = {
  provider: "openai",
  name: "official",
  data: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-secret-value-123", prefix: "oa", models: ["gpt-5.4"] },
};

describe("admin connections CRUD", () => {
  test("create returns masked apiKey, never the secret", async () => {
    const { app } = ctx();
    const res = await adminJson(app, "/api/admin/connections", "POST", OA_CONN);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("sk-secret-value-123");
    expect(body.connection.data.apiKey).toBe("********");
    expect(body.connection.data.baseUrl).toBe("https://api.openai.com/v1");
  });

  test("active connection without credentials reports not routable", async () => {
    const { app } = ctx();
    const response = await adminJson(app, "/api/admin/connections", "POST", {
      provider: "anthropic",
      name: "missing-key",
      data: {},
    });
    const body = await response.json();

    expect(body.connection.isActive).toBe(true);
    expect(body.connection.routable).toBe(false);
  });

  test("credentialed active connection reports routable", async () => {
    const { app } = ctx();
    const response = await adminJson(app, "/api/admin/connections", "POST", OA_CONN);
    const body = await response.json();

    expect(body.connection.routable).toBe(true);
  });

  test("list and get return masked secrets", async () => {
    const { app } = ctx();
    const created = await (await adminJson(app, "/api/admin/connections", "POST", OA_CONN)).json();
    const id = created.connection.id;
    const listRes = await adminGet(app, "/api/admin/connections");
    const listBody = await listRes.json();
    expect(JSON.stringify(listBody)).not.toContain("sk-secret-value-123");
    const getRes = await adminGet(app, `/api/admin/connections/${id}`);
    const getBody = await getRes.json();
    expect(JSON.stringify(getBody)).not.toContain("sk-secret-value-123");
  });

  test("admin returns safe last error without exposing health version", async () => {
    const { app, db } = ctx();
    const created = await (await adminJson(app, "/api/admin/connections", "POST", OA_CONN)).json();
    db.query("UPDATE providerConnections SET lastError = 'upstream 503', healthVersion = 2 WHERE id = ?")
      .run(created.connection.id);

    const response = await adminGet(app, `/api/admin/connections/${created.connection.id}`);
    const text = await response.text();
    const body = JSON.parse(text);

    expect(body.connection.lastError).toBe("upstream 503");
    expect(text).not.toContain("healthVersion");
  });

  test("patch without apiKey keeps the stored secret", async () => {
    const { app } = ctx();
    const created = await (await adminJson(app, "/api/admin/connections", "POST", OA_CONN)).json();
    const id = created.connection.id;
    const res = await adminJson(app, `/api/admin/connections/${id}`, "PATCH", { name: "renamed" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connection.name).toBe("renamed");
    expect(body.connection.data.apiKey).toBe("********");
  });

  test("patching a masked response preserves the stored API key", async () => {
    const { app, db } = ctx();
    const created = await (await adminJson(app, "/api/admin/connections", "POST", OA_CONN)).json();
    const id = created.connection.id;

    const response = await adminJson(app, `/api/admin/connections/${id}`, "PATCH", {
      name: "round-tripped",
      data: created.connection.data,
    });


    expect(response.status).toBe(200);
    const stored = db.query("SELECT json_extract(data, '$.apiKey') AS apiKey FROM providerConnections WHERE id = ?").get(id);
    expect(stored).toEqual({ apiKey: "sk-secret-value-123" });
  });
  test("patch cannot change provider or carry its secrets into another adapter", async () => {
    const { app, db } = ctx();
    const created = await (await adminJson(app, "/api/admin/connections", "POST", OA_CONN)).json();

    const response = await adminJson(app, `/api/admin/connections/${created.connection.id}`, "PATCH", {
      provider: "anthropic",
      name: "mutated",
    });

    expect(response.status).toBe(400);
    const stored = db.query("SELECT provider, name, json_extract(data, '$.apiKey') AS apiKey, json_extract(data, '$.prefix') AS prefix FROM providerConnections WHERE id = ?")
      .get(created.connection.id);
    expect(stored).toEqual({
      provider: "openai",
      name: "official",
      apiKey: "sk-secret-value-123",
      prefix: "oa",
    });
  });

  test("patch may repeat the existing provider", async () => {
    const { app } = ctx();
    const created = await (await adminJson(app, "/api/admin/connections", "POST", OA_CONN)).json();

    const response = await adminJson(app, `/api/admin/connections/${created.connection.id}`, "PATCH", {
      provider: "openai",
      name: "renamed",
    });

    expect(response.status).toBe(200);
  });

  test("masked sentinel cannot be created as an API key", async () => {
    const { app } = ctx();
    const response = await adminJson(app, "/api/admin/connections", "POST", {
      ...OA_CONN,
      data: { ...OA_CONN.data, apiKey: "********" },
    });

    expect(response.status).toBe(400);
  });

  test("patch with explicit null clears the stored API key without exposing it", async () => {
    const { app, db } = ctx();
    const created = await (await adminJson(app, "/api/admin/connections", "POST", OA_CONN)).json();
    const id = created.connection.id;

    const response = await adminJson(app, `/api/admin/connections/${id}`, "PATCH", {
      data: { apiKey: null },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.connection.data.apiKey).toBeUndefined();
    const stored = db.query("SELECT json_extract(data, '$.apiKey') AS apiKey FROM providerConnections WHERE id = ?").get(id);
    expect(stored).toEqual({ apiKey: null });
    expect(JSON.stringify(body)).not.toContain("sk-secret-value-123");
  });

  test("all Codex OAuth tokens stay absent from admin responses", async () => {
    const { app } = ctx();
    const response = await adminJson(app, "/api/admin/connections", "POST", {
      provider: "codex",
      name: "codex",
      data: {
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        idToken: "id-secret",
        accountId: "account-1",
        expiresAt: 123,
      },
    });

    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain("access-secret");
    expect(text).not.toContain("refresh-secret");
    expect(text).not.toContain("id-secret");
    expect(text).toContain("account-1");
  });

  test("create rejects credential fields belonging to another provider", async () => {
    const { app } = ctx();
    const anthropic = await adminJson(app, "/api/admin/connections", "POST", {
      provider: "anthropic",
      name: "anthropic",
      data: { apiKey: "anthropic-key", refreshToken: "foreign-refresh-secret" },
    });
    const codex = await adminJson(app, "/api/admin/connections", "POST", {
      provider: "codex",
      name: "codex",
      data: { accessToken: "codex-access", apiKey: "foreign-api-key" },
    });

    expect(anthropic.status).toBe(400);
    expect(codex.status).toBe(400);
  });

  test("patch rejects foreign fields and leaves stored data unchanged", async () => {
    const { app, db } = ctx();
    const created = await (await adminJson(app, "/api/admin/connections", "POST", OA_CONN)).json();

    const response = await adminJson(app, `/api/admin/connections/${created.connection.id}`, "PATCH", {
      data: { refreshToken: "foreign-refresh-secret" },
    });

    expect(response.status).toBe(400);
    const stored = db.query("SELECT json_extract(data, '$.refreshToken') AS refreshToken, json_extract(data, '$.apiKey') AS apiKey FROM providerConnections WHERE id = ?")
      .get(created.connection.id);
    expect(stored).toEqual({ refreshToken: null, apiKey: "sk-secret-value-123" });
  });

  test("valid patch purges legacy foreign provider fields", async () => {
    const { app, db } = ctx();
    const created = await (await adminJson(app, "/api/admin/connections", "POST", OA_CONN)).json();
    db.query("UPDATE providerConnections SET data = json_set(data, '$.refreshToken', 'legacy-secret') WHERE id = ?")
      .run(created.connection.id);

    const response = await adminJson(app, `/api/admin/connections/${created.connection.id}`, "PATCH", { name: "cleaned" });

    expect(response.status).toBe(200);
    const stored = db.query("SELECT json_extract(data, '$.refreshToken') AS refreshToken FROM providerConnections WHERE id = ?")
      .get(created.connection.id);
    expect(stored).toEqual({ refreshToken: null });
  });

  test("masked response data remains provider-specific and round-trippable", async () => {
    const { app, db } = ctx();
    const anthropic = await (await adminJson(app, "/api/admin/connections", "POST", {
      provider: "anthropic",
      name: "anthropic",
      data: { apiKey: "anthropic-secret", baseUrl: "https://api.anthropic.com/v1/messages" },
    })).json();
    const codex = await (await adminJson(app, "/api/admin/connections", "POST", {
      provider: "codex",
      name: "codex",
      data: { accessToken: "access-secret", refreshToken: "refresh-secret", expiresAt: Date.now() + 3600_000, accountId: "account-1" },
    })).json();

    expect(anthropic.connection.data.models).toEqual([]);
    expect(anthropic.connection.data.accountId).toBeUndefined();
    expect(codex.connection.data.models).toEqual([]);
    expect(codex.connection.data.apiKey).toBeUndefined();
    expect((await adminJson(app, `/api/admin/connections/${anthropic.connection.id}`, "PATCH", { data: anthropic.connection.data })).status).toBe(200);
    expect((await adminJson(app, `/api/admin/connections/${codex.connection.id}`, "PATCH", { data: codex.connection.data })).status).toBe(200);
    const tokens = db.query("SELECT json_extract(data, '$.accessToken') AS accessToken, json_extract(data, '$.refreshToken') AS refreshToken FROM providerConnections WHERE id = ?")
      .get(codex.connection.id);
    expect(tokens).toEqual({ accessToken: "access-secret", refreshToken: "refresh-secret" });
  });

  test("auto-ping toggle preserves an observed cooldown", async () => {
    const { app, db } = ctx();
    const created = await (await adminJson(app, "/api/admin/connections", "POST", OA_CONN)).json();
    const until = Date.now() + 60_000;
    db.query("UPDATE providerConnections SET unavailableUntil = ?, lastError = 'upstream 429' WHERE id = ?").run(until, created.connection.id);

    const response = await adminJson(app, `/api/admin/connections/${created.connection.id}`, "PATCH", { data: { autoPing: true } });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.connection.data.autoPing).toBe(true);
    expect(body.connection.unavailableUntil).toBe(until);
    expect(body.connection.lastError).toBe("upstream 429");
  });

  test("deactivate and activate toggle isActive", async () => {
    const { app } = ctx();
    const created = await (await adminJson(app, "/api/admin/connections", "POST", OA_CONN)).json();
    const id = created.connection.id;
    const off = await (await adminJson(app, `/api/admin/connections/${id}/deactivate`, "POST")).json();
    expect(off.connection.isActive).toBe(false);
    const on = await (await adminJson(app, `/api/admin/connections/${id}/activate`, "POST")).json();
    expect(on.connection.isActive).toBe(true);
  });

  test("priority is persisted", async () => {
    const { app } = ctx();
    const created = await (await adminJson(app, "/api/admin/connections", "POST", { ...OA_CONN, priority: 5 })).json();
    expect(created.connection.priority).toBe(5);
  });

  test("delete removes the connection", async () => {
    const { app } = ctx();
    const created = await (await adminJson(app, "/api/admin/connections", "POST", OA_CONN)).json();
    const id = created.connection.id;
    const del = await adminJson(app, `/api/admin/connections/${id}`, "DELETE");
    expect(del.status).toBe(204);
    const missing = await adminGet(app, `/api/admin/connections/${id}`);
    expect(missing.status).toBe(404);
  });

  test("invalid provider rejected", async () => {
    const { app } = ctx();
    const res = await adminJson(app, "/api/admin/connections", "POST", { ...OA_CONN, provider: "mistral" });
    expect(res.status).toBe(400);
  });

  test("connection scalar fields reject coercible but invalid JSON types", async () => {
    const { app } = ctx();
    const invalidBodies = [
      { ...OA_CONN, priority: "1" },
      { ...OA_CONN, priority: 1.5 },
      { ...OA_CONN, isActive: "false" },
      { ...OA_CONN, data: { ...OA_CONN.data, prefix: 123 } },
      { ...OA_CONN, data: { ...OA_CONN.data, baseUrl: ["https://api.openai.com/v1"] } },
    ];

    for (const body of invalidBodies) {
      const response = await adminJson(app, "/api/admin/connections", "POST", body);
      expect(response.status).toBe(400);
    }
  });

  test("manual models require a string array with non-empty entries", async () => {
    const { app } = ctx();
    const invalidModels = [
      "glm-5.3",
      { id: "glm-5.3" },
      ["glm-5.3", 5],
      ["glm-5.3", "   "],
    ];

    for (const models of invalidModels) {
      const response = await adminJson(app, "/api/admin/connections", "POST", {
        ...OA_CONN,
        data: { ...OA_CONN.data, models },
      });
      expect(response.status).toBe(400);
    }
  });

  test("manual models are trimmed and deduplicated before persistence", async () => {
    const { app } = ctx();
    const response = await adminJson(app, "/api/admin/connections", "POST", {
      ...OA_CONN,
      data: {
        ...OA_CONN.data,
        prefix: "clean",
        models: [" glm-5.3 ", "glm-5.3", " vendor/model "],
      },
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.connection.data.models).toEqual(["glm-5.3", "vendor/model"]);
  });

  test("malformed base URL rejected", async () => {
    const { app } = ctx();
    for (const bad of [
      "ftp://example.com/v1",
      "https://user:pass@example.com/v1",
      "https://example.com/v1#frag",
      "https://example.com/v1?q=1",
      "not-a-url",
    ]) {
      const res = await adminJson(app, "/api/admin/connections", "POST", {
        ...OA_CONN,
        data: { ...OA_CONN.data, baseUrl: bad },
      });
      if (res.status !== 400) throw new Error(`expected 400 for baseUrl ${bad}, got ${res.status}`);
    }
  });

  test("local base URLs are allowed", async () => {
    const { app } = ctx();
    const res = await adminJson(app, "/api/admin/connections", "POST", {
      ...OA_CONN,
      data: { ...OA_CONN.data, prefix: "local", baseUrl: "http://127.0.0.1:8080/v1" },
    });
    expect(res.status).toBe(201);
  });

  test("base URLs are stored in canonical form", async () => {
    const { app } = ctx();
    const response = await adminJson(app, "/api/admin/connections", "POST", {
      ...OA_CONN,
      data: { ...OA_CONN.data, prefix: "canonical", baseUrl: "  https://EXAMPLE.com:443/v1///  " },
    });

    expect(response.status).toBe(201);
    expect((await response.json()).connection.data.baseUrl).toBe("https://example.com/v1");
  });

  test("equivalent canonical upstream URLs allow the same prefix", async () => {
    const { app } = ctx();
    const first = await adminJson(app, "/api/admin/connections", "POST", {
      ...OA_CONN,
      data: { ...OA_CONN.data, prefix: "canonical", baseUrl: "https://EXAMPLE.com:443/v1/" },
    });
    const second = await adminJson(app, "/api/admin/connections", "POST", {
      ...OA_CONN,
      name: "second",
      data: { ...OA_CONN.data, prefix: "canonical", baseUrl: "https://example.com/v1" },
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  test("oa prefix rejects a non-OpenAI upstream", async () => {
    const { app } = ctx();
    const response = await adminJson(app, "/api/admin/connections", "POST", {
      ...OA_CONN,
      data: { ...OA_CONN.data, baseUrl: "https://vendor.example/v1" },
    });

    expect(response.status).toBe(400);
  });

  test("oa prefix accepts canonical equivalents of the official endpoint", async () => {
    const { app } = ctx();
    const response = await adminJson(app, "/api/admin/connections", "POST", {
      ...OA_CONN,
      data: { ...OA_CONN.data, baseUrl: "https://API.OPENAI.com:443/v1/" },
    });

    expect(response.status).toBe(201);
    expect((await response.json()).connection.data.baseUrl).toBe("https://api.openai.com/v1");
  });

  test("oa connection cannot be patched to a non-OpenAI upstream", async () => {
    const { app } = ctx();
    const created = await (await adminJson(app, "/api/admin/connections", "POST", OA_CONN)).json();

    const response = await adminJson(app, `/api/admin/connections/${created.connection.id}`, "PATCH", {
      data: { baseUrl: "https://vendor.example/v1" },
    });

    expect(response.status).toBe(400);
  });

  test("legacy oa row pointing at a vendor is not routable", async () => {
    const { app, db } = ctx();
    db.query("INSERT INTO providerConnections (provider, name, data) VALUES ('openai','legacy-oa',?)")
      .run(JSON.stringify({ apiKey: "vendor-key", prefix: "oa", baseUrl: "https://vendor.example/v1", models: ["gpt-5.4"] }));

    const connections = await (await adminGet(app, "/api/admin/connections")).json();
    const models = await (await adminGet(app, "/api/admin/models")).json();

    expect(connections.connections[0].routable).toBe(false);
    expect(models.data).toEqual([]);
  });

  test("same prefix and upstream allow multiple account connections", async () => {
    const { app } = ctx();
    const first = await adminJson(app, "/api/admin/connections", "POST", {
      ...OA_CONN,
      data: { ...OA_CONN.data, prefix: "mine" },
    });
    const second = await adminJson(app, "/api/admin/connections", "POST", {
      ...OA_CONN,
      name: "second",
      data: { ...OA_CONN.data, apiKey: "second-key", prefix: "mine" },
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  test("same prefix cannot point at a different upstream", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/connections", "POST", {
      ...OA_CONN,
      data: { ...OA_CONN.data, prefix: "mine" },
    });
    const response = await adminJson(app, "/api/admin/connections", "POST", {
      ...OA_CONN,
      name: "ambiguous",
      data: { ...OA_CONN.data, prefix: "mine", baseUrl: "https://other.example/v1" },
    });

    expect(response.status).toBe(400);
  });

  test("reserved prefix rejected", async () => {
    const { app } = ctx();
    // `oa` is the official preset namespace and stays available
    for (const reserved of ["cx", "anthropic"]) {
      const res = await adminJson(app, "/api/admin/connections", "POST", {
        ...OA_CONN,
        name: `conn-${reserved}`,
        data: { ...OA_CONN.data, prefix: reserved },
      });
      if (res.status !== 400) throw new Error(`expected 400 for prefix ${reserved}, got ${res.status}`);
    }
  });

  test("malformed JSON body rejected with 400", async () => {
    const { app } = ctx();
    const res = await app.fetch(
      new Request("http://localhost/api/admin/connections", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-peer": "127.0.0.1", cookie: await testSessionCookie(app) },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("noncanonical numeric ID cannot access an existing connection", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/connections", "POST", OA_CONN);

    for (const id of ["1e0", "01", "1.0", "+1"]) {
      const response = await adminGet(app, `/api/admin/connections/${encodeURIComponent(id)}`);
      expect(response.status).toBe(400);
    }
  });

  test("all connection action routes reject malformed IDs", async () => {
    const { app } = ctx();
    const cookie = await testSessionCookie(app);
    const requests = [
      new Request("http://localhost/api/admin/connections/abc", { headers: { "x-test-peer": "127.0.0.1", cookie } }),
      new Request("http://localhost/api/admin/connections/1.5", { method: "PATCH", headers: { "content-type": "application/json", "x-test-peer": "127.0.0.1", cookie }, body: "{}" }),
      new Request("http://localhost/api/admin/connections/0/activate", { method: "POST", headers: { "x-test-peer": "127.0.0.1", cookie } }),
      new Request("http://localhost/api/admin/connections/-1/deactivate", { method: "POST", headers: { "x-test-peer": "127.0.0.1", cookie } }),
      new Request("http://localhost/api/admin/connections/9007199254740992/test", { method: "POST", headers: { "x-test-peer": "127.0.0.1", cookie } }),
      new Request("http://localhost/api/admin/connections/NaN", { method: "DELETE", headers: { "x-test-peer": "127.0.0.1", cookie } }),
    ];

    for (const request of requests) {
      expect((await app.fetch(request)).status).toBe(400);
    }
  });
});

  test("updates provider priorities atomically", async () => {
    const { app } = ctx();
    const first = await (await adminJson(app, "/api/admin/connections", "POST", OA_CONN)).json();
    const second = await (await adminJson(app, "/api/admin/connections", "POST", { ...OA_CONN, name: "backup" })).json();

    const response = await adminJson(app, "/api/admin/connections/priorities", "POST", {
      priorities: [{ id: first.connection.id, priority: 1 }, { id: second.connection.id, priority: 0 }],
    });
    const list = await (await adminGet(app, "/api/admin/connections")).json();

    expect(response.status).toBe(200);
    expect(list.connections.map((connection: { id: number; priority: number }) => [connection.id, connection.priority]))
      .toEqual([[second.connection.id, 0], [first.connection.id, 1]]);
  });

  test("rejects a priority batch without applying earlier entries", async () => {
    const { app } = ctx();
    const created = await (await adminJson(app, "/api/admin/connections", "POST", OA_CONN)).json();

    const response = await adminJson(app, "/api/admin/connections/priorities", "POST", {
      priorities: [{ id: created.connection.id, priority: 9 }, { id: 9999, priority: 0 }],
    });
    const stored = await (await adminGet(app, `/api/admin/connections/${created.connection.id}`)).json();

    expect(response.status).toBe(404);
    expect(stored.connection.priority).toBe(0);
  });

describe("provider model discovery", () => {
  test("imports and normalizes OpenAI-compatible /models without exposing credentials", async () => {
    const authorizations: string[] = [];
    const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
      authorizations.push(request.headers.get("authorization") ?? "");
      return Response.json({ data: [{ id: "z-model" }, { id: "a-model" }, { id: "a-model" }] });
    } });
    const { app } = ctx();
    try {
      const created = await (await adminJson(app, "/api/admin/connections", "POST", {
        provider: "openai", name: "discovery", data: { baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "discovery-secret", prefix: "px", models: [] },
      })).json();

      const response = await adminJson(app, `/api/admin/connections/${created.connection.id}/models`, "POST");
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(JSON.parse(text).models).toEqual(["a-model", "z-model"]);
      expect(authorizations).toEqual(["Bearer discovery-secret"]);
    } finally {
      upstream.stop(true);
    }
  });

  test("discovers Anthropic models beside the configured Messages endpoint", async () => {
    let pathname = "";
    const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
      pathname = new URL(request.url).pathname;
      return Response.json({ data: [{ id: "claude-live" }] });
    } });
    const { app } = ctx();
    try {
      const created = await (await adminJson(app, "/api/admin/connections", "POST", {
        provider: "anthropic", name: "anthropic", data: { baseUrl: `http://127.0.0.1:${upstream.port}/v1/messages`, apiKey: "ant-secret" },
      })).json();
      const response = await adminJson(app, `/api/admin/connections/${created.connection.id}/models`, "POST");

      expect(response.status).toBe(200);
      expect((await response.json()).models).toEqual(["claude-live"]);
      expect(pathname).toBe("/v1/models");
    } finally {
      upstream.stop(true);
    }
  });

  test("does not offer model import for Codex OAuth connections", async () => {
    const { app } = ctx();
    const created = await (await adminJson(app, "/api/admin/connections", "POST", {
      provider: "codex", name: "codex", data: { accessToken: "token" },
    })).json();

    const response = await adminJson(app, `/api/admin/connections/${created.connection.id}/models`, "POST");

    expect(response.status).toBe(400);
  });
});

describe("admin aliases CRUD", () => {
  test("put, list, delete alias", async () => {
    const { app } = ctx();
    const put = await adminJson(app, "/api/admin/aliases/fast", "PUT", { target: "cx/gpt-5.5" });
    expect(put.status).toBe(200);
    const list = await (await adminGet(app, "/api/admin/aliases")).json();
    expect(list.aliases).toHaveLength(1);
    expect(list.aliases[0]).toMatchObject({ name: "fast", target: "cx/gpt-5.5" });
    const del = await adminJson(app, "/api/admin/aliases/fast", "DELETE");
    expect(del.status).toBe(204);
    const after = await (await adminGet(app, "/api/admin/aliases")).json();
    expect(after.aliases).toHaveLength(0);
  });

  test("alias requires a target", async () => {
    const { app } = ctx();
    const res = await adminJson(app, "/api/admin/aliases/nope", "PUT", {});
    expect(res.status).toBe(400);
  });

  test("alias names may not use reserved prefixes", async () => {
    const { app } = ctx();
    for (const bad of ["cx", "cx/gpt-5.5", "anthropic/x", "oa/y"]) {
      const res = await adminJson(app, `/api/admin/aliases/${encodeURIComponent(bad)}`, "PUT", { target: "cx/gpt-5.5" });
      if (res.status !== 400) throw new Error(`expected 400 for alias ${bad}, got ${res.status}`);
    }
  });

  test("alias targets cannot point to another alias", async () => {
    const { app } = ctx();
    expect((await adminJson(app, "/api/admin/aliases/base", "PUT", { target: "cx/gpt-5.5" })).status).toBe(200);

    const response = await adminJson(app, "/api/admin/aliases/chain", "PUT", { target: "base" });

    expect(response.status).toBe(400);
  });

  test("alias names cannot shadow canonical model IDs", async () => {
    const { app } = ctx();
    const response = await adminJson(app, `/api/admin/aliases/${encodeURIComponent("px/m1")}`, "PUT", {
      target: "cx/gpt-5.5",
    });

    expect(response.status).toBe(400);
  });

  test("alias target must be a known canonical model", async () => {
    const { app } = ctx();
    const response = await adminJson(app, "/api/admin/aliases/ghost", "PUT", { target: "ghost/m1" });

    expect(response.status).toBe(400);
  });
});

describe("non-loopback admin rejection", () => {
  test("admin API rejects non-loopback peers", async () => {
    const { app } = ctx();
    for (const path of ["/api/admin/connections", "/api/admin/status", "/api/admin/usage", "/api/admin/gateway"]) {
      const res = await adminGet(app, path, "192.168.1.5");
      if (res.status !== 403) throw new Error(`expected 403 for ${path}`);
    }
  });

  test("admin API accepts loopback peers", async () => {
    const { app } = ctx();
    for (const peer of ["127.0.0.1", "127.5.6.7", "::1", "[::1]:9999", "127.0.0.1:54321", "::ffff:127.0.0.1"]) {
      const res = await adminGet(app, "/api/admin/status", peer);
      if (res.status !== 200) throw new Error(`expected 200 for peer ${peer}, got ${res.status}`);
    }
  });

  test("gateway key does not grant admin access to non-loopback peers", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/gateway/key", "PUT", { key: "test-gateway-key-123" });
    await adminJson(app, "/api/admin/gateway/enforce", "PUT", { enforce: true });
    const res = await app.fetch(
      new Request("http://localhost/api/admin/connections", {
        headers: { authorization: "Bearer test-gateway-key-123", "x-test-peer": "10.0.0.9" },
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("admin browser origin protection", () => {
  test("cross-origin browser request cannot mutate local admin state", async () => {
    const { app } = ctx();
    const created = await (await adminJson(app, "/api/admin/connections", "POST", OA_CONN)).json();

    const response = await app.fetch(new Request(`http://localhost/api/admin/connections/${created.connection.id}/deactivate`, {
      method: "POST",
      headers: { origin: "https://attacker.example", "x-test-peer": "127.0.0.1" },
    }));

    expect(response.status).toBe(403);
    const connection = await (await adminGet(app, `/api/admin/connections/${created.connection.id}`)).json();
    expect(connection.connection.isActive).toBe(true);
  });

  test("same-origin loopback browser request and origin-less CLI request remain allowed", async () => {
    const { app } = ctx();
    const cookie = await testSessionCookie(app);
    const browser = await app.fetch(new Request("http://localhost/api/admin/status", {
      headers: { origin: "http://localhost", "x-test-peer": "127.0.0.1", cookie },
    }));
    const cli = await adminGet(app, "/api/admin/status");

    expect(browser.status).toBe(200);
    expect(cli.status).toBe(200);
  });

  test("matching non-loopback origin cannot bypass through DNS rebinding", async () => {
    const { app } = ctx();
    const response = await app.fetch(new Request("http://attacker.example/api/admin/status", {
      headers: { origin: "http://attacker.example", "x-test-peer": "127.0.0.1" },
    }));


    expect(response.status).toBe(403);
  });

  test("cross-site browser navigation without Origin cannot reach admin", async () => {
    const { app } = ctx();
    const response = await app.fetch(new Request("http://localhost/api/admin/oauth/codex/start", {
      headers: { "sec-fetch-site": "cross-site", "x-test-peer": "127.0.0.1" },
    }));

    expect(response.status).toBe(403);
  });

  test("opaque browser Origin cannot reach admin", async () => {
    const { app } = ctx();
    const response = await app.fetch(new Request("http://localhost/api/admin/status", {
      headers: { origin: "null", "x-test-peer": "127.0.0.1" },
    }));

    expect(response.status).toBe(403);
  });
});
describe("usage analytics admin API", () => {
  test("validates usage ranges and request-detail pagination", async () => {
    const { app } = ctx();

    expect((await adminGet(app, "/api/admin/usage/stats?period=year")).status).toBe(400);
    expect((await adminGet(app, "/api/admin/usage/request-details?page=0")).status).toBe(400);
    expect((await adminGet(app, "/api/admin/usage/request-details?pageSize=101")).status).toBe(400);
    expect((await adminJson(app, "/api/admin/usage/pricing", "PUT", { pricing: {} })).status).toBe(404);

    const analytics = await adminGet(app, "/api/admin/usage/stats?period=24h");
    const details = await adminGet(app, "/api/admin/usage/request-details?page=1&pageSize=20");
    const providers = await adminGet(app, "/api/admin/usage/providers");
    expect(analytics.status).toBe(200);
    expect(details.status).toBe(200);
    expect((await details.json()).pagination).toMatchObject({ page: 1, pageSize: 20, totalItems: 0, totalPages: 0 });
    expect(providers.status).toBe(200);
  });
});
