import { afterEach, describe, expect, test } from "bun:test";
import {
  hostnameIsPrivate,
  prefetchImageAsDataUri,
  type HostResolver,
} from "../src/adapters/codex-transport.ts";

const originalFetch = globalThis.fetch;
function installFetchStub(
  stub: (...args: Parameters<typeof fetch>) => Promise<Response>,
): void {
  globalThis.fetch = Object.assign(stub, { preconnect: originalFetch.preconnect });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Codex image prefetch SSRF guard", () => {
  test("blocks a hostname when DNS resolves to loopback", async () => {
    const resolve: HostResolver = async () => [{ address: "127.0.0.1", family: 4 }];

    expect(await hostnameIsPrivate("attacker.example", resolve)).toBe(true);
  });

  test("blocks a hostname when any DNS answer is private", async () => {
    const resolve: HostResolver = async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.2", family: 4 },
    ];

    expect(await hostnameIsPrivate("mixed.example", resolve)).toBe(true);
  });

  test("allows a hostname only when every DNS answer is public", async () => {
    const resolve: HostResolver = async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ];

    expect(await hostnameIsPrivate("public.example", resolve)).toBe(false);
  });

  test("literal localhost remains the documented explicit local trust mode", async () => {
    const resolve: HostResolver = async () => {
      throw new Error("literal localhost must not require DNS");
    };

    expect(await hostnameIsPrivate("localhost", resolve)).toBe(false);
  });

  test("blocks a private initial host before fetch", async () => {
    let fetchCalls = 0;
    installFetchStub(async () => {
      fetchCalls++;
      return new Response();
    });
    const resolve: HostResolver = async () => [{ address: "10.0.0.5", family: 4 }];

    const result = await prefetchImageAsDataUri("https://private.example/image.png", undefined, resolve);

    expect(result.error).toContain("not a public address");
    expect(fetchCalls).toBe(0);
  });

  test("revalidates redirect DNS and never fetches its private destination", async () => {
    let fetchCalls = 0;
    installFetchStub(async () => {
      fetchCalls++;
      return new Response(null, {
        status: 302,
        headers: { location: "http://private.example/image.png" },
      });
    });
    const resolve: HostResolver = async (hostname) => hostname === "public.example"
      ? [{ address: "8.8.8.8", family: 4 }]
      : [{ address: "127.0.0.1", family: 4 }];

    const result = await prefetchImageAsDataUri("https://public.example/image.png", undefined, resolve);

    expect(result.error).toContain("redirect to non-public host blocked");
    expect(fetchCalls).toBe(1);
  });
});
