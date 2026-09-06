// Adapter + routing integration tests via app.fetch with fake upstreams.
// Covers: URL/method/headers/model/payload per adapter, abort propagation,
// response mapping, credential isolation, all three endpoints x streaming/
// non-streaming, 400s, usage recording, and single listActiveConnections
// call per request (no N+1).

import { describe, test, expect, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate, createConnection, recordUsage, type Database } from "../src/db.ts";
import { createApp, type App } from "../src/app.ts";
import { resolveModel, withStreamFinalizer } from "../src/router/pipeline.ts";
import { streamWithUsage } from "../src/adapters/anthropic.ts";
import { resetRouterState } from "../src/router/accounts.ts";

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeUpstream(handler: (c: Captured) => Response | string | Record<string, unknown> | Promise<Response | string | Record<string, unknown>>) {
  const captured: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = req.body ? JSON.parse(await req.text()) : {};
      const entry: Captured = {
        method: req.method,
        url: req.url,
        headers: Object.fromEntries(req.headers.entries()),
        body,
      };
      captured.push(entry);
      const out = await handler(entry);
      if (typeof out === "string") return new Response(out);
      if (out instanceof Response) return out;
      return Response.json(out);
    },
  });
  return { server, captured, url: `http://127.0.0.1:${server.port}` };
}

function setup(policy: Parameters<typeof createApp>[4] = {}): { app: App; db: Database } {
  const dir = mkdtempSync(join(tmpdir(), "fast-9router-ad-"));
  const db = openDatabase(join(dir, "t.db"));
  migrate(db);
  return { app: createApp(db, undefined, () => "127.0.0.1", undefined, policy), db };
}

const adminCookies = new WeakMap<App, Promise<string>>();
async function adminCookie(app: App): Promise<string> {
  let cookie = adminCookies.get(app);
  if (!cookie) {
    cookie = (async () => {
      const login = await app.fetch(new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-peer": "127.0.0.1" },
        body: JSON.stringify({ password: "123456" }),
      }));
      return login.headers.get("set-cookie")!.split(";")[0]!;
    })();
    adminCookies.set(app, cookie);
  }
  return cookie;
}

beforeEach(() => resetRouterState());

