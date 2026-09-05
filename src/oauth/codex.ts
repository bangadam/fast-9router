// Codex OAuth: Authorization Code + PKCE with one-time in-memory state,
// token exchange, and single-flight token refresh per connection.
//
// Constants derived from 9Router (https://github.com/decolua/9router),
// MIT License, Copyright (c) 2024-2026 decolua and contributors.
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  getConnection,
  updateConnection,
  updateConnectionTokens,
  type ConnectionData,
  type ProviderConnectionWithCooldown,
} from "../db.ts";
import type { Logger } from "../log.ts";
import { fetchAuthenticated } from "../network.ts";
import { readResponseTextLimited, sanitizeErrorText } from "../upstream-error.ts";

export const CODEX_OAUTH = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  scope: "openid profile email offline_access",
  codeChallengeMethod: "S256",
  extraParams: {
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  },
  /** Refresh this long before access-token expiry (5 days). */
  refreshLeadMs: 432000000,
  /** Pending OAuth state TTL: 10 minutes, memory only. */
  stateTtlMs: 10 * 60 * 1000,
  /** Token exchange/refresh deadline: 30 seconds. */
  tokenTimeoutMs: 30_000,
} as const;

/** Redirect URI registered by the official Codex OAuth client. */
export function defaultRedirectUri(): string {
  return "http://localhost:1455/auth/callback";
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateCodeVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function codeChallengeFrom(verifier: string): string {
  // Synchronous SHA-256 (WebCrypto digest is async and callers are sync).
  return base64url(new Uint8Array(createHash("sha256").update(verifier).digest()));
}

// ---------------------------------------------------------------------------
// One-time state (in-memory, TTL)
// ---------------------------------------------------------------------------

interface StateEntry {
  verifier: string;
  redirectUri: string;
  createdAt: number;
}

const pendingStates = new Map<string, StateEntry>();

export function beginFlow(redirectUri: string, logger?: Logger): { authorizeUrl: string; state: string } {
  const verifier = generateCodeVerifier();
  const state = base64url(crypto.getRandomValues(new Uint8Array(24)));
  pendingStates.set(state, { verifier, redirectUri, createdAt: Date.now() });
  const url = new URL(CODEX_OAUTH.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CODEX_OAUTH.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", CODEX_OAUTH.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallengeFrom(verifier));
  url.searchParams.set("code_challenge_method", CODEX_OAUTH.codeChallengeMethod);
  for (const [k, v] of Object.entries(CODEX_OAUTH.extraParams)) {
    url.searchParams.set(k, v);
  }
  const authorizeUrl = url.toString();
  logger?.info("codex oauth flow started", { authorizeUrl });
  return { authorizeUrl, state };
}

/** Consume a one-time state entry. Expired or unknown state returns null. */
export function consumeState(state: string): { verifier: string; redirectUri: string } | null {
  const entry = pendingStates.get(state);
  if (!entry) return null;
  pendingStates.delete(state);
  if (Date.now() - entry.createdAt > CODEX_OAUTH.stateTtlMs) return null;
  return { verifier: entry.verifier, redirectUri: entry.redirectUri };
}

// ---------------------------------------------------------------------------
// Token exchange / refresh
// ---------------------------------------------------------------------------

export interface CodexTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  /** Absolute epoch-ms expiry of the access token. */
  expiresAt: number;
  accountId: string | null;
  email: string | null;
  planType: string | null;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  account_id?: string;
  email?: string;
  plan_type?: string;
}

function decodeJwtPayload(token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringClaim(claims: Record<string, unknown> | null, key: string): string | null {
  const value = claims?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function extractTokenIdentity(idToken: unknown, accessToken: unknown) {
  const idClaims = decodeJwtPayload(idToken);
  const accessClaims = decodeJwtPayload(accessToken);
  const authValue = idClaims?.["https://api.openai.com/auth"];
  const authClaims = authValue && typeof authValue === "object" && !Array.isArray(authValue)
    ? authValue as Record<string, unknown>
    : null;
  return {
    accountId: stringClaim(authClaims, "chatgpt_account_id") ?? stringClaim(idClaims, "account_id"),
    email: stringClaim(idClaims, "email") ?? stringClaim(accessClaims, "email") ?? stringClaim(accessClaims, "preferred_username"),
    planType: stringClaim(authClaims, "chatgpt_plan_type") ?? stringClaim(idClaims, "plan_type"),
  };
}

function parseTokenResponse(body: unknown): CodexTokens {
  const response = body as Partial<TokenResponse> | null;
  if (!response || typeof response.access_token !== "string" || response.access_token === "") {
    throw new Error("token endpoint returned no access_token");
  }
  const idToken = typeof response.id_token === "string" ? response.id_token : null;
  const identity = extractTokenIdentity(idToken, response.access_token);
  return {
    accessToken: response.access_token,
    refreshToken: typeof response.refresh_token === "string" ? response.refresh_token : null,
    idToken,
    expiresAt: Date.now() + (typeof response.expires_in === "number" ? response.expires_in * 1000 : 3600_000),
    accountId: typeof response.account_id === "string" ? response.account_id : identity.accountId,
    email: typeof response.email === "string" ? response.email : identity.email,
    planType: typeof response.plan_type === "string" ? response.plan_type : identity.planType,
  };
}

async function postTokenEndpoint(
  form: Record<string, string>,
  signal?: AbortSignal,
): Promise<CodexTokens> {
  const timeout = AbortSignal.timeout(CODEX_OAUTH.tokenTimeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetchAuthenticated(CODEX_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: requestSignal,
  });
  let body: unknown;
  try {
    const text = await readResponseTextLimited(res, 64 * 1024);
    body = text === "" ? null : JSON.parse(text);
  } catch (error) {
    if (requestSignal.aborted) throw requestSignal.reason ?? error;
    body = null;
  }
  if (!res.ok) {
    const error = (body as { error?: string; error_description?: string } | null) ?? {};
    const description = `${error.error ?? "unknown"}${error.error_description ? `: ${error.error_description}` : ""}`;
    const err = new Error(
      `token endpoint ${res.status}: ${sanitizeErrorText(description, Object.values(form))}`,
    );
    (err as Error & { invalidGrant?: boolean }).invalidGrant = error.error === "invalid_grant";
    throw err;
  }
  return parseTokenResponse(body);
}

/** Exchange the authorization code using the PKCE verifier and matching redirect URI. */
export function exchangeCodeForTokens(
  code: string,
  verifier: string,
  redirectUri = defaultRedirectUri(),
  signal?: AbortSignal,
): Promise<CodexTokens> {
  return postTokenEndpoint({
    grant_type: "authorization_code",
    code,
    client_id: CODEX_OAUTH.clientId,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  }, signal);
}

export function refreshCodexTokens(refreshToken: string, signal?: AbortSignal): Promise<CodexTokens> {
  return postTokenEndpoint({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CODEX_OAUTH.clientId,
    scope: CODEX_OAUTH.scope,
  }, signal);
}

// ---------------------------------------------------------------------------
// Single-flight refresh per connection
// ---------------------------------------------------------------------------

const inflightRefreshes = new Map<number, Promise<ConnectionData>>();

function waitForRefresh<T>(refresh: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return refresh;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    refresh.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/**
 * Return connection data guaranteed to carry an unexpired access token when
 * possible. Refreshes `refreshLeadMs` before expiry; concurrent callers for
 * the same connection share one in-flight request. Rotated refresh tokens are
 * persisted atomically together with the new access token and expiry. A
 * refresh that fails with `invalid_grant` deactivates the connection.
 */
export async function ensureFreshCodexTokens(
  db: Database,
  connection: ProviderConnectionWithCooldown,
  signal?: AbortSignal,
): Promise<ConnectionData> {
  const data = connection.data;
  if (typeof data.expiresAt !== "number") return data;
  if (Date.now() < data.expiresAt - CODEX_OAUTH.refreshLeadMs) return data;

  const existing = inflightRefreshes.get(connection.id);
  if (existing) return waitForRefresh(existing, signal);

  const refresh = (async () => {
    const refreshToken = data.refreshToken;
    if (!refreshToken) throw new Error("codex connection has no refresh token");
    try {
      const tokens = await refreshCodexTokens(refreshToken);
      const updated = updateConnectionTokens(db, connection.id, {
        accessToken: tokens.accessToken,
        // Rotated refresh token persisted; old one kept only when omitted.
        refreshToken: tokens.refreshToken ?? refreshToken,
        idToken: tokens.idToken ?? undefined,
        expiresAt: tokens.expiresAt,
        accountId: tokens.accountId ?? data.accountId,
        email: tokens.email ?? data.email,
        planType: tokens.planType ?? data.planType,
      });
      return (updated ?? getConnection(db, connection.id))!.data;
    } catch (err) {
      if ((err as Error & { invalidGrant?: boolean }).invalidGrant) {
        updateConnection(db, connection.id, { isActive: false });
      }
      throw err;
    } finally {
      inflightRefreshes.delete(connection.id);
    }
  })();

  inflightRefreshes.set(connection.id, refresh);
  return waitForRefresh(refresh, signal);
}

/** Test hook: clear single-flight and state registries between tests. */
export function resetOAuthState(): void {
  pendingStates.clear();
  inflightRefreshes.clear();
}
