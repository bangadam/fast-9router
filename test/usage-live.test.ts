import { afterEach, describe, expect, test } from "bun:test";
import { makeApp, adminGet } from "./helpers.ts";
import { createConnection, recordUsage } from "../src/db.ts";
import { beginActiveRequest, endActiveRequest, liveUsageSnapshot, resetLiveUsageState } from "../src/usage-live.ts";

const contexts: Array<ReturnType<typeof makeApp>> = [];
afterEach(() => {
  resetLiveUsageState();
  while (contexts.length) contexts.pop()!.cleanup();
});

function context() {
  const value = makeApp();
  contexts.push(value);
  return value;
}

describe("legacy usage live flow", () => {
  test("active lifecycle transitions into recent request state", () => {
    const { db } = context();
    const connection = createConnection(db, { provider: "openai", name: "surplus", data: { prefix: "surplus" } });
    const activeId = beginActiveRequest("surplus", "surplus/glm-5.3", connection.id);

    expect(liveUsageSnapshot(db).activeRequests).toEqual([
      expect.objectContaining({ provider: "surplus", model: "surplus/glm-5.3", account: "surplus" }),
    ]);

    recordUsage(db, { provider: "openai", model: "surplus/glm-5.3", connectionId: connection.id, promptTokens: 8, cachedTokens: 3, completionTokens: 2, endpoint: "/v1/chat/completions", status: 200 });
    endActiveRequest(activeId);
    const snapshot = liveUsageSnapshot(db);

    expect(snapshot.activeRequests).toEqual([]);
    expect(snapshot.recentRequests[0]).toMatchObject({ provider: "surplus", model: "surplus/glm-5.3", promptTokens: 8, cachedTokens: 3, completionTokens: 2, status: "success" });
  });

  test("SSE emits initial and changed live snapshots", async () => {
    const { app, db } = context();
    const connection = createConnection(db, { provider: "codex", name: "codex", data: {} });
    const response = await adminGet(app, "/api/admin/usage/stream");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"activeRequests":[]');

    const activeId = beginActiveRequest("codex", "cx/gpt-5.6-sol", connection.id);
    const changed = new TextDecoder().decode((await reader.read()).value);
    expect(changed).toContain('"provider":"codex"');
    expect(changed).toContain('"model":"cx/gpt-5.6-sol"');
    endActiveRequest(activeId);
    await reader.cancel();
  });

  test("details paginate and filter safe metadata", async () => {
    const { app, db } = context();
    const connection = createConnection(db, { provider: "codex", name: "codex", data: {} });
    const at = Date.UTC(2026, 8, 5, 10);
    recordUsage(db, { provider: "codex", model: "cx/a", connectionId: connection.id, promptTokens: 1, completionTokens: 2, endpoint: "/v1/responses", status: 200, latencyMs: 9, createdAt: at });
    recordUsage(db, { provider: "codex", model: "cx/b", connectionId: connection.id, promptTokens: 3, completionTokens: 4, endpoint: "/v1/responses", status: 500, latencyMs: 11, createdAt: at + 1 });

    const response = await adminGet(app, `/api/admin/usage/request-details?page=2&pageSize=1&provider=codex&startDate=${encodeURIComponent(new Date(at).toISOString())}`);
    const text = await response.text();
    const body = JSON.parse(text);

    expect(response.status).toBe(200);
    expect(body.details).toEqual([expect.objectContaining({ model: "cx/a", endpoint: "/v1/responses", connectionName: "codex", latencyMs: 9, ttftMs: null, keyName: "Local (No API Key)" })]);
    expect(text).not.toContain("prompt\"");
    expect(text).not.toContain("responseBody");
  });
});