describe("openai-compatible adapter", () => {
  test("chat/completions non-streaming: URL, Bearer key, model, payload, response mapping", async () => {
    const up = fakeUpstream(() => ({
      id: "chatcmpl-1", object: "chat.completion",
      model: "gpt-5.4", choices: [{ index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }));
    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, data) VALUES ('openai','t',?)")
      .run(JSON.stringify({ apiKey: "sk-upstream-1", baseUrl: `${up.url}/v1`, prefix: "px", models: ["gpt-5.4"] }));

    const res = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/gpt-5.4", stream: false, messages: [{ role: "user", content: "hello" }] }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens: number } };
    expect(body.choices[0]!.message.content).toBe("hi there");
    expect(body.usage?.prompt_tokens).toBe(5);

    expect(up.captured.length).toBe(1);
    const call = up.captured[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${up.url}/v1/chat/completions`);
    expect(call.headers.authorization).toBe("Bearer sk-upstream-1");
    expect(call.body.model).toBe("gpt-5.4");
    expect(call.body.stream).toBe(false);

    // usage recorded once
    const usage = db.query("SELECT * FROM dailyUsageAggregates").all() as Array<Record<string, unknown>>;
    expect(usage.length).toBe(1);
    expect(usage[0]!.requests).toBe(1);
    expect(usage[0]!.promptTokens).toBe(5);
    up.server.stop(true);
  });

  test("thinking model suffix selects the base model and reasoning effort", async () => {
    const up = fakeUpstream(() => ({
      id: "chatcmpl-thinking", object: "chat.completion", model: "m1",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }));
    const { app, db } = setup();
    createConnection(db, { provider: "openai", name: "thinking", data: { apiKey: "key", baseUrl: `${up.url}/v1`, prefix: "px", models: ["m1"] } });

    const response = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m1(high)", messages: [{ role: "user", content: "hello" }] }),
    }));

    expect(response.status).toBe(200);
    expect(up.captured[0]?.body.model).toBe("m1");
    expect(up.captured[0]?.body.reasoning_effort).toBe("high");
    up.server.stop(true);
    db.close();
  });

  test("manual model on the oa preset resolves through its official connection", () => {
    const { db } = setup();
    const official = createConnection(db, {
      provider: "openai",
      name: "official",
      data: { apiKey: "oa-key", baseUrl: "https://api.openai.com/v1", prefix: "oa", models: ["custom-model-x"] },
    });

    const resolved = resolveModel(db, "oa/custom-model-x", [official]);

    expect(resolved?.upstreamModel).toBe("custom-model-x");
    expect(resolved?.connectionIds).toEqual([official.id]);
    db.close();
  });

  test("official oa catalog model never resolves through another compatible prefix", () => {
    const { db } = setup();
    const wrong = createConnection(db, {
      provider: "openai", name: "wrong", priority: 0,
      data: { apiKey: "wrong-key", baseUrl: "https://vendor.example/v1", prefix: "other", models: ["gpt-5.4"] },
    });
    const official = createConnection(db, {
      provider: "openai", name: "official", priority: 10,
      data: { apiKey: "oa-key", baseUrl: "https://api.openai.com/v1", prefix: "oa", models: ["gpt-5.4"] },
    });

    const resolved = resolveModel(db, "oa/gpt-5.4", [wrong, official]);

    expect(resolved?.connectionIds).toEqual([official.id]);
    db.close();
  });

  test("official oa catalog resolves only accounts declaring the model", () => {
    const { db } = setup();
    const otherModel = createConnection(db, {
      provider: "openai", name: "other-model", priority: 0,
      data: { apiKey: "other-key", baseUrl: "https://api.openai.com/v1", prefix: "oa", models: ["gpt-4o"] },
    });
    const capable = createConnection(db, {
      provider: "openai", name: "capable", priority: 10,
      data: { apiKey: "capable-key", baseUrl: "https://api.openai.com/v1", prefix: "oa", models: ["gpt-5.4"] },
    });

    const resolved = resolveModel(db, "oa/gpt-5.4", [otherModel, capable]);

    expect(resolved?.connectionIds).toEqual([capable.id]);
    db.close();
  });

  test("official oa account with an empty model list remains passthrough", () => {
    const { db } = setup();
    const restricted = createConnection(db, {
      provider: "openai", name: "restricted", priority: 0,
      data: { apiKey: "restricted-key", baseUrl: "https://api.openai.com/v1", prefix: "oa", models: ["gpt-4o"] },
    });
    const passthrough = createConnection(db, {
      provider: "openai", name: "passthrough", priority: 10,
      data: { apiKey: "passthrough-key", baseUrl: "https://api.openai.com/v1", prefix: "oa", models: [] },
    });

    const resolved = resolveModel(db, "oa/gpt-5.4", [restricted, passthrough]);

    expect(resolved?.connectionIds).toEqual([passthrough.id]);
    db.close();
  });

  test("streaming: SSE passthrough with incremental chunks", async () => {
    const sse = [
      'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
      'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
      'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const up = fakeUpstream(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, data) VALUES ('openai','t',?)")
      .run(JSON.stringify({ apiKey: "sk-1", baseUrl: `${up.url}/v1`, prefix: "px", models: ["m1"] }));

    const res = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m1", stream: true, messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("Hel");
    expect(text).toContain("lo");
    expect(text).toContain("[DONE]");
    const usage = db.query("SELECT requests, failedRequests FROM dailyUsageAggregates").get();
    expect(usage).toEqual({ requests: 1, failedRequests: 0 });
    up.server.stop(true);
  });

  test("truncated SSE body fails instead of recording a successful request", async () => {
    const upstream = fakeUpstream(() => new Response(
      'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ));
    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, data) VALUES ('openai','truncated',?)")
      .run(JSON.stringify({ apiKey: "stream-key", baseUrl: `${upstream.url}/v1`, prefix: "px", models: ["m1"] }));

    const response = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m1", stream: true, messages: [{ role: "user", content: "hello" }] }),
    }));
    const read = new Response(response.body).text();

    await expect(read).rejects.toThrow("terminal event");
    const usage = db.query("SELECT requests, failedRequests FROM dailyUsageAggregates").get();
    expect(usage).toEqual({ requests: 1, failedRequests: 1 });
    const health = db.query("SELECT unavailableUntil, lastError FROM providerConnections WHERE name = 'truncated'").get() as { unavailableUntil: number | null; lastError: string | null };
    expect(health.unavailableUntil).not.toBeNull();
    expect(health.lastError).toBe("upstream stream failed (502)");
    upstream.server.stop(true);
    db.close();
  });

  test("streaming request rejects a successful JSON response as invalid SSE", async () => {
    const upstream = fakeUpstream(() => Response.json({
      choices: [{ message: { role: "assistant", content: "not an SSE stream" } }],
    }));
    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, data) VALUES ('openai','json-stream',?)")
      .run(JSON.stringify({ apiKey: "json-key", baseUrl: `${upstream.url}/v1`, prefix: "px", models: ["m1"] }));

    const response = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m1", stream: true, messages: [{ role: "user", content: "hello" }] }),
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    const health = db.query("SELECT unavailableUntil, lastError FROM providerConnections WHERE name = 'json-stream'").get() as { unavailableUntil: number | null; lastError: string | null };
    expect(health.unavailableUntil).not.toBeNull();
    expect(health.lastError).toBe("upstream 502");
    upstream.server.stop(true);
    db.close();
  });

  test("wrong-content streaming account falls back to an SSE sibling", async () => {
    const upstream = fakeUpstream((request) => {
      if (request.headers.authorization === "Bearer json-key") {
        return Response.json({ choices: [{ message: { role: "assistant", content: "wrong" } }] });
      }
      return new Response([
        'data: {"choices":[{"index":0,"delta":{"content":"healthy"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
    });
    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, priority, data) VALUES ('openai','json-stream',0,?)")
      .run(JSON.stringify({ apiKey: "json-key", baseUrl: `${upstream.url}/v1`, prefix: "px", models: ["m1"] }));
    db.query("INSERT INTO providerConnections (provider, name, priority, data) VALUES ('openai','sse-stream',10,?)")
      .run(JSON.stringify({ apiKey: "sse-key", baseUrl: `${upstream.url}/v1`, prefix: "px", models: ["m1"] }));

    const response = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m1", stream: true, messages: [{ role: "user", content: "hello" }] }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("healthy");
    expect(upstream.captured.map((request) => request.headers.authorization)).toEqual([
      "Bearer json-key",
      "Bearer sse-key",
    ]);
    upstream.server.stop(true);
    db.close();
  });

  test("explicit stream failure records a failed request", async () => {
    const upstream = fakeUpstream(() => new Response([
      'data: {"error":{"message":"generation failed"}}\n\n',
      "data: [DONE]\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream" } }));
    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, data) VALUES ('openai','failed-stream',?)")
      .run(JSON.stringify({ apiKey: "stream-key", baseUrl: `${upstream.url}/v1`, prefix: "px", models: ["m1"] }));

    const response = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m1", stream: true, messages: [{ role: "user", content: "hello" }] }),
    }));
    await expect(response.text()).rejects.toThrow("terminal failure");

    const usage = db.query("SELECT requests, failedRequests FROM dailyUsageAggregates").get();
    expect(usage).toEqual({ requests: 1, failedRequests: 1 });
    upstream.server.stop(true);
    db.close();
  });

  test("credential isolation: two accounts, round-robin alternates keys", async () => {
    const keys: string[] = [];
    const up = fakeUpstream((c) => {
      keys.push(c.headers.authorization!);
      return { choices: [{ message: { role: "assistant", content: "ok" } }] };
    });
    const { app, db } = setup();
    for (const k of ["sk-a", "sk-b"]) {
      db.query("INSERT INTO providerConnections (provider, name, data) VALUES ('openai',?,?)")
        .run(`c-${k}`, JSON.stringify({ apiKey: k, baseUrl: `${up.url}/v1`, prefix: "px", models: ["m1"] }));
    }
    for (let i = 0; i < 4; i++) {
      await app.fetch(new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "px/m1", messages: [{ role: "user", content: "x" }] }),
      }));
    }
    expect(keys).toEqual(["Bearer sk-a", "Bearer sk-b", "Bearer sk-a", "Bearer sk-b"]);
    up.server.stop(true);
  });

  test("round-robin skips same-prefix accounts that do not declare the requested model", async () => {
    const keys: string[] = [];
    const upstream = fakeUpstream((call) => {
      keys.push(call.headers.authorization!);
      return { choices: [{ message: { role: "assistant", content: "ok" } }] };
    });
    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, data) VALUES ('openai','capable',?)")
      .run(JSON.stringify({ apiKey: "capable-key", baseUrl: `${upstream.url}/v1`, prefix: "px", models: ["target-model"] }));
    db.query("INSERT INTO providerConnections (provider, name, data) VALUES ('openai','other-model',?)")
      .run(JSON.stringify({ apiKey: "other-key", baseUrl: `${upstream.url}/v1`, prefix: "px", models: ["other-model"] }));

    for (let request = 0; request < 2; request++) {
      const response = await app.fetch(new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "px/target-model", messages: [{ role: "user", content: "x" }] }),
      }));
      expect(response.status).toBe(200);
    }

    expect(keys).toEqual(["Bearer capable-key", "Bearer capable-key"]);
    upstream.server.stop(true);
    db.close();
  });

  test("routing never falls back to a different compatible prefix", async () => {
    const target = fakeUpstream(() => ({
      choices: [{ message: { role: "assistant", content: "target" } }],
    }));
    const wrong = fakeUpstream(() => ({
      choices: [{ message: { role: "assistant", content: "wrong" } }],
    }));
    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, priority, data) VALUES ('openai','wrong',0,?)")
      .run(JSON.stringify({ apiKey: "wrong-key", baseUrl: `${wrong.url}/v1`, prefix: "other", models: ["m1"] }));
    db.query("INSERT INTO providerConnections (provider, name, priority, data) VALUES ('openai','target',10,?)")
      .run(JSON.stringify({ apiKey: "target-key", baseUrl: `${target.url}/v1`, prefix: "px", models: ["m1"] }));

    const res = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m1", messages: [{ role: "user", content: "x" }] }),
    }));

    expect(res.status).toBe(200);
    expect(((await res.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe("target");
    expect(wrong.captured).toHaveLength(0);
    expect(target.captured).toHaveLength(1);
    target.server.stop(true);
    wrong.server.stop(true);
    db.close();
  });

  test("abort signal reaches the upstream (request cancelled mid-flight)", async () => {
    const sawAbort = Promise.withResolvers<void>();
    const up = fakeUpstream(() => {
      return new Response(
        new ReadableStream({
          start(controller) {
            let closed = false;

            const timer = setInterval(() => {
              // enqueue on a cancelled/closed controller throws; guard so a
              // late tick after client cancel cannot produce an unhandled
              // rejection that bun:test attributes to the NEXT test.
              if (closed) return;
              try {
                controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
              } catch {
                clearInterval(timer);
              }
            }, 10);
            setTimeout(() => {
              clearInterval(timer);
              if (!closed) {
                closed = true;
                try { controller.close(); } catch { /* already cancelled */ }
                sawAbort.reject(new Error("stream closed without cancel"));
              }
            }, 2000);
          },
          cancel() { sawAbort.resolve(); },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, data) VALUES ('openai','t',?)")
      .run(JSON.stringify({ apiKey: "sk-1", baseUrl: `${up.url}/v1`, prefix: "px", models: ["m1"] }));

    const controller = new AbortController();
    const res = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m1", stream: true, messages: [{ role: "user", content: "hi" }] }),
      signal: controller.signal,
    }));
    controller.abort();
    // The upstream sees cancellation of its response stream.
    await Promise.race([sawAbort.promise, new Promise((_, rej) => setTimeout(() => rej(new Error("no upstream cancel within 5s")), 5000))]);
    await res.body?.cancel().catch(() => {});
    up.server.stop(true);
  });
  test("account without credentials is excluded before routing", async () => {
    const upstream = fakeUpstream(() => ({
      choices: [{ message: { role: "assistant", content: "healthy" } }],
    }));
    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, priority, data) VALUES ('openai','missing-key',0,?)")
      .run(JSON.stringify({ baseUrl: `${upstream.url}/v1`, prefix: "px", models: ["m1"] }));
    db.query("INSERT INTO providerConnections (provider, name, priority, data) VALUES ('openai','healthy',10,?)")
      .run(JSON.stringify({ apiKey: "healthy-key", baseUrl: `${upstream.url}/v1`, prefix: "px", models: ["m1"] }));

    const response = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m1", messages: [{ role: "user", content: "hello" }] }),
    }));

    expect(response.status).toBe(200);
    expect(upstream.captured).toHaveLength(1);
    expect(upstream.captured[0]!.headers.authorization).toBe("Bearer healthy-key");
    const missing = db.query("SELECT unavailableUntil FROM providerConnections WHERE name = 'missing-key'").get();
    expect(missing).toEqual({ unavailableUntil: null });
    upstream.server.stop(true);
    db.close();
  });

  test("cancelled response stream records one failed request", async () => {
    const cancelled = Promise.withResolvers<void>();
    const up = fakeUpstream(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
      },
      cancel() {
        cancelled.resolve();
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, data) VALUES ('openai','cancel',?)")
      .run(JSON.stringify({ apiKey: "sk-1", baseUrl: `${up.url}/v1`, prefix: "px", models: ["m1"] }));

    const response = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m1", stream: true, messages: [{ role: "user", content: "x" }] }),
    }));
    await response.body?.cancel("client stopped reading");
    await cancelled.promise;

    const usage = db.query("SELECT requests, failedRequests FROM dailyUsageAggregates").get();
    expect(usage).toEqual({ requests: 1, failedRequests: 1 });
    const health = db.query("SELECT unavailableUntil, lastError FROM providerConnections WHERE name = 'cancel'").get();
    expect(health).toEqual({ unavailableUntil: null, lastError: null });
    up.server.stop(true);
    db.close();
  });

  test("client cancel after a valid terminal event finalizes as success", async () => {
    const cancelled = Promise.withResolvers<void>();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n',
          "data: [DONE]\n\n",
        ].join("")));
      },
      cancel() {
        cancelled.resolve();
      },
    });
    const monitored = streamWithUsage(source, "openai");
    const abort = new AbortController();
    const finalizations: Array<{ failed: boolean; status: number }> = [];
    const stream = withStreamFinalizer(monitored.body, abort, 200, async (failed, status) => {
      finalizations.push({ failed, status });
    }, monitored.isComplete);
    const reader = stream.getReader();

    const terminalChunk = await reader.read();
    expect(new TextDecoder().decode(terminalChunk.value)).toContain("[DONE]");
    await reader.cancel("client stops after terminal");
    await cancelled.promise;

    expect(finalizations).toEqual([{ failed: false, status: 200 }]);
    expect(await monitored.usage).toEqual({ promptTokens: 2, completionTokens: 1 });
  });

  test("errored response stream records one failed request exactly once", async () => {
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
          return;
        }
        controller.error(new Error("upstream stream failed"));
      },
    });
    const { db } = setup();
    const connection = createConnection(db, { provider: "openai", name: "error", data: {} });
    const abort = new AbortController();
    let finalizations = 0;
    const stream = withStreamFinalizer(source, abort, 200, async (failed, status) => {
      finalizations++;
      recordUsage(db, {
        provider: "openai",
        model: "px/m1",
        connectionId: connection.id,
        promptTokens: null,
        completionTokens: null,
        failed,
      });
      expect(status).toBe(502);
    });

    const reader = stream.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow("upstream stream failed");
    await reader.cancel().catch(() => {});

    expect(abort.signal.aborted).toBe(true);
    expect(finalizations).toBe(1);
    const usage = db.query("SELECT requests, failedRequests FROM dailyUsageAggregates").get();
    expect(usage).toEqual({ requests: 1, failedRequests: 1 });
    db.close();
  });

  test("usage monitoring does not drain upstream before the client reads", async () => {
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > 50) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(`data: {"delta":"${pulls}"}\n\n`));
      },
    });
    const { body: client, usage } = streamWithUsage(source, "openai");
    await Bun.sleep(10);

    expect(pulls).toBeLessThanOrEqual(2);
    await client.cancel();
    await usage;
  });


  test("Anthropic stream combines start prompt usage with terminal output usage", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":4,"cache_creation_input_tokens":1}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":6}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const source = new Response(sse).body!;
    const monitored = streamWithUsage(source, "claude");

    await new Response(monitored.body).text();

    expect(await monitored.usage).toEqual({ promptTokens: 15, cachedTokens: 4, completionTokens: 6 });
  });
  test("cooling connection returns an accurate Retry-After response", async () => {

    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, unavailableUntil, data) VALUES ('openai','cooling',?,?)")
      .run(
        Date.now() + 30_000,
        JSON.stringify({ apiKey: "sk-1", baseUrl: "https://unused.test/v1", prefix: "px", models: ["m1"] }),
      );

    const response = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m1", messages: [{ role: "user", content: "x" }] }),
    }));

    expect(response.status).toBe(503);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(29);
    const body = await response.json();
    expect(body.error.message).toContain("cooling down");
    db.close();
  });
  test("Responses completion may be declared by the SSE event name", async () => {
    const source = new Response([
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":2,"output_tokens":1}}}\n\n',
      "data: [DONE]\n\n",
    ].join("")).body!;
    const monitored = streamWithUsage(source, "openai-responses");

    await expect(new Response(monitored.body).text()).resolves.toContain("response.completed");
    expect(monitored.isComplete()).toBe(true);
    expect(await monitored.usage).toEqual({ promptTokens: 2, completionTokens: 1 });
  });

  test("OpenAI error declared by the SSE event name cannot be completed by DONE", async () => {
    const source = new Response([
      'event: error\ndata: {"message":"generation failed"}\n\n',
      "data: [DONE]\n\n",
    ].join("")).body!;
    const monitored = streamWithUsage(source, "openai");

    await expect(new Response(monitored.body).text()).rejects.toThrow("terminal failure");
    expect(monitored.isComplete()).toBe(false);
  });

  test("body type takes precedence over a conflicting SSE event name", async () => {
    const source = new Response([
      'event: response.failed\ndata: {"type":"response.completed","response":{}}\n\n',
      "data: [DONE]\n\n",
    ].join("")).body!;
    const monitored = streamWithUsage(source, "openai-responses");

    await expect(new Response(monitored.body).text()).resolves.toContain("response.completed");
    expect(monitored.isComplete()).toBe(true);
  });
});

  test("OpenAI connection test rejects an HTML success response", async () => {
    const upstream = fakeUpstream(() => new Response("<html>login</html>", {
      headers: { "content-type": "text/html" },
    }));
    const { db } = setup();
    const app = createApp(db, undefined, () => "127.0.0.1");
    const connection = createConnection(db, {
      provider: "openai",
      name: "html-probe",
      data: { apiKey: "probe-key", baseUrl: `${upstream.url}/v1`, prefix: "probe", models: ["m1"] },
    });

    const response = await app.fetch(new Request(`http://localhost/api/admin/connections/${connection.id}/test`, { method: "POST", headers: { cookie: await adminCookie(app) } }));
    const result = await response.json();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("JSON");
    upstream.server.stop(true);
    db.close();
  });
describe("anthropic adapter", () => {
  test("messages endpoint: x-api-key + version headers, claude passthrough, response shape", async () => {
    const up = fakeUpstream(() => ({
      id: "msg_1", type: "message", role: "assistant", model: "claude-x",
      content: [{ type: "text", text: "bonjour" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 4, output_tokens: 2 },
    }));
    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, data) VALUES ('anthropic','t',?)")
      .run(JSON.stringify({ apiKey: "ak-1", baseUrl: `${up.url}/v1/messages` }));

    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "anthropic/claude-opus-4-5", max_tokens: 100, messages: [{ role: "user", content: "salut" }] }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ text: string }>; usage: { input_tokens: number } };
    expect(body.content[0]!.text).toBe("bonjour");
    expect(body.usage.input_tokens).toBe(4);


    const call = up.captured[0]!;
    expect(call.url).toBe(`${up.url}/v1/messages`);
    expect(call.headers["x-api-key"]).toBe("ak-1");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    up.server.stop(true);
  });

  test("Anthropic streaming rejects a successful JSON response", async () => {
    const upstream = fakeUpstream(() => Response.json({
      id: "msg-json",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "not streaming" }],
    }));
    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, data) VALUES ('anthropic','json-stream',?)")
      .run(JSON.stringify({ apiKey: "anthropic-key", baseUrl: `${upstream.url}/v1/messages` }));

    const response = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-opus-4-5", stream: true, messages: [{ role: "user", content: "hello" }] }),
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    upstream.server.stop(true);
    db.close();
  });
  test("connection test redacts an API key reflected by the upstream", async () => {
    const apiKey = "anthropic-super-secret-key-123";
    const upstream = fakeUpstream((call) => new Response(JSON.stringify({
      error: { message: `invalid credential: ${call.headers["x-api-key"]}` },
    }), { status: 401, headers: { "content-type": "application/json" } }));
    const { db } = setup();
    const app = createApp(db, undefined, () => "127.0.0.1");
    const connection = createConnection(db, {
      provider: "anthropic",
      name: "reflected-secret",
      data: { apiKey, baseUrl: `${upstream.url}/v1/messages` },
    });

    const response = await app.fetch(new Request(`http://localhost/api/admin/connections/${connection.id}/test`, {
      method: "POST",
      headers: { cookie: await adminCookie(app) },
    }));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain(apiKey);
    expect(text).toContain("invalid credential");
    upstream.server.stop(true);
    db.close();
  });
});

  test("Anthropic connection test rejects a text success response", async () => {
    const upstream = fakeUpstream(() => new Response("ok", {
      headers: { "content-type": "text/plain" },
    }));
    const { db } = setup();
    const app = createApp(db, undefined, () => "127.0.0.1");
    const connection = createConnection(db, {
      provider: "anthropic",
      name: "text-probe",
      data: { apiKey: "probe-key", baseUrl: `${upstream.url}/v1/messages` },
    });

    const response = await app.fetch(new Request(`http://localhost/api/admin/connections/${connection.id}/test`, { method: "POST", headers: { cookie: await adminCookie(app) } }));
    const result = await response.json();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("JSON");
    upstream.server.stop(true);
    db.close();
  });
