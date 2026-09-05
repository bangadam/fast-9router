// /v1/models matrix: active/inactive connections, catalog models, manual
// models, aliases (valid + stale), prefix collisions, deterministic order.

import { describe, test, expect, afterEach } from "bun:test";
import { makeApp, adminJson } from "./helpers.ts";

const CODEX_DATA = { accessToken: "test-access-token", expiresAt: Date.now() + 3600_000 };
const ANTHROPIC_DATA = { apiKey: "test-anthropic-key" };

const contexts: Array<ReturnType<typeof makeApp>> = [];
function ctx() {
  const c = makeApp();
  contexts.push(c);
  return c;
}
afterEach(() => {
  while (contexts.length) contexts.pop()!.cleanup();
});

async function models(app: ReturnType<typeof makeApp>["app"]): Promise<string[]> {
  const res = await app.fetch(new Request("http://localhost/v1/models"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { object: string; data: Array<{ id: string; object: string }> };
  expect(body.object).toBe("list");
  return body.data.map((m) => m.id);
}

describe("GET /v1/models", () => {
  test("empty when no active connections", async () => {
    const { app } = ctx();
    expect(await models(app)).toEqual([]);
  });

  test("inactive connections list nothing", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/connections", "POST", {
      provider: "codex",
      name: "codex-off",
      isActive: false,
      data: {},
    });
    expect(await models(app)).toEqual([]);
  });

  test("active connections without credentials advertise no models", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/connections", "POST", {
      provider: "codex",
      name: "codex-empty",
      data: {},
    });
    await adminJson(app, "/api/admin/connections", "POST", {
      provider: "anthropic",
      name: "anthropic-empty",
      data: {},
    });
    await adminJson(app, "/api/admin/connections", "POST", {
      provider: "openai",
      name: "openai-empty",
      data: { prefix: "empty", models: ["model-1"] },
    });

    expect(await models(app)).toEqual([]);
  });

  test("active codex connection lists catalog models with review variants", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/connections", "POST", { provider: "codex", name: "codex", data: CODEX_DATA });
    const ids = await models(app);
    expect(ids).toContain("cx/gpt-5.5");
    expect(ids).toContain("cx/gpt-5.5-review");
    expect(ids).toContain("cx/gpt-5.6-sol");
    expect(ids).not.toContain("cx/gpt-5.5-image");
    expect(ids.every((id) => id.startsWith("cx/"))).toBe(true);
  });

  test("active anthropic connection lists anthropic models only", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/connections", "POST", { provider: "anthropic", name: "anthropic", data: ANTHROPIC_DATA });
    const ids = await models(app);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id.startsWith("anthropic/"))).toBe(true);
  });

  test("manual models on openai-compatible connections are listed with their prefix", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/connections", "POST", {
      provider: "openai",
      name: "official",
      data: { apiKey: "test-openai-key", prefix: "oa", baseUrl: "https://api.openai.com/v1", models: ["gpt-5.4", "custom-model-x"] },
    });
    const ids = await models(app);
    expect(ids).toContain("oa/gpt-5.4");
    expect(ids).toContain("oa/custom-model-x");
  });

  test("official catalog lists only models supported by an active oa account", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/connections", "POST", {
      provider: "openai",
      name: "restricted",
      data: { apiKey: "test-openai-key", prefix: "oa", baseUrl: "https://api.openai.com/v1", models: ["gpt-4o"] },
    });

    const ids = await models(app);

    expect(ids).toContain("oa/gpt-4o");
    expect(ids).not.toContain("oa/gpt-5.4");
  });

  test("non-oa compatible connection does not expose the official OpenAI catalog", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/connections", "POST", {
      provider: "openai",
      name: "surplus",
      data: {
        apiKey: "test-compatible-key",
        prefix: "surplus",
        baseUrl: "https://compatible.test/v1",
        models: ["glm-5.3"],
      },
    });

    expect(await models(app)).toEqual(["surplus/glm-5.3"]);
  });

  test("catalog models require an active connection of that provider", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/connections", "POST", { provider: "openai", name: "official", data: { apiKey: "test-openai-key", prefix: "oa" } });
    const ids = await models(app);
    // openai active but codex not: no cx/ models
    expect(ids.some((id) => id.startsWith("cx/"))).toBe(false);
    expect(ids.some((id) => id.startsWith("oa/"))).toBe(true);
  });

  test("alias becomes stale when its target connection is removed", async () => {
    const { app } = ctx();
    const connection = await (await adminJson(app, "/api/admin/connections", "POST", {
      provider: "openai",
      name: "custom",
      data: { apiKey: "test-custom-key", prefix: "custom", baseUrl: "https://example.com/v1", models: ["model-1"] },
    })).json();
    expect((await adminJson(app, "/api/admin/aliases/daily", "PUT", { target: "custom/model-1" })).status).toBe(200);
    expect(await models(app)).toContain("daily");

    await adminJson(app, `/api/admin/connections/${connection.connection.id}`, "DELETE");

    expect(await models(app)).not.toContain("daily");
    const aliases = await (await adminJson(app, "/api/admin/aliases", "GET")).json();
    expect(aliases.aliases).toEqual([expect.objectContaining({ name: "daily", target: "custom/model-1" })]);
  });

  test("deactivating a connection drops its models and aliases pointing at them", async () => {
    const { app } = ctx();
    const created = await (await adminJson(app, "/api/admin/connections", "POST", { provider: "codex", name: "codex", data: CODEX_DATA })).json();
    await adminJson(app, "/api/admin/aliases/daily", "PUT", { target: "cx/gpt-5.5" });
    expect(await models(app)).toContain("daily");
    await adminJson(app, `/api/admin/connections/${created.connection.id}/deactivate`, "POST");
    const ids = await models(app);
    expect(ids).not.toContain("cx/gpt-5.5");
    expect(ids).not.toContain("daily");
  });

  test("deterministic ordering: same inputs, same sorted output", async () => {
    const a = ctx();
    const b = ctx();
    for (const app of [a.app, b.app]) {
      await adminJson(app, "/api/admin/connections", "POST", { provider: "codex", name: "c", data: CODEX_DATA });
      await adminJson(app, "/api/admin/connections", "POST", { provider: "anthropic", name: "a", data: ANTHROPIC_DATA });
      await adminJson(app, "/api/admin/aliases/zeta", "PUT", { target: "cx/gpt-5.5" });
    }
    const idsA = await models(a.app);
    const idsB = await models(b.app);
    expect(idsA).toEqual(idsB);
    const sorted = [...idsA].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    expect(idsA).toEqual(sorted);
  });

  test("prefix collision: two connections with distinct prefixes list distinct models", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/connections", "POST", {
      provider: "openai", name: "official", data: { apiKey: "test-openai-key", prefix: "oa", baseUrl: "https://api.openai.com/v1", models: ["gpt-5.4"] },
    });
    await adminJson(app, "/api/admin/connections", "POST", {
      provider: "openai", name: "proxy", data: { apiKey: "test-proxy-key", prefix: "px", baseUrl: "http://localhost:9000/v1", models: ["gpt-5.4"] },
    });
    const ids = await models(app);
    expect(ids).toContain("oa/gpt-5.4");
    expect(ids).toContain("px/gpt-5.4");
  });

  test("disabled models disappear from listing and stop resolving", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/connections", "POST", { provider: "codex", name: "codex", data: CODEX_DATA });
    expect(await models(app)).toContain("cx/gpt-5.5");

    const disabled = await adminJson(app, "/api/admin/models/visibility", "POST", { models: ["cx/gpt-5.5"], disabled: true });
    const generation = await app.fetch(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "cx/gpt-5.5", input: "hello" }),
    }));

    expect(disabled.status).toBe(200);
    expect(await models(app)).not.toContain("cx/gpt-5.5");
    expect(generation.status).toBe(400);
  });

  test("connection model lists restrict and extend Anthropic routing", async () => {
    const { app } = ctx();
    await adminJson(app, "/api/admin/connections", "POST", {
      provider: "anthropic", name: "restricted", data: { ...ANTHROPIC_DATA, models: ["claude-live"] },
    });

    const ids = await models(app);

    expect(ids).toContain("anthropic/claude-live");
    expect(ids).not.toContain("anthropic/claude-opus-4-5");
  });
});

describe("generation endpoints validate before routing", () => {
  test("empty body on all three endpoints returns 400 with a consistent shape", async () => {
    const { app } = ctx();
    for (const path of ["/v1/chat/completions", "/v1/responses", "/v1/messages"]) {
      const res = await app.fetch(
        new Request(`http://localhost${path}`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string; type: string } };
      expect(body.error.type).toBe("invalid_request_error");
    }
  });
});

describe("static dashboard", () => {
  test("GET / serves the placeholder page", async () => {
    const { app } = ctx();
    const res = await app.fetch(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Fast 9Router");
  });
});
