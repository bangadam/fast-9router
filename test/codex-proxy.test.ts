import { afterEach, describe, expect, test } from "bun:test";
import {
  CODEX_CALLBACK_PATH,
  startCodexCallbackProxy,
  stopCodexCallbackProxy,
} from "../src/oauth/codex-proxy.ts";

afterEach(() => stopCodexCallbackProxy());

describe("Codex fixed callback proxy", () => {
  test("forwards OAuth query parameters to the main app and returns to Providers", async () => {
    let callbackUrl = "";
    const main = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        callbackUrl = request.url;
        return Response.json({ connection: { id: 1 } }, { status: 201 });
      },
    });

    try {
      const appOrigin = `http://127.0.0.1:${main.port}`;
      const started = await startCodexCallbackProxy(appOrigin, undefined, 0);
      expect(started.ok).toBe(true);
      expect(started.port).toBeNumber();

      const response = await fetch(
        `http://127.0.0.1:${started.port}${CODEX_CALLBACK_PATH}?code=abc&state=state-1`,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(callbackUrl).toBe(`${appOrigin}/api/admin/oauth/codex/callback?code=abc&state=state-1`);
      expect(html).toContain("Authentication Successful");
      expect(html).toContain("#/connections");
    } finally {
      main.stop(true);
    }
  });

  test("rejects cross-site fetches to the loopback callback", async () => {
    const main = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return Response.json({ connection: { id: 1 } }, { status: 201 });
      },
    });

    try {
      const started = await startCodexCallbackProxy(`http://127.0.0.1:${main.port}`, undefined, 0);
      expect(started.port).toBeNumber();
      const response = await fetch(
        `http://127.0.0.1:${started.port}${CODEX_CALLBACK_PATH}?code=abc&state=state-1`,
        { headers: { origin: "https://attacker.example" } },
      );

      expect(response.status).toBe(403);
    } finally {
      main.stop(true);
    }
  });

  test("rejects a DNS hostname prefixed with 127 as callback Origin", async () => {
    let callbacks = 0;
    const main = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        callbacks++;
        return Response.json({ connection: { id: 1 } }, { status: 201 });
      },
    });

    try {
      const started = await startCodexCallbackProxy(`http://127.0.0.1:${main.port}`, undefined, 0);
      const response = await fetch(
        `http://127.0.0.1:${started.port}${CODEX_CALLBACK_PATH}?code=abc&state=state-1`,
        { headers: { origin: "http://127.attacker.example" } },
      );

      expect(response.status).toBe(403);
      expect(callbacks).toBe(0);
    } finally {
      main.stop(true);
    }
  });

  test("rejects a DNS hostname prefixed with 127 as callback target", async () => {
    const started = await startCodexCallbackProxy("http://127.attacker.example:20129", undefined, 0);

    expect(started.ok).toBe(false);
    expect(started.error).toContain("loopback");
  });
});