describe("validation and errors", () => {

  test("blocks cross-origin redirects before forwarding the Anthropic API key", async () => {
    const target = fakeUpstream(() => ({
      id: "leaked",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "must not run" }],
    }));
    const redirect = fakeUpstream(() => Response.redirect(`${target.url}/v1/messages`, 307));
    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, data) VALUES ('anthropic','redirect',?)")
      .run(JSON.stringify({ apiKey: "anthropic-secret", baseUrl: `${redirect.url}/v1/messages` }));

    const response = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/claude-opus-4-5",
        max_tokens: 10,
        messages: [{ role: "user", content: "hello" }],
      }),
    }));

    expect(response.status).toBe(421);
    expect(target.captured).toHaveLength(0);
    redirect.server.stop(true);
    target.server.stop(true);
    db.close();
  });
  test("malformed JSON -> 400", async () => {
    const { app } = setup();
    const res = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
    }));
    expect(res.status).toBe(400);
  });

  test("unknown model -> 400 with clear message", async () => {
    const { app } = setup();
    const res = await app.fetch(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "nope/xyz", input: "hi" }),
    }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("unknown model");
  });

  test("gateway auth still enforced on generation endpoints", async () => {
    const { app, db } = setup();
    const created = db.query(
      `INSERT INTO gatewayApiKeys (id, name, secretHash, secretPrefix, secretSuffix, isActive, createdAt, updatedAt)
       VALUES ('11111111-1111-1111-1111-111111111111', 'legacy', ?, 'f9r_', '123', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run(createHash("sha256").update("secret-key-123").digest("hex"));
    expect(created.changes).toBe(1);
    db.query("UPDATE settings SET gatewayEnforce=1 WHERE id=1").run();
    const noKey = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m", messages: [] }),
    }));
    expect(noKey.status).toBe(401);
    const badKey = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ model: "px/m", messages: [] }),
    }));
    expect(badKey.status).toBe(401);
    const good = await app.fetch(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer secret-key-123" },
      body: JSON.stringify({ model: "nope/xyz", input: "hi" }),
    }));
    expect(good.status).toBe(400); // auth passed, model rejected
  });

  test("429 on first account falls back to the second and cools it down", async () => {
    const up = fakeUpstream((c) => {
      if (c.headers.authorization === "Bearer sk-first") {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429, headers: { "retry-after": "60" },
        });
      }
      return { choices: [{ message: { role: "assistant", content: "from second" } }] };
    });
    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, priority, data) VALUES ('openai','first',0,?)")
      .run(JSON.stringify({ apiKey: "sk-first", baseUrl: `${up.url}/v1`, prefix: "px", models: ["m1"] }));
    db.query("INSERT INTO providerConnections (provider, name, priority, data) VALUES ('openai','second',10,?)")
      .run(JSON.stringify({ apiKey: "sk-second", baseUrl: `${up.url}/v1`, prefix: "px", models: ["m1"] }));

    const res = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m1", messages: [{ role: "user", content: "x" }] }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]!.message.content).toBe("from second");
    expect(up.captured).toHaveLength(2);
    expect(up.captured[1]!.body).toEqual(up.captured[0]!.body);
    const winningConnection = db.query("SELECT id FROM providerConnections WHERE name = 'second'").get() as { id: number };
    const usage = db.query("SELECT connectionId, requests, failedRequests FROM dailyUsageAggregates").all();
    expect(usage).toEqual([{ connectionId: winningConnection.id, requests: 1, failedRequests: 0 }]);
    // first account cooling down with the Retry-After window
    const row = db.query("SELECT unavailableUntil FROM providerConnections WHERE name='first'").get() as { unavailableUntil: number };
    expect(row.unavailableUntil - Date.now()).toBeGreaterThan(50_000);
    up.server.stop(true);
  });

  test("successful connection test clears runtime and persisted cooldown", async () => {
    let firstPrimaryCall = true;
    const upstream = fakeUpstream((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/models")) return { object: "list", data: [] };
      if (request.headers.authorization === "Bearer primary-key" && firstPrimaryCall) {
        firstPrimaryCall = false;
        return Response.json({ error: { message: "rate limited" } }, { status: 429 });
      }
      return { choices: [{ message: { role: "assistant", content: "primary recovered" } }] };
    });
    const { db } = setup();
    const app = createApp(db, undefined, () => "127.0.0.1");
    const primary = createConnection(db, {
      provider: "openai", name: "primary", priority: 0,
      data: { apiKey: "primary-key", baseUrl: `${upstream.url}/v1`, prefix: "px", models: ["m1"] },
    });
    const backup = createConnection(db, {
      provider: "openai", name: "backup", priority: 10,
      data: { apiKey: "backup-key", baseUrl: `${upstream.url}/v1`, prefix: "px", models: ["m1"] },
    });
    const generate = () => app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m1", messages: [{ role: "user", content: "hello" }] }),
    }));

    expect((await generate()).status).toBe(200);
    const tested = await app.fetch(new Request(`http://localhost/api/admin/connections/${primary.id}/test`, { method: "POST", headers: { cookie: await adminCookie(app) } }));
    expect((await tested.json()).ok).toBe(true);
    db.query("UPDATE providerConnections SET isActive = 0 WHERE id = ?").run(backup.id);

    const recovered = await generate();
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).choices[0].message.content).toBe("primary recovered");
    upstream.server.stop(true);
    db.close();
  });

  test("credential patch clears runtime and persisted cooldown", async () => {
    const upstream = fakeUpstream((request) => {
      if (request.headers.authorization === "Bearer old-key") {
        return Response.json({ error: { message: "invalid key" } }, { status: 401 });
      }
      return { choices: [{ message: { role: "assistant", content: request.headers.authorization } }] };
    });
    const { db } = setup();
    const app = createApp(db, undefined, () => "127.0.0.1");
    const primary = createConnection(db, {
      provider: "openai", name: "primary", priority: 0,
      data: { apiKey: "old-key", baseUrl: `${upstream.url}/v1`, prefix: "px", models: ["m1"] },
    });
    const backup = createConnection(db, {
      provider: "openai", name: "backup", priority: 10,
      data: { apiKey: "backup-key", baseUrl: `${upstream.url}/v1`, prefix: "px", models: ["m1"] },
    });
    const generate = () => app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m1", messages: [{ role: "user", content: "hello" }] }),
    }));

    expect((await generate()).status).toBe(200);
    const patched = await app.fetch(new Request(`http://localhost/api/admin/connections/${primary.id}`, {
      method: "PATCH", headers: { "content-type": "application/json", cookie: await adminCookie(app) },
      body: JSON.stringify({ data: { apiKey: "new-key" } }),
    }));
    expect(patched.status).toBe(200);
    db.query("UPDATE providerConnections SET isActive = 0 WHERE id = ?").run(backup.id);

    const recovered = await generate();
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).choices[0].message.content).toBe("Bearer new-key");
    upstream.server.stop(true);
    db.close();
  });

  test("stalled first account times out and falls back", async () => {
    const upstream = fakeUpstream(async (request) => {
      if (request.headers.authorization === "Bearer sk-stalled") {
        await Bun.sleep(100);
        return Response.json({ choices: [{ message: { role: "assistant", content: "late" } }] });
      }
      return { choices: [{ message: { role: "assistant", content: "fallback" } }] };
    });
    const policy = { upstreamConnectTimeoutMs: 20 } as Parameters<typeof createApp>[4];
    const { app, db } = setup(policy);
    db.query("INSERT INTO providerConnections (provider, name, priority, data) VALUES ('openai','stalled',0,?)")
      .run(JSON.stringify({ apiKey: "sk-stalled", baseUrl: `${upstream.url}/v1`, prefix: "px", models: ["m1"] }));
    db.query("INSERT INTO providerConnections (provider, name, priority, data) VALUES ('openai','fallback',10,?)")
      .run(JSON.stringify({ apiKey: "sk-fallback", baseUrl: `${upstream.url}/v1`, prefix: "px", models: ["m1"] }));

    const response = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m1", messages: [{ role: "user", content: "hello" }] }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.choices[0].message.content).toBe("fallback");
    expect(upstream.captured).toHaveLength(2);
    const stalled = db.query("SELECT unavailableUntil FROM providerConnections WHERE name = 'stalled'").get() as { unavailableUntil: number };
    expect(stalled.unavailableUntil).toBeGreaterThan(Date.now());
    upstream.server.stop(true);
    db.close();
  });

  test("upstream HTTP 408 falls back to a healthy sibling account", async () => {
    const upstream = fakeUpstream((request) => {
      if (request.headers.authorization === "Bearer timed-out-key") {
        return Response.json({ error: { message: "upstream request timed out" } }, { status: 408 });
      }
      return { choices: [{ message: { role: "assistant", content: "healthy" } }] };
    });
    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, priority, data) VALUES ('openai','timed-out',0,?)")
      .run(JSON.stringify({ apiKey: "timed-out-key", baseUrl: `${upstream.url}/v1`, prefix: "px", models: ["m1"] }));
    db.query("INSERT INTO providerConnections (provider, name, priority, data) VALUES ('openai','healthy',10,?)")
      .run(JSON.stringify({ apiKey: "healthy-key", baseUrl: `${upstream.url}/v1`, prefix: "px", models: ["m1"] }));

    const response = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m1", messages: [{ role: "user", content: "hello" }] }),
    }));

    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe("healthy");
    expect(upstream.captured.map((request) => request.headers.authorization)).toEqual([
      "Bearer timed-out-key",
      "Bearer healthy-key",
    ]);
    const timedOut = db.query("SELECT unavailableUntil, lastError FROM providerConnections WHERE name = 'timed-out'").get() as { unavailableUntil: number | null; lastError: string | null };
    expect(timedOut.unavailableUntil).not.toBeNull();
    expect(timedOut.lastError).toBe("upstream 408");
    upstream.server.stop(true);
    db.close();
  });

  test("upstream 401 falls back to a healthy sibling account", async () => {
    const upstream = fakeUpstream((request) => {
      if (request.headers.authorization === "Bearer revoked-secret") {
        return Response.json({ error: { message: `invalid credential ${request.headers.authorization}` } }, { status: 401 });
      }
      return { choices: [{ message: { role: "assistant", content: "healthy" } }] };
    });
    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, priority, data) VALUES ('openai','revoked',0,?)")
      .run(JSON.stringify({ apiKey: "revoked-secret", baseUrl: `${upstream.url}/v1`, prefix: "px", models: ["m1"] }));
    db.query("INSERT INTO providerConnections (provider, name, priority, data) VALUES ('openai','healthy',10,?)")
      .run(JSON.stringify({ apiKey: "healthy-secret", baseUrl: `${upstream.url}/v1`, prefix: "px", models: ["m1"] }));

    const response = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m1", messages: [{ role: "user", content: "hello" }] }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.choices[0].message.content).toBe("healthy");
    expect(upstream.captured.map((request) => request.headers.authorization)).toEqual([
      "Bearer revoked-secret",
      "Bearer healthy-secret",
    ]);
    const revoked = db.query("SELECT unavailableUntil FROM providerConnections WHERE name = 'revoked'").get() as { unavailableUntil: number | null };
    expect(revoked.unavailableUntil).not.toBeNull();
    upstream.server.stop(true);
    db.close();
  });

  test("non-retryable 404 passes the upstream status through, no rotation", async () => {
    let calls = 0;
    const up = fakeUpstream(() => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 });
    });
    const { app, db } = setup();
    for (const n of ["a", "b"]) {
      db.query("INSERT INTO providerConnections (provider, name, data) VALUES ('openai',?,?)")
        .run(n, JSON.stringify({ apiKey: "sk-1", baseUrl: `${up.url}/v1`, prefix: "px", models: ["m1"] }));
    }
    const res = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m1", messages: [{ role: "user", content: "x" }] }),
    }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("model not found");
    expect(calls).toBe(1); // no second account tried
    up.server.stop(true);
    const usage = db.query("SELECT requests, failedRequests FROM dailyUsageAggregates").get();
    expect(usage).toEqual({ requests: 1, failedRequests: 1 });
  });

  test("all accounts exhausted -> 503", async () => {
    const up = fakeUpstream(() => new Response("upstream exploded", { status: 500 }));
    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, data) VALUES ('openai','t',?)")
      .run(JSON.stringify({ apiKey: "sk-1", baseUrl: `${up.url}/v1`, prefix: "px", models: ["m1"] }));
    const res = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m1", messages: [{ role: "user", content: "x" }] }),
    }));
    expect(res.status).toBe(503);
    up.server.stop(true);
    const usage = db.query("SELECT requests, failedRequests FROM dailyUsageAggregates").get();
    expect(usage).toEqual({ requests: 1, failedRequests: 1 });
  });
});

