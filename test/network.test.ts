import { describe, expect, test } from "bun:test";
import { fetchAuthenticated } from "../src/network.ts";
import { readResponseTextLimited } from "../src/upstream-error.ts";

describe("authenticated upstream redirects", () => {
  test("blocks cross-origin redirects before forwarding custom credentials", async () => {
    let targetCalls = 0;
    const target = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        targetCalls++;
        return new Response("must not run");
      },
    });
    const source = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return Response.redirect(`http://127.0.0.1:${target.port}/target`, 307);
      },
    });
    try {
      const response = await fetchAuthenticated(
        `http://127.0.0.1:${source.port}/start`,
        { headers: { "x-api-key": "secret" } },
      );
      expect(response.status).toBe(421);
      expect(targetCalls).toBe(0);
    } finally {
      source.stop(true);
      target.stop(true);
    }
  });
  test("same-origin 307 preserves method, body, and credentials", async () => {
    const received: { current: { method: string; body: string; apiKey: string | null } | null } = { current: null };
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (new URL(request.url).pathname === "/start") {
          return new Response(null, { status: 307, headers: { location: "/final" } });
        }
        received.current = {
          method: request.method,
          body: await request.text(),
          apiKey: request.headers.get("x-api-key"),
        };
        return new Response("ok");
      },
    });
    try {
      const response = await fetchAuthenticated(
        `http://127.0.0.1:${server.port}/start`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "secret" },
          body: "{}",
        },
      );
      expect(await response.text()).toBe("ok");
      expect(received.current).toEqual({ method: "POST", body: "{}", apiKey: "secret" });
    } finally {
      server.stop(true);
    }
  });
});

describe("bounded upstream response reads", () => {
  test("cancels an oversized error body at the byte cap", async () => {
    let pulls = 0;
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > 100) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(1024).fill(65));
      },
      cancel() {
        cancelled = true;
      },
    }));

    const text = await readResponseTextLimited(response, 4096);

    expect(Buffer.byteLength(text)).toBe(4096);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(100);
  });

  test("reconstructs UTF-8 split across response chunks", async () => {
    const bytes = new TextEncoder().encode("error: 🙂 selesai");
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 9));
        controller.enqueue(bytes.subarray(9, 11));
        controller.enqueue(bytes.subarray(11));
        controller.close();
      },
    }));

    expect(await readResponseTextLimited(response, 4096)).toBe("error: 🙂 selesai");
  });
});
