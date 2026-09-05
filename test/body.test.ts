import { describe, expect, test } from "bun:test";
import { readBodyTextLimited } from "../src/body.ts";

describe("bounded request body reader", () => {
  test("cancels a chunked body as soon as it exceeds the byte limit", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > 100) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(16));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://localhost/v1/responses", {
      method: "POST",
      body: stream,
    });
    const result = await readBodyTextLimited(request, 20);
    expect(result).toEqual({ ok: false });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(100);
  });
  test("reconstructs valid UTF-8 split across chunk boundaries", async () => {
    const bytes = new TextEncoder().encode('{"input":"🙂"}');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, bytes.length - 2));
        controller.enqueue(bytes.slice(bytes.length - 2));
        controller.close();
      },
    });
    const request = new Request("http://localhost/v1/responses", {
      method: "POST",
      body: stream,
    });
    const result = await readBodyTextLimited(request, bytes.length);
    expect(result).toEqual({ ok: true, text: '{"input":"🙂"}' });
  });
});
