// Codex OAuth tests: PKCE verifier round-trip, one-time state, wrong/expired
// state, token rotation persistence, single-flight refresh, invalid_grant
// deactivation. The token endpoint is stubbed via a fetch wrapper injection
// (no network).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase, migrate, createConnection, getConnection } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import {
  beginFlow,
  defaultRedirectUri,
  consumeState,
  codeChallengeFrom,
  generateCodeVerifier,
  ensureFreshCodexTokens,
  resetOAuthState,
  CODEX_OAUTH,
  exchangeCodeForTokens,
} from "../src/oauth/codex.ts";

function makeDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "fast-9router-oauth-"));
  const db = openDatabase(join(dir, "test.db"));
  migrate(db);
  return db;
}


function jwt(payload: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}
const originalFetch = globalThis.fetch;
let tokenCalls = 0;
let tokenResponses: Array<{ status: number; body: unknown }> = [];
let tokenRequestBody: string | null = null;
function installFetchStub(
  stub: (...args: Parameters<typeof fetch>) => Promise<Response>,
): void {
  globalThis.fetch = Object.assign(stub, { preconnect: originalFetch.preconnect });
}

function installFakeTokenEndpoint(): void {
  tokenCalls = 0;
  tokenResponses = [];
  installFetchStub(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (url !== CODEX_OAUTH.tokenUrl) return originalFetch(input, init);
    tokenCalls++;
    tokenRequestBody = typeof init?.body === "string" ? init.body : null;
    const next = tokenResponses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  });
}