describe("no N+1 account queries", () => {
  test("one request performs exactly one listActiveConnections query", async () => {
    const up = fakeUpstream(() => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    const dir = mkdtempSync(join(tmpdir(), "fast-9router-n1-"));
    const db = openDatabase(join(dir, "t.db"));
    migrate(db);
    db.query("INSERT INTO providerConnections (provider, name, data) VALUES ('openai','t',?)")
      .run(JSON.stringify({ apiKey: "sk-1", baseUrl: `${up.url}/v1`, prefix: "px", models: ["m1"] }));

    let activeQueries = 0;
    const origQuery = db.query.bind(db);
    const countingQuery = ((sql: string): ReturnType<Database["query"]> => {
      if (sql.includes("isActive = 1")) activeQueries++;
      return origQuery(sql);
    }) as typeof db.query;
    (db as unknown as { query: typeof db.query }).query = countingQuery;

    const app = createApp(db);
    await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "px/m1", messages: [{ role: "user", content: "x" }] }),
    }));
    expect(activeQueries).toBe(1);
    (db as unknown as { query: typeof db.query }).query = origQuery;
    up.server.stop(true);
    db.close();
  });
});

describe("codex adapter", () => {
  test("responses endpoint routes to codex with identity headers and forced stream", async () => {
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","output":[],"usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const up = fakeUpstream(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const originalEndpoint = process.env.FAST9R_CODEX_ENDPOINT;
    process.env.FAST9R_CODEX_ENDPOINT = up.url;
    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, data) VALUES ('codex','t',?)")
      .run(JSON.stringify({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 30 * 24 * 3600_000, accountId: "acct-1" }));

    try {
      const res = await app.fetch(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "cx/gpt-5.4", input: "hi", stream: true }),
      }));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("response.output_text.delta");
      expect(text).toContain("data: [DONE]");
      expect(up.captured).toHaveLength(1);
      expect(up.captured[0]!.headers.authorization).toBe("Bearer at-1");
      expect(up.captured[0]!.headers["chatgpt-account-id"]).toBe("acct-1");
      expect(up.captured[0]!.body.stream).toBe(true);
      const usage = db.query("SELECT promptTokens, completionTokens FROM dailyUsageAggregates").get();
      expect(usage).toEqual({ promptTokens: 3, completionTokens: 1 });
    } finally {
      if (originalEndpoint === undefined) delete process.env.FAST9R_CODEX_ENDPOINT;
      else process.env.FAST9R_CODEX_ENDPOINT = originalEndpoint;
      up.server.stop(true);
      db.close();
    }
  });

  test("Codex streaming rejects a successful JSON response", async () => {
    const upstream = fakeUpstream(() => Response.json({ id: "resp-json", object: "response", output: [] }));
    const originalEndpoint = process.env.FAST9R_CODEX_ENDPOINT;
    process.env.FAST9R_CODEX_ENDPOINT = upstream.url;
    const { app, db } = setup();
    db.query("INSERT INTO providerConnections (provider, name, data) VALUES ('codex','json-stream',?)")
      .run(JSON.stringify({ accessToken: "at-json", refreshToken: "rt-json", expiresAt: Date.now() + 30 * 24 * 3600_000 }));

    try {
      const response = await app.fetch(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "cx/gpt-5.4", input: "hello", stream: true }),
      }));

      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toContain("application/json");
    } finally {
      if (originalEndpoint === undefined) delete process.env.FAST9R_CODEX_ENDPOINT;
      else process.env.FAST9R_CODEX_ENDPOINT = originalEndpoint;
      upstream.server.stop(true);
      db.close();
    }
  });

  test("Codex connection test rejects a JSON success response", async () => {
    const upstream = fakeUpstream(() => Response.json({ object: "response" }));
    const originalEndpoint = process.env.FAST9R_CODEX_ENDPOINT;
    process.env.FAST9R_CODEX_ENDPOINT = upstream.url;
    const { db } = setup();
    const app = createApp(db, undefined, () => "127.0.0.1");
    const connection = createConnection(db, {
      provider: "codex",
      name: "json-probe",
      data: { accessToken: "access-token", expiresAt: Date.now() + 30 * 24 * 3600_000 },
    });

    try {
      const response = await app.fetch(new Request(`http://localhost/api/admin/connections/${connection.id}/test`, { method: "POST", headers: { cookie: await adminCookie(app) } }));
      const result = await response.json();

      expect(result.ok).toBe(false);
      expect(result.error).toContain("event stream");
    } finally {
      if (originalEndpoint === undefined) delete process.env.FAST9R_CODEX_ENDPOINT;
      else process.env.FAST9R_CODEX_ENDPOINT = originalEndpoint;
      upstream.server.stop(true);
      db.close();
    }
  });
});