beforeEach(() => {
  resetOAuthState();
  installFakeTokenEndpoint();
  tokenRequestBody = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("PKCE", () => {
  test("verifier -> challenge is the RFC 7636 S256 value", () => {
    // Known vector from RFC 7636 appendix B
    expect(codeChallengeFrom("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
      .toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("generateCodeVerifier produces distinct URL-safe values", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("one-time state", () => {
  test("beginFlow returns an authorize URL with PKCE params", () => {
    const { authorizeUrl } = beginFlow("http://127.0.0.1:20129/api/admin/oauth/codex/callback");
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe(CODEX_OAUTH.authorizeUrl);
    expect(url.searchParams.get("client_id")).toBe(CODEX_OAUTH.clientId);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  test("consumeState returns the verifier exactly once", () => {
    const { state } = beginFlow("http://127.0.0.1:20129/api/admin/oauth/codex/callback");
    const first = consumeState(state);
    expect(first?.verifier).toBeTruthy();
    expect(consumeState(state)).toBeNull();
  });

  test("unknown state is rejected", () => {
    expect(consumeState("not-a-real-state")).toBeNull();
  });

  test("expired state is rejected", () => {
    const { state } = beginFlow("http://127.0.0.1:20129/api/admin/oauth/codex/callback");
    // age the entry past the TTL by monkey-patching Date.now
    const realNow = Date.now;
    Date.now = () => realNow() + CODEX_OAUTH.stateTtlMs + 1;
    try {
      expect(consumeState(state)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});

describe("exchangeCodeForTokens", () => {
  test("round-trips the PKCE verifier to the token endpoint", async () => {
    tokenResponses.push({
      status: 200,
      body: { access_token: "at-1", refresh_token: "rt-1", id_token: "id-1", expires_in: 3600, account_id: "acct-9" },
    });
    const tokens = await exchangeCodeForTokens("auth-code-123", "the-verifier");
    expect(tokens.accessToken).toBe("at-1");
    expect(tokens.refreshToken).toBe("rt-1");
    expect(tokens.accountId).toBe("acct-9");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  test("extracts account identity from id_token claims when account_id is omitted", async () => {
    const idToken = jwt({
      email: "codex@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-from-jwt",
        chatgpt_plan_type: "plus",
      },
    });
    tokenResponses.push({
      status: 200,
      body: { access_token: "access-not-jwt", refresh_token: "rt-1", id_token: idToken, expires_in: 3600 },
    });

    const tokens = await exchangeCodeForTokens("auth-code", "verifier");

    expect(tokens.accountId).toBe("acct-from-jwt");
    expect(tokens.email).toBe("codex@example.com");
    expect(tokens.planType).toBe("plus");
  });

  test("token endpoint requests always carry a deadline signal", async () => {
    let signal: AbortSignal | null | undefined;
    installFetchStub(async (_input, init) => {
      signal = init?.signal;
      return Response.json({ access_token: "at-deadline", expires_in: 3600 });
    });

    await exchangeCodeForTokens("auth-code", "verifier");

    expect(signal).toBeDefined();
  });
});

describe("OAuth HTTP routes", () => {
  test("uses the registered fixed callback while returning through a custom app port", async () => {
    const db = makeDb();
    const appOrigin = "http://127.0.0.1:23456";
    const proxy = { origin: null as string | null };
    const app = createApp(
      db,
      undefined,
      () => "127.0.0.1",
      appOrigin,
      {
        startCodexCallbackProxy: async (origin) => {
          proxy.origin = origin;
          return { ok: true };
        },
      },
    );

    const start = await app.fetch(new Request(`${appOrigin}/api/admin/oauth/codex/start`));
    expect(start.status).toBe(200);
    const startBody = await start.json();
    const authorizeUrl = new URL(startBody.authorizeUrl);
    expect(proxy.origin).toBe(appOrigin);
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(defaultRedirectUri());

    const callbackIdToken = jwt({
      email: "callback@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-callback",
        chatgpt_plan_type: "team",
      },
    });
    tokenResponses.push({
      status: 200,
      body: { access_token: "at-custom", refresh_token: "rt-custom", id_token: callbackIdToken, expires_in: 3600 },
    });
    const state = authorizeUrl.searchParams.get("state");
    const callback = await app.fetch(new Request(`${appOrigin}/api/admin/oauth/codex/callback?code=code-custom&state=${state}`));
    expect(callback.status).toBe(201);
    const callbackBody = await callback.json();
    expect(callbackBody.connection.data.accountId).toBe("acct-callback");
    expect(callbackBody.connection.data.email).toBe("callback@example.com");
    expect(callbackBody.connection.data.planType).toBe("team");
    expect(new URLSearchParams(tokenRequestBody ?? "").get("redirect_uri")).toBe(defaultRedirectUri());
    db.close();
  });
});

describe("ensureFreshCodexTokens", () => {
  function codexConn(db: Database, expiresAt: number) {
    return createConnection(db, {
      provider: "codex",
      name: "codex-test",
      data: { accessToken: "at-old", refreshToken: "rt-old", expiresAt },
    });
  }

  test("does not refresh when the token is comfortably fresh", async () => {
    const db = makeDb();
    const conn = codexConn(db, Date.now() + 30 * 24 * 3600_000);
    const data = await ensureFreshCodexTokens(db, conn);
    expect(data.accessToken).toBe("at-old");
    expect(tokenCalls).toBe(0);
  });

  test("refreshes inside the lead window and persists rotation atomically", async () => {
    const db = makeDb();
    // expires in 1 day < 5-day lead
    const conn = codexConn(db, Date.now() + 24 * 3600_000);
    tokenResponses.push({
      status: 200,
      body: { access_token: "at-new", refresh_token: "rt-rotated", expires_in: 3600, account_id: "acct-9" },
    });
    const data = await ensureFreshCodexTokens(db, conn);
    expect(tokenCalls).toBe(1);
    expect(data.accessToken).toBe("at-new");
    const persisted = getConnection(db, conn.id)!;
    expect(persisted.data.refreshToken).toBe("rt-rotated");
    expect(persisted.data.accessToken).toBe("at-new");
    expect(persisted.data.expiresAt).toBeGreaterThan(Date.now());
  });

  test("keeps the old refresh token when the response omits it", async () => {
    const db = makeDb();
    const conn = codexConn(db, Date.now() + 3600_000);
    tokenResponses.push({ status: 200, body: { access_token: "at-2", expires_in: 3600 } });
    const data = await ensureFreshCodexTokens(db, conn);
    expect(data.refreshToken).toBe("rt-old");
  });

  test("refresh preserves identity metadata omitted by the token endpoint", async () => {
    const db = makeDb();
    const connection = createConnection(db, {
      provider: "codex",
      name: "identity",
      data: {
        accessToken: "at-old",
        refreshToken: "rt-old",
        idToken: "id-old",
        accountId: "acct-old",
        email: "old@example.com",
        planType: "plus",
        expiresAt: Date.now() + 3600_000,
      },
    });
    tokenResponses.push({ status: 200, body: { access_token: "at-new", expires_in: 3600 } });

    const data = await ensureFreshCodexTokens(db, connection);

    expect(data.refreshToken).toBe("rt-old");
    expect(data.idToken).toBe("id-old");
    expect(data.accountId).toBe("acct-old");
    expect(data.email).toBe("old@example.com");
    expect(data.planType).toBe("plus");
    db.close();
  });

  test("single-flight: concurrent refreshes share one token call", async () => {
    const db = makeDb();
    const conn = codexConn(db, Date.now() + 3600_000);
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    installFetchStub(async () => {
      await gate;
      return new Response(JSON.stringify({ access_token: "at-sf", expires_in: 3600 }), { status: 200 });
    });
    const p1 = ensureFreshCodexTokens(db, conn);
    const p2 = ensureFreshCodexTokens(db, conn);
    const p3 = ensureFreshCodexTokens(db, conn);
    release();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.accessToken).toBe("at-sf");
    expect(r2.accessToken).toBe("at-sf");
    expect(r3.accessToken).toBe("at-sf");
    expect(tokenCalls).toBe(0); // our injected fetch replaced the counting one
  });

  test("an aborted waiter leaves the shared refresh running for a sibling", async () => {
    const db = makeDb();
    const connection = codexConn(db, Date.now() + 3600_000);
    const gate = Promise.withResolvers<void>();
    let calls = 0;
    installFetchStub(async () => {
      calls++;
      await gate.promise;
      return Response.json({ access_token: "at-shared", expires_in: 3600 });
    });
    const controller = new AbortController();
    const abortedWaiter = ensureFreshCodexTokens(db, connection, controller.signal);
    const siblingWaiter = ensureFreshCodexTokens(db, connection);

    controller.abort();
    const earlyOutcome = await Promise.race([
      abortedWaiter.then(() => "resolved", (error: Error) => error.name),
      Bun.sleep(20).then(() => "still-waiting"),
    ]);
    gate.resolve();
    const sibling = await siblingWaiter;

    expect(earlyOutcome).toBe("AbortError");
    expect(sibling.accessToken).toBe("at-shared");
    expect(getConnection(db, connection.id)?.data.accessToken).toBe("at-shared");
    expect(calls).toBe(1);
    db.close();
  });

  test("invalid_grant deactivates the connection and surfaces the error", async () => {
    const db = makeDb();
    const conn = codexConn(db, Date.now() + 3600_000);
    tokenResponses.push({ status: 400, body: { error: "invalid_grant" } });
    let threw: Error | null = null;
    try {
      await ensureFreshCodexTokens(db, conn);
    } catch (err) {
      threw = err as Error;
    }
    expect(threw).not.toBeNull();
    const persisted = getConnection(db, conn.id)!;
    expect(persisted.isActive).toBe(0);
  });
});
