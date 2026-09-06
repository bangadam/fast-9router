// Hono application: gateway auth, /v1/models, generation endpoints, admin
// API (connections, OAuth, aliases, gateway, status, usage), static dashboard.
//
// The app is constructed with an open Database handle; `app.fetch` is the
// testing seam.

import { Hono, type Context, type Env } from "hono";
import { cors } from "hono/cors";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  RESERVED_PREFIXES,
  CATALOGS,
  OPENAI_PRESET_BASE_URL,
  catalogModelForCanonical,
} from "./catalog.ts";
import {
  listActiveConnections,
  listConnections,
  listAliases,
  getConnection,
  createConnection,
  updateConnection,
  updateConnectionTokens,
  recordConnectionError,
  clearConnectionError,
  deleteConnection,
  upsertAlias,
  deleteAlias,
  getSettings,
  updateTokenSaverSettings,
  setGatewayEnforce,
  setModelsDisabled,
  usageSummary,
  requestUsageDetails,
  countActiveGatewayKeys,
  listGatewayKeyDtos,
  createGatewayKey,
  updateGatewayKey,
  deleteGatewayKey,
  getGatewayKey,
  gatewayKeyNameTaken,
  validateGatewayKeyName,
  findActiveGatewayKeyByHash,
  LOCAL_KEY_IDENTITY,
  type ConnectionData,
  type ProviderConnectionWithCooldown,
  type UsageKeyIdentity,
  type GatewayApiKeyRow,
} from "./db.ts";
import { Logger, redact } from "./log.ts";
import { recoverConnectionHealth } from "./router/accounts.ts";
import { serveDashboardFile } from "./static.ts";
import { connectionIsRoutable, connectionSupportsModel, routeGenerationRequest, type Endpoint } from "./router/pipeline.ts";
import {
  beginFlow,
  consumeState,
  exchangeCodeForTokens,
  defaultRedirectUri,
} from "./oauth/codex.ts";
import { canonicalBaseUrl, fetchAuthenticated, isLoopbackAddress, isLoopbackHostname } from "./network.ts";
import { testCodexConnection } from "./adapters/codex.ts";
import { isJsonResponse } from "./adapters/types.ts";
import { readBodyTextLimited, type BodyTextResult } from "./body.ts";
import {
  CODEX_CALLBACK_PORT,
  startCodexCallbackProxy,
  type CodexCallbackProxyResult,
} from "./oauth/codex-proxy.ts";
import { readResponseTextLimited, safeUpstreamMessage, sanitizeErrorText } from "./upstream-error.ts";
import { buildUsageAnalytics, type UsagePeriod } from "./analytics.ts";
import { createCliToolsApp } from "./cli-tools/routes.ts";
import { liveUsageSnapshot, subscribeUsageChanges } from "./usage-live.ts";
import { validateConnectionInput, validateBaseUrl } from "./connection-input.ts";
import { exportBackup, importBackup, validateBackupPayload } from "./backup.ts";
import { quotaSnapshotForConnection, quotaOverview } from "./quota.ts";
import * as auth from "./auth.ts";

export interface AppEnv extends Env {
  Variables: {
    db: Database;
    logger: Logger;
    usageKey?: UsageKeyIdentity;
  };
}

export type App = Hono<AppEnv>;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


/**
 * Trusted peer-address seam. Production resolves this from Bun's socket via
 * Hono getConnInfo; tests inject a resolver explicitly. Client headers are
 * never consulted by the application.
 */
export type PeerAddressResolver = (context: Context<AppEnv>) => string | undefined;

function jsonError(status: number, message: string, type: string): Response {
  return Response.json({ error: { message, type } }, { status });
}

const MASK = "********";

/** Admin-safe view of a connection: never returns secrets in full. */
function maskConnection(conn: ProviderConnectionWithCooldown) {
  const data = conn.data as ConnectionData;
  const safeData = conn.provider === "codex"
    ? {
        accountId: data.accountId,
        expiresAt: data.expiresAt,
        email: data.email,
        planType: data.planType,
        autoPing: data.autoPing ?? false,
        models: data.models ?? [],
      }
    : conn.provider === "anthropic"
      ? {
          baseUrl: data.baseUrl,
          models: data.models ?? [],
          autoPing: data.autoPing ?? false,
          apiKey: data.apiKey ? MASK : undefined,
        }
      : {
          baseUrl: data.baseUrl,
          prefix: data.prefix,
          models: data.models ?? [],
          autoPing: data.autoPing ?? false,
          apiKey: data.apiKey ? MASK : undefined,
        };
  return {
    id: conn.id,
    provider: conn.provider,
    name: conn.name,
    isActive: conn.isActive === 1,
    routable: conn.isActive === 1
      && connectionIsRoutable(conn)
      && (conn.unavailableUntil === null || conn.unavailableUntil <= Date.now()),
    priority: conn.priority,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
    unavailableUntil: conn.unavailableUntil,
    lastError: conn.lastError,
    data: safeData,
  };
}

function connectionTestResponse(
  db: Database,
  connection: ProviderConnectionWithCooldown,
  result: { ok: boolean; status: number; error?: string },
): Response {
  const secrets = [
    connection.data.apiKey,
    connection.data.accessToken,
    connection.data.refreshToken,
    connection.data.idToken,
  ].filter((value): value is string => typeof value === "string");
  if (result.ok) {
    recoverConnectionHealth(db, connection);
    return Response.json(result);
  }
  const error = sanitizeErrorText(result.error ?? `connection test failed with status ${result.status}`, secrets);
  recordConnectionError(db, connection.id, error);
  return Response.json({ ...result, error });
}

// ---------------------------------------------------------------------------
// Validation (see connection-input.ts — shared with backup import)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

export interface ModelsEntry {
  id: string;
  object: "model";
  owned_by: string;
}

/**
 * `/v1/models` payload: catalog models of providers with an active
 * connection, manual models from openai-compatible `data.models[]`, and valid
 * aliases (pointing at listed models). Deterministic order.
 */
export function buildModelsListing(db: Database): ModelsEntry[] {
  const settings = getSettings(db);
  const disabled = new Set(settings.disabledModels);
  const active = listActiveConnections(db).filter((connection) => connectionIsRoutable(connection));
  const activeProviders = new Set(active.map((c) => c.provider));
  const officialOpenAiConnections = active.filter(
    (connection) => connection.provider === "openai" && connection.data.prefix === "oa",
  );
  const manual = new Set<string>();
  for (const c of active) {
    if (c.provider === "codex") for (const m of c.data.models ?? []) manual.add(`cx/${m}`);
    if (c.provider === "openai") for (const m of c.data.models ?? []) manual.add(`${c.data.prefix}/${m}`);
    if (c.provider === "anthropic") for (const m of c.data.models ?? []) manual.add(`anthropic/${m}`);
  }

  const entries = new Map<string, ModelsEntry>();
  for (const catalog of CATALOGS) {
    if (!activeProviders.has(catalog.provider)) continue;
    if (catalog.provider === "openai" && officialOpenAiConnections.length === 0) continue;
    for (const model of catalog.models) {
      if (disabled.has(model.canonical)) continue;
      if (catalog.provider === "openai"
        && !officialOpenAiConnections.some((connection) => connectionSupportsModel(connection, model.id))) continue;
      if (catalog.provider === "anthropic"
        && !active.some((connection) => connection.provider === "anthropic" && connectionSupportsModel(connection, model.id))) continue;
      entries.set(model.canonical, { id: model.canonical, object: "model", owned_by: catalog.provider });
    }
  }
  for (const id of manual) {
    if (!disabled.has(id)) entries.set(id, { id, object: "model", owned_by: id.startsWith("cx/") ? "codex" : id.startsWith("anthropic/") ? "anthropic" : "openai" });
  }
  for (const alias of listAliases(db)) {
    if (entries.has(alias.target)) {
      entries.set(alias.name, { id: alias.name, object: "model", owned_by: "alias" });
    }
  }
  return [...entries.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function isConfiguredCanonicalModel(db: Database, target: string): boolean {
  if (catalogModelForCanonical(target)) return true;
  const slash = target.indexOf("/");
  if (slash <= 0 || slash === target.length - 1) return false;
  const prefix = target.slice(0, slash);
  const model = target.slice(slash + 1);
  return listConnections(db).some((connection) => {
    if (prefix === "cx" && connection.provider === "codex") return connection.data.models?.includes(model) === true;
    if (prefix === "anthropic" && connection.provider === "anthropic") return connection.data.models?.includes(model) === true;
    if (connection.provider !== "openai" || connection.data.prefix !== prefix) return false;
    return connectionSupportsModel(connection, model);
  });
}

async function discoverConnectionModels(connection: ProviderConnectionWithCooldown): Promise<Response> {
  if (connection.provider === "codex") {
    return jsonError(400, "Codex does not expose model discovery", "invalid_request_error");
  }
  const apiKey = connection.data.apiKey;
  if (!apiKey) return jsonError(400, "connection is missing an API key", "invalid_request_error");
  const baseUrl = connection.data.baseUrl
    ?? (connection.provider === "anthropic" ? "https://api.anthropic.com/v1/messages" : OPENAI_PRESET_BASE_URL);
  const url = connection.provider === "anthropic"
    ? `${baseUrl.replace(/\/messages\/?$/, "").replace(/\/+$/, "")}/models`
    : `${baseUrl.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> = connection.provider === "anthropic"
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${apiKey}` };
  try {
    const response = await fetchAuthenticated(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      const text = await readResponseTextLimited(response);
      return jsonError(response.status, safeUpstreamMessage(response.status, text, [apiKey]), "upstream_error");
    }
    if (!isJsonResponse(response)) {
      await response.body?.cancel().catch(() => {});
      return jsonError(502, "model discovery expected a JSON response", "upstream_error");
    }
    const text = await readResponseTextLimited(response, 1_048_576);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return jsonError(502, "model discovery returned invalid or oversized JSON", "upstream_error");
    }
    const body = payload && typeof payload === "object" ? payload as { data?: unknown; models?: unknown } : {};
    const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : null;
    if (!rows) return jsonError(502, "model discovery response has no model list", "upstream_error");
    const models = [...new Set(rows.flatMap((row) => {
      const id = typeof row === "string" ? row
        : row && typeof row === "object"
          ? ["id", "name", "model"].map((key) => (row as Record<string, unknown>)[key]).find((value) => typeof value === "string")
          : undefined;
      return typeof id === "string" && id.trim() !== "" && id.length <= 256 ? [id.trim()] : [];
    }))].sort();
    return Response.json({ models });
  } catch (error) {
    return jsonError(502, sanitizeErrorText((error as Error).message, [apiKey]), "upstream_error");
  }
}

function allowsAdminBrowserRequest(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") return false;

  const requestUrl = new URL(request.url);
  if (!isLoopbackHostname(requestUrl.hostname)) return false;

  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    const originUrl = new URL(origin);
    return (originUrl.protocol === "http:" || originUrl.protocol === "https:")
      && isLoopbackHostname(originUrl.hostname)
      && originUrl.origin === requestUrl.origin;
  } catch {
    return false;
  }
}

export interface AppPolicy {
  gatewayEnforcementRequired?: boolean;
  startCodexCallbackProxy?: (appOrigin: string, logger?: Logger) => Promise<CodexCallbackProxyResult>;
  upstreamConnectTimeoutMs?: number;
}

function bearerToken(authorization: string | undefined): string | null {
  const match = /^Bearer[\t ]+([^\t ]+)[\t ]*$/i.exec(authorization ?? "");
  return match?.[1] ?? null;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Resolve the gateway credential from a request: strict Bearer token first,
 * then a non-empty `x-api-key`. Returns the active key row on match, or a
 * response to return immediately on failure. Enforcement off bypasses lookup.
 */
function resolveGatewayCredential(
  db: Database,
  request: Request,
): { key: GatewayApiKeyRow } | { response: Response } {
  const settings = getSettings(db);
  if (!settings.gatewayEnforce) {
    return { response: new Response(null, { status: 0 }) }; // sentinel: pass through as local
  }
  const bearer = bearerToken(request.headers.get("authorization") ?? undefined);
  const apiKeyHeader = request.headers.get("x-api-key");
  const candidate = bearer !== null ? bearer : (apiKeyHeader !== null && apiKeyHeader.trim() !== "" ? apiKeyHeader.trim() : null);
  if (countActiveGatewayKeys(db) === 0) {
    return { response: jsonError(503, "gateway authentication is misconfigured", "server_error") };
  }
  if (candidate === null) {
    return { response: jsonError(401, "invalid or missing gateway API key", "invalid_request_error") };
  }
  const key = findActiveGatewayKeyByHash(db, sha256Hex(candidate));
  if (!key) {
    return { response: jsonError(401, "invalid or missing gateway API key", "invalid_request_error") };
  }
  return { key };
}

export function createApp(
  db: Database,
  logger = new Logger(),
  resolvePeer: PeerAddressResolver = () => undefined,
  oauthAppOrigin = "http://127.0.0.1:20129",
  policy: AppPolicy = {},
): App {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("logger", logger);
    await next();
  });

  // Browser clients must complete preflight before they can present a Bearer
  // key on the actual request. CORS runs before gateway authentication and
  // also decorates authenticated error responses.
  app.use("/v1/*", cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["authorization", "content-type", "x-api-key", "x-9router-token-saver"],
  }));

  // --- Gateway auth ---------------------------------------------------------
  app.use("/v1/*", async (c, next) => {
    const settings = getSettings(db);
    if (!settings.gatewayEnforce) {
      c.set("usageKey", LOCAL_KEY_IDENTITY);
      return next();
    }
    const resolved = resolveGatewayCredential(db, c.req.raw);
    if ("response" in resolved) return resolved.response;
    c.set("usageKey", {
      category: "gateway",
      gatewayKeyId: resolved.key.id,
      gatewayKeyName: resolved.key.name,
    });
    return next();
  });

  // --- Public model listing -------------------------------------------------
  app.get("/v1/models", (c) => Response.json({ object: "list", data: buildModelsListing(c.get("db")) }));

  // --- Generation endpoints -------------------------------------------------
  const generationEndpoint = (endpoint: Endpoint) => async (c: Context<AppEnv>) => {
    // Configurable body limit (default 128MB), enforced before JSON parsing.
    const maxMb = Number(process.env.FAST9R_MAX_BODY_MB);
    const maxBytes = (Number.isFinite(maxMb) && maxMb > 0 ? maxMb : 128) * 1024 * 1024;
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      return jsonError(413, `request body exceeds ${maxBytes / 1024 / 1024}MB limit`, "request_too_large");
    }
    let bodyRead: BodyTextResult;
    try {
      bodyRead = await readBodyTextLimited(c.req.raw, maxBytes);
    } catch {
      return jsonError(400, "request body could not be read", "invalid_request_error");
    }
    if (!bodyRead.ok) {
      return jsonError(413, `request body exceeds ${maxBytes / 1024 / 1024}MB limit`, "request_too_large");
    }
    const text = bodyRead.text;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return jsonError(400, "request body must be valid JSON", "invalid_request_error");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return jsonError(400, "request body must be a JSON object", "invalid_request_error");
    }
    const tokenSaverHeader = c.req.header("x-9router-token-saver");
    const tokenSaverEnabled = tokenSaverHeader?.toLowerCase() !== "off";
    return routeGenerationRequest(c.get("db"), c.get("logger"), endpoint, body, {
      signal: c.req.raw.signal,
      upstreamConnectTimeoutMs: policy.upstreamConnectTimeoutMs,
      usageKeyIdentity: c.get("usageKey") ?? LOCAL_KEY_IDENTITY,
      tokenSaverEnabled,
    });
  };
  app.post("/v1/chat/completions", generationEndpoint("/v1/chat/completions"));
  app.post("/v1/responses", generationEndpoint("/v1/responses"));
  app.post("/v1/messages", generationEndpoint("/v1/messages"));

  // --- Public auth routes (loopback/same-origin guarded) ---------------------
  // Ordered checks: every /api/auth/* and /api/admin/* request first requires
  // a resolved loopback peer and a same-origin browser request.
  const loopbackGuard = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const peer = resolvePeer(c);
    if (!peer || !isLoopbackAddress(peer) || !allowsAdminBrowserRequest(c.req.raw)) {
      return jsonError(403, "dashboard administration is restricted to same-origin loopback clients", "forbidden");
    }
    await next();
  };
  app.use("/api/auth/*", loopbackGuard);

  app.get("/api/auth/status", (c) => {
    const session = auth.resolveSession(db, c.req.header("cookie"));
    const { passwordHash } = getSettings(db);
    return Response.json(
      {
        authenticated: session !== null,
        hasPassword: passwordHash !== "",
        usesDefaultPassword: passwordHash === "",
        expiresAt: session?.expiresAt ?? null,
      },
      { headers: { "cache-control": "no-store" } },
    );
  });

  app.post("/api/auth/login", async (c) => {
    const peer = resolvePeer(c) ?? "unknown";
    const lock = auth.checkLock(peer);
    if (lock.locked) {
      return new Response(
        JSON.stringify({ error: { message: "too many failed login attempts; try again later", type: "rate_limited" } }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": String(lock.retryAfterSeconds ?? 30) } },
      );
    }
    const body = await c.req.json().catch(() => null) as { password?: unknown } | null;
    if (body === null || typeof body.password !== "string") {
      return jsonError(400, "request body must include a password string", "invalid_request_error");
    }
    const check = await auth.verifyDashboardPassword(db, body.password);
    if (!check.ok) {
      auth.recordLoginFail(peer);
      return jsonError(401, "invalid password", "unauthorized");
    }
    auth.recordLoginSuccess(peer);
    const session = auth.issueSession(db);
    return Response.json(
      { authenticated: true, expiresAt: session.expiresAt },
      { headers: auth.sessionCookieHeaders(session.token, c.req.url) },
    );
  });

  app.post("/api/auth/logout", (c) => {
    auth.revokeSession(db, c.req.header("cookie"));
    return c.body(null, 204, auth.expiredCookieHeader());
  });

  // Browser calls must also be same-origin. A hostile website can connect to
  // 127.0.0.1, so peer-loopback alone is not a CSRF boundary. Origin-less
  // local CLI requests remain supported.
  app.use("/api/admin/*", loopbackGuard);
  // Every admin request (except the one-time OAuth callback, whose state is
  // consumed by consumeState) requires a valid dashboard session.
  app.use("/api/admin/*", async (c, next) => {
    if (c.req.method === "GET" && new URL(c.req.url).pathname === "/api/admin/oauth/codex/callback") {
      return next();
    }
    const session = auth.resolveSession(db, c.req.header("cookie"));
    if (session === null) {
      return jsonError(401, "dashboard session required", "unauthorized");
    }
    return next();
  });

  const admin = new Hono<AppEnv>();
  // Dashboard model catalog. Kept under the loopback-only admin seam so the
  // local dashboard remains usable when gateway-key enforcement protects
  // public /v1 routes.
  admin.get("/models", (c) =>
    Response.json({ object: "list", data: buildModelsListing(c.get("db")) }));

  admin.get("/providers/:provider/models", (c) => {
    const provider = c.req.param("provider");
    if (provider !== "codex" && provider !== "anthropic" && provider !== "openai") {
      return jsonError(404, "provider not found", "not_found");
    }
    const disabled = new Set(getSettings(c.get("db")).disabledModels);
    const entries = new Map<string, { id: string; name: string; disabled: boolean }>();
    const connections = listConnections(c.get("db"));
    for (const catalog of CATALOGS) {
      if (catalog.provider !== provider) continue;
      if (provider === "openai" && !connections.some((connection) => connection.provider === "openai" && connection.data.prefix === "oa")) continue;
      for (const model of catalog.models) {
        entries.set(model.canonical, { id: model.canonical, name: model.name, disabled: disabled.has(model.canonical) });
      }
    }
    for (const connection of connections) {
      if (connection.provider !== provider) continue;
      for (const model of connection.data.models ?? []) {
        const id = provider === "codex" ? `cx/${model}`
          : provider === "anthropic" ? `anthropic/${model}`
            : `${connection.data.prefix}/${model}`;
        entries.set(id, { id, name: model, disabled: disabled.has(id) });
      }
    }
    return Response.json({ models: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)) });
  });

  admin.post("/models/visibility", async (c) => {
    const body = await c.req.json().catch(() => null) as { models?: unknown; disabled?: unknown } | null;
    if (!body || !Array.isArray(body.models) || body.models.length === 0
      || body.models.some((model) => typeof model !== "string" || model.trim() === "")
      || typeof body.disabled !== "boolean") {
      return jsonError(400, "models must be a non-empty string array and disabled must be boolean", "invalid_request_error");
    }
    const models = [...new Set(body.models.map((model) => (model as string).trim()))];
    if (models.some((model) => !isConfiguredCanonicalModel(c.get("db"), model))) {
      return jsonError(400, "every model must be a configured canonical model", "invalid_request_error");
    }
    return Response.json({ disabled: setModelsDisabled(c.get("db"), models, body.disabled) });
  });

  const connectionId = (c: Context<AppEnv>): number | null => {
    const raw = c.req.param("id");
    if (!raw || !/^[1-9]\d*$/.test(raw)) return null;
    const id = Number(raw);
    return Number.isSafeInteger(id) ? id : null;
  };
  const invalidConnectionId = () => jsonError(400, "connection ID must be a positive integer", "invalid_request_error");

  // Connections
  admin.get("/connections", (c) =>
    Response.json({ connections: listConnections(c.get("db")).map(maskConnection) }));

  admin.get("/connections/:id", (c) => {
    const id = connectionId(c);
    if (id === null) return invalidConnectionId();
    const conn = getConnection(c.get("db"), id);
    return conn ? Response.json({ connection: maskConnection(conn) }) : jsonError(404, "connection not found", "not_found");
  });

  admin.post("/connections/priorities", async (c) => {
    const body = await c.req.json().catch(() => null) as { priorities?: unknown } | null;
    if (!body || !Array.isArray(body.priorities) || body.priorities.length === 0) {
      return jsonError(400, "priorities must be a non-empty array", "invalid_request_error");
    }
    const updates: Array<{ id: number; priority: number }> = [];
    const ids = new Set<number>();
    for (const row of body.priorities) {
      if (!row || typeof row !== "object") return jsonError(400, "each priority entry must be an object", "invalid_request_error");
      const { id, priority } = row as { id?: unknown; priority?: unknown };
      if (!Number.isSafeInteger(id) || (id as number) <= 0 || !Number.isSafeInteger(priority) || (priority as number) < 0 || ids.has(id as number)) {
        return jsonError(400, "priority entries require unique positive integer IDs and non-negative integer priorities", "invalid_request_error");
      }
      ids.add(id as number);
      updates.push({ id: id as number, priority: priority as number });
    }
    const db = c.get("db");
    if (updates.some(({ id }) => !getConnection(db, id))) return jsonError(404, "connection not found", "not_found");
    db.transaction(() => {
      const statement = db.query("UPDATE providerConnections SET priority = ?, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?");
      for (const update of updates) statement.run(update.priority, update.id);
    })();
    return Response.json({ connections: updates.map(({ id }) => maskConnection(getConnection(db, id)!)) });
  });

  admin.post("/connections/:id/models", (c) => {
    const id = connectionId(c);
    if (id === null) return invalidConnectionId();
    const connection = getConnection(c.get("db"), id);
    return connection ? discoverConnectionModels(connection) : jsonError(404, "connection not found", "not_found");
  });

  admin.post("/connections", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (body === null || typeof body !== "object") return jsonError(400, "request body must be JSON", "invalid_request_error");
    const result = validateConnectionInput(listConnections(c.get("db")), body as Record<string, unknown>);
    if ("error" in result) return jsonError(400, result.error, "invalid_request_error");
    const conn = createConnection(c.get("db"), result);
    return Response.json({ connection: maskConnection(conn) }, { status: 201 });
  });

  admin.patch("/connections/:id", async (c) => {
    const id = connectionId(c);
    if (id === null) return invalidConnectionId();
    const existing = getConnection(c.get("db"), id);
    if (!existing) return jsonError(404, "connection not found", "not_found");
    const body = await c.req.json().catch(() => null);
    if (body === null || typeof body !== "object") return jsonError(400, "request body must be JSON", "invalid_request_error");
    const result = validateConnectionInput(listConnections(c.get("db")), body as Record<string, unknown>, existing);
    if ("error" in result) return jsonError(400, result.error, "invalid_request_error");
    const conn = updateConnection(c.get("db"), id, result);
    const changedDataKeys = body !== null && typeof body === "object" && "data" in body && body.data && typeof body.data === "object"
      ? Object.keys(body.data as Record<string, unknown>)
      : [];
    if (conn && changedDataKeys.some((key) => key !== "autoPing")) recoverConnectionHealth(c.get("db"), existing);
    const refreshed = conn ? getConnection(c.get("db"), id) : undefined;
    return refreshed ? Response.json({ connection: maskConnection(refreshed) }) : jsonError(404, "connection not found", "not_found");
  });

  admin.post("/connections/:id/activate", (c) => {
    const id = connectionId(c);
    if (id === null) return invalidConnectionId();
    const existing = getConnection(c.get("db"), id);
    if (!existing) return jsonError(404, "connection not found", "not_found");
    updateConnection(c.get("db"), id, { isActive: true });
    recoverConnectionHealth(c.get("db"), existing);
    return Response.json({ connection: maskConnection(getConnection(c.get("db"), id)!) });
  });

  admin.post("/connections/:id/deactivate", (c) => {
    const id = connectionId(c);
    if (id === null) return invalidConnectionId();
    const conn = updateConnection(c.get("db"), id, { isActive: false });
    return conn ? Response.json({ connection: maskConnection(conn) }) : jsonError(404, "connection not found", "not_found");
  });

  admin.delete("/connections/:id", (c) => {
    const id = connectionId(c);
    if (id === null) return invalidConnectionId();
    return deleteConnection(c.get("db"), id)
      ? c.body(null, 204)
      : jsonError(404, "connection not found", "not_found");
  });

  // --- Connection test --------------------------------------------------------
  admin.post("/connections/:id/test", async (c) => {
    const db = c.get("db");
    const id = connectionId(c);
    if (id === null) return invalidConnectionId();
    const conn = getConnection(db, id);
    if (!conn) return jsonError(404, "connection not found", "not_found");

    if (conn.provider === "codex") {
      const result = await testCodexConnection(db, id);
      return connectionTestResponse(db, conn, result);
    }

    if (conn.provider === "anthropic") {
      // Cheapest probe: a minimal Messages call with max_tokens 1.
      const apiKey = conn.data.apiKey;
      if (!apiKey) return connectionTestResponse(db, conn, { ok: false, status: 400, error: "connection is missing an API key" });
      try {
        const res = await fetchAuthenticated(conn.data.baseUrl ?? "https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5",
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          if (!isJsonResponse(res)) {
            await res.body?.cancel().catch(() => {});
            return connectionTestResponse(db, conn, { ok: false, status: 502, error: "connection test expected a JSON response" });
          }
          await res.body?.cancel().catch(() => {});
          return connectionTestResponse(db, conn, { ok: true, status: res.status });
        }
        const text = await readResponseTextLimited(res).catch(() => "");
        return connectionTestResponse(db, conn, { ok: false, status: res.status, error: safeUpstreamMessage(res.status, text, [apiKey]) });
      } catch (err) {
        return connectionTestResponse(db, conn, { ok: false, status: 502, error: sanitizeErrorText((err as Error).message, [apiKey]) });
      }
    }

    // openai-compatible: cheapest probe is GET {baseUrl}/models.
    const apiKey = conn.data.apiKey;
    if (!apiKey) return connectionTestResponse(db, conn, { ok: false, status: 400, error: "connection is missing an API key" });
    try {
      const base = (conn.data.baseUrl ?? OPENAI_PRESET_BASE_URL).replace(/\/+$/, "");
      const res = await fetchAuthenticated(`${base}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        if (!isJsonResponse(res)) {
          await res.body?.cancel().catch(() => {});
          return connectionTestResponse(db, conn, { ok: false, status: 502, error: "connection test expected a JSON response" });
        }
        await res.body?.cancel().catch(() => {});
        return connectionTestResponse(db, conn, { ok: true, status: res.status });
      }
      const text = await readResponseTextLimited(res).catch(() => "");
      return connectionTestResponse(db, conn, { ok: false, status: res.status, error: safeUpstreamMessage(res.status, text, [apiKey]) });
    } catch (err) {
      return connectionTestResponse(db, conn, { ok: false, status: 502, error: sanitizeErrorText((err as Error).message, [apiKey]) });
    }
  });

  // Start the fixed localhost:1455 callback proxy before issuing OAuth state.
  admin.get("/oauth/codex/start", async (c) => {
    const startProxy = policy.startCodexCallbackProxy ?? startCodexCallbackProxy;
    const proxy = await startProxy(oauthAppOrigin, c.get("logger"));
    if (!proxy.ok) {
      return jsonError(409, proxy.error ?? "OAuth callback proxy could not start", "oauth_callback_unavailable");
    }
    const { authorizeUrl } = beginFlow(defaultRedirectUri(), c.get("logger"));
    return Response.json({ authorizeUrl, callbackPort: CODEX_CALLBACK_PORT });
  });

  admin.get("/oauth/codex/callback", async (c) => {
    const db = c.get("db");
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) {
      return jsonError(400, "callback requires code and state parameters", "invalid_request_error");
    }
    const entry = consumeState(state);
    if (!entry) {
      return jsonError(400, "unknown, expired, or already-used state", "invalid_request_error");
    }
    try {
      const tokens = await exchangeCodeForTokens(code, entry.verifier, entry.redirectUri, c.req.raw.signal);
      const conn = createConnection(db, {
        provider: "codex",
        name: `codex-${tokens.accountId ?? Date.now()}`,
        isActive: true,
        data: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? undefined,
          idToken: tokens.idToken ?? undefined,
          expiresAt: tokens.expiresAt,
          accountId: tokens.accountId ?? undefined,
          email: tokens.email ?? undefined,
          planType: tokens.planType ?? undefined,
        },
      });
      return Response.json({ connection: maskConnection(conn) }, { status: 201 });
    } catch (err) {
      return jsonError(502, `token exchange failed: ${(err as Error).message}`, "server_error");
    }
  });

  // Aliases
  admin.get("/aliases", (c) => Response.json({ aliases: listAliases(c.get("db")) }));

  admin.put("/aliases/:name", async (c) => {
    const body = await c.req.json().catch(() => null);
    const target = (body as { target?: unknown } | null)?.target;
    const name = c.req.param("name").trim();
    if (typeof target !== "string" || target.trim() === "") {
      return jsonError(400, "target is required and must name exactly one canonical model", "invalid_request_error");
    }
    if (name === "" || name.includes("/")) {
      return jsonError(400, "alias name must be non-empty and must not contain '/'", "invalid_request_error");
    }
    if ((RESERVED_PREFIXES as readonly string[]).includes(name)) {
      return jsonError(400, "alias name must not use reserved prefix", "invalid_request_error");
    }
    const canonical = target.trim();
    if (!isConfiguredCanonicalModel(c.get("db"), canonical)) {
      return jsonError(400, "alias target must be a configured canonical model", "invalid_request_error");
    }
    const alias = upsertAlias(c.get("db"), name, canonical);
    return Response.json({ alias });
  });

  admin.delete("/aliases/:name", (c) =>
    deleteAlias(c.get("db"), c.req.param("name"))
      ? c.body(null, 204)
      : jsonError(404, "alias not found", "not_found"));

  // Gateway settings + named API keys
  admin.get("/gateway", (c) => {
    const s = getSettings(c.get("db"));
    return Response.json({
      enforce: s.gatewayEnforce,
      enforceRequired: policy.gatewayEnforcementRequired === true,
      keys: listGatewayKeyDtos(c.get("db")),
    });
  });

  admin.post("/gateway/keys", async (c) => {
    const body = await c.req.json().catch(() => null);
    const name = (body as { name?: unknown } | null)?.name;
    const nameError = validateGatewayKeyName(name);
    if (nameError) return jsonError(400, nameError, "invalid_request_error");
    const trimmed = (name as string).trim();
    if (gatewayKeyNameTaken(c.get("db"), trimmed)) {
      return jsonError(409, "a gateway key with that name already exists", "invalid_request_error");
    }
    const created = createGatewayKey(c.get("db"), trimmed);
    // The raw secret appears in this response alone and is never persisted.
    return Response.json(created, { status: 201 });
  });

  admin.patch("/gateway/keys/:id", async (c) => {
    const id = c.req.param("id");
    const db = c.get("db");
    const existing = getGatewayKey(db, id);
    if (!existing) return jsonError(404, "gateway key not found", "not_found");
    const body = await c.req.json().catch(() => null);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return jsonError(400, "request body must be JSON", "invalid_request_error");
    }
    const patch: { name?: string; isActive?: boolean } = {};
    let provided = 0;
    if ("name" in body) {
      const nameError = validateGatewayKeyName((body as Record<string, unknown>).name);
      if (nameError) return jsonError(400, nameError, "invalid_request_error");
      const trimmed = ((body as Record<string, unknown>).name as string).trim();
      if (gatewayKeyNameTaken(db, trimmed, id)) {
        return jsonError(409, "a gateway key with that name already exists", "invalid_request_error");
      }
      patch.name = trimmed;
      provided++;
    }
    if ("isActive" in body) {
      const isActive = (body as Record<string, unknown>).isActive;
      if (typeof isActive !== "boolean") {
        return jsonError(400, "isActive must be a boolean", "invalid_request_error");
      }
      if (!isActive && existing.isActive === 1 && getSettings(db).gatewayEnforce && countActiveGatewayKeys(db) <= 1) {
        return jsonError(409, "create another active key or disable enforcement first", "invalid_request_error");
      }
      patch.isActive = isActive;
      provided++;
    }
    if (provided === 0) {
      return jsonError(400, "provide at least one of name or isActive", "invalid_request_error");
    }
    const updated = updateGatewayKey(db, id, patch);
    return updated
      ? Response.json({ key: { id: updated.id, name: updated.name, keyMasked: `${updated.secretPrefix}••••${updated.secretSuffix}`, isActive: updated.isActive === 1, createdAt: updated.createdAt, updatedAt: updated.updatedAt } })
      : jsonError(404, "gateway key not found", "not_found");
  });

  admin.delete("/gateway/keys/:id", (c) => {
    const id = c.req.param("id");
    const db = c.get("db");
    const existing = getGatewayKey(db, id);
    if (!existing) return jsonError(404, "gateway key not found", "not_found");
    if (existing.isActive === 1 && getSettings(db).gatewayEnforce && countActiveGatewayKeys(db) <= 1) {
      return jsonError(409, "create another active key or disable enforcement first", "invalid_request_error");
    }
    return deleteGatewayKey(db, id)
      ? c.body(null, 204)
      : jsonError(404, "gateway key not found", "not_found");
  });

  admin.put("/gateway/enforce", async (c) => {
    const body = await c.req.json().catch(() => null);
    const enforce = (body as { enforce?: unknown } | null)?.enforce;
    if (typeof enforce !== "boolean") return jsonError(400, "enforce must be a boolean", "invalid_request_error");
    if (!enforce && policy.gatewayEnforcementRequired) {
      return jsonError(400, "gateway enforcement is required for the active non-loopback listener", "invalid_request_error");
    }
    if (enforce && countActiveGatewayKeys(c.get("db")) === 0) {
      return jsonError(400, "cannot enable enforcement without an active gateway key", "invalid_request_error");
    }
    setGatewayEnforce(c.get("db"), enforce);
    return Response.json({ ok: true });
  });

  // Status + usage
  admin.get("/status", (c) => {
    const connections = listConnections(c.get("db"));
    return Response.json({
      version: "0.1.0",
      uptimeSeconds: Math.round(process.uptime()),
      connections: {
        total: connections.length,
        active: connections.filter((x) => x.isActive === 1).length,
      },
      models: buildModelsListing(c.get("db")).length,
    });
  });

  admin.get("/usage", (c) => {
    const date = c.req.query("date");
    return Response.json({ usage: usageSummary(c.get("db"), date) });
  });
  const usagePeriod = (c: Context<AppEnv>): UsagePeriod | Response => {
    const period = (c.req.query("period") ?? "today").toLowerCase();
    return ["today", "24h", "7d", "30d", "60d"].includes(period)
      ? period as UsagePeriod
      : jsonError(400, "period must be one of today, 24h, 7d, 30d, or 60d", "invalid_request_error");
  };

  admin.get("/usage/stats", (c) => {
    const period = usagePeriod(c);
    if (period instanceof Response) return period;
    const { timeline: _timeline, ...stats } = buildUsageAnalytics(c.get("db"), period);
    return Response.json({ ...stats, ...liveUsageSnapshot(c.get("db")) });
  });

  admin.get("/usage/chart", (c) => {
    const period = usagePeriod(c);
    if (period instanceof Response) return period;
    return Response.json(buildUsageAnalytics(c.get("db"), period).timeline.map((point) => ({
      ...point,
      label: period === "today" || period === "24h" ? `${point.hour.slice(11)}:00` : point.hour.slice(5, 10),
      tokens: point.promptTokens + point.completionTokens,
    })));
  });
  admin.get("/usage/providers", (c) => {
    const seen = new Set<string>();
    const providers = listConnections(c.get("db")).flatMap((connection) => {
      const id = connection.provider;
      if (seen.has(id)) return [];
      seen.add(id);
      const name = id === "codex" ? "OpenAI Codex" : id === "anthropic" ? "Anthropic" : "OpenAI-compatible";
      return [{ id, name }];
    });
    return Response.json({ providers });
  });

  admin.get("/usage/request-details", (c) => {
    const integer = (name: string, fallback: number): number | null => {
      const raw = c.req.query(name);
      if (raw === undefined) return fallback;
      if (!/^\d+$/.test(raw)) return null;
      const parsed = Number(raw);
      return Number.isSafeInteger(parsed) ? parsed : null;
    };
    const page = integer("page", 1);
    const pageSize = integer("pageSize", 20);
    if (page === null || page < 1) return jsonError(400, "page must be a positive integer", "invalid_request_error");
    if (pageSize === null || pageSize < 1 || pageSize > 100) return jsonError(400, "pageSize must be between 1 and 100", "invalid_request_error");
    const timestamp = (name: string): number | null | undefined => {
      const raw = c.req.query(name);
      if (!raw) return undefined;
      const parsed = Date.parse(raw);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const startAt = timestamp("startDate");
    const endAt = timestamp("endDate");
    if (startAt === null || endAt === null) return jsonError(400, "dates must be valid ISO timestamps", "invalid_request_error");
    const db = c.get("db");
    const result = requestUsageDetails(db, { page, pageSize, provider: c.req.query("provider") || undefined, startAt, endAt });
    const names = new Map(listConnections(db).map((connection) => [connection.id, connection.name]));
    return Response.json({ ...result, details: result.details.map((detail) => ({ ...detail, connectionName: names.get(detail.connectionId) ?? `Connection ${detail.connectionId}` })) });
  });

  admin.get("/usage/stream", (c) => {
    const encoder = new TextEncoder();
    let closed = false;
    let unsubscribe = () => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = () => {
          if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(liveUsageSnapshot(c.get("db")))}\n\n`));
        };
        const close = () => {
          if (closed) return;
          closed = true;
          unsubscribe();
          if (heartbeat) clearInterval(heartbeat);
          controller.close();
        };
        unsubscribe = subscribeUsageChanges(send);
        heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n")); }, 15_000);
        c.req.raw.signal.addEventListener("abort", close, { once: true });
        send();
      },
      cancel() {
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
  });

  // --- Profile password ------------------------------------------------------
  admin.patch("/profile/password", async (c) => {
    const body = await c.req.json().catch(() => null) as { currentPassword?: unknown; newPassword?: unknown } | null;
    if (body === null || typeof body.currentPassword !== "string" || typeof body.newPassword !== "string") {
      return jsonError(400, "currentPassword and newPassword are required strings", "invalid_request_error");
    }
    const db = c.get("db");
    const peer = resolvePeer(c) ?? "unknown";
    const lock = auth.checkLock(peer);
    if (lock.locked) {
      return new Response(
        JSON.stringify({ error: { message: "too many failed attempts; try again later", type: "rate_limited" } }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": String(lock.retryAfterSeconds ?? 30) } },
      );
    }
    const current = await auth.verifyDashboardPassword(db, body.currentPassword);
    const result = await auth.changeDashboardPassword(db, current.ok, body.newPassword);
    if (!result.ok) {
      if (result.status === 401) auth.recordLoginFail(peer);
      return jsonError(result.status, result.error, result.status === 401 ? "unauthorized" : "invalid_request_error");
    }
    auth.recordLoginSuccess(peer);
    return Response.json(
      { success: true, expiresAt: result.expiresAt },
      { headers: auth.sessionCookieHeaders(result.token, c.req.url) },
    );
  });

  // --- Token Saver -----------------------------------------------------------
  admin.get("/token-saver", (c) => {
    const s = getSettings(c.get("db"));
    return Response.json({
      rtkEnabled: s.rtkEnabled,
      cavemanEnabled: s.cavemanEnabled,
      cavemanLevel: s.cavemanLevel,
      ponytailEnabled: s.ponytailEnabled,
      ponytailLevel: s.ponytailLevel,
    });
  });

  admin.patch("/token-saver", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return jsonError(400, "request body must be JSON", "invalid_request_error");
    }
    const entries = Object.entries(body as Record<string, unknown>);
    if (entries.length === 0) {
      return jsonError(400, "provide at least one setting", "invalid_request_error");
    }
    const patch: {
      rtkEnabled?: boolean; cavemanEnabled?: boolean; cavemanLevel?: "lite" | "full" | "ultra";
      ponytailEnabled?: boolean; ponytailLevel?: "lite" | "full" | "ultra";
    } = {};
    for (const [key, value] of entries) {
      if (key === "rtkEnabled" || key === "cavemanEnabled" || key === "ponytailEnabled") {
        if (typeof value !== "boolean") return jsonError(400, `${key} must be a boolean`, "invalid_request_error");
        patch[key] = value;
      } else if (key === "cavemanLevel" || key === "ponytailLevel") {
        if (value !== "lite" && value !== "full" && value !== "ultra") {
          return jsonError(400, `${key} must be one of lite, full, ultra`, "invalid_request_error");
        }
        patch[key] = value;
      } else {
        return jsonError(400, `unknown token saver setting: ${key}`, "invalid_request_error");
      }
    }
    const updated = updateTokenSaverSettings(c.get("db"), patch);
    return Response.json(updated);
  });

  // --- Backup export / import --------------------------------------------------
  admin.post("/backup/export", async (c) => {
    const body = await c.req.json().catch(() => null) as { password?: unknown } | null;
    if (body === null || typeof body.password !== "string") {
      return jsonError(400, "password is required", "invalid_request_error");
    }
    const db = c.get("db");
    const check = await auth.verifyDashboardPassword(db, body.password);
    if (!check.ok) return jsonError(401, "invalid password", "unauthorized");
    const backup = exportBackup(db);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new Response(JSON.stringify(backup), {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="fast-9router-backup-${timestamp}.json"`,
      },
    });
  });

  admin.post("/backup/import", async (c) => {
    const bodyRead = await readBodyTextLimited(c.req.raw, 10 * 1024 * 1024);
    if (!bodyRead.ok) return jsonError(413, "backup exceeds 10MB limit", "request_too_large");
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyRead.text);
    } catch {
      return jsonError(400, "backup must be valid JSON", "invalid_request_error");
    }
    if (parsed === null || typeof parsed !== "object") {
      return jsonError(400, "backup must be a JSON object", "invalid_request_error");
    }
    const payload = parsed as { password?: unknown; backup?: unknown };
    if (typeof payload.password !== "string") {
      return jsonError(400, "password is required", "invalid_request_error");
    }
    const db = c.get("db");
    const check = await auth.verifyDashboardPassword(db, payload.password);
    if (!check.ok) return jsonError(401, "invalid password", "unauthorized");
    const validation = validateBackupPayload(db, payload.backup);
    if (!validation.ok) return jsonError(400, validation.error, "invalid_request_error");
    const result = importBackup(db, validation.backup);
    return Response.json({ success: true, counts: result });
  });

  // --- Codex quota ------------------------------------------------------------
  admin.get("/quota", async (c) => {
    const pageRaw = c.req.query("page") ?? "1";
    const pageSizeRaw = c.req.query("pageSize") ?? "20";
    const accountStatus = c.req.query("accountStatus") ?? "all";
    const force = c.req.query("force") ?? "0";
    if (!/^\d+$/.test(pageRaw) || Number(pageRaw) < 1) return jsonError(400, "page must be a positive integer", "invalid_request_error");
    if (!/^\d+$/.test(pageSizeRaw) || Number(pageSizeRaw) < 1 || Number(pageSizeRaw) > 50) {
      return jsonError(400, "pageSize must be between 1 and 50", "invalid_request_error");
    }
    if (accountStatus !== "all" && accountStatus !== "active" && accountStatus !== "inactive") {
      return jsonError(400, "accountStatus must be all, active, or inactive", "invalid_request_error");
    }
    if (force !== "0" && force !== "1") {
      return jsonError(400, "force must be 0 or 1", "invalid_request_error");
    }
    const result = await quotaOverview(c.get("db"), {
      page: Number(pageRaw),
      pageSize: Number(pageSizeRaw),
      accountStatus,
      force: force === "1",
    });
    return Response.json(result);
  });

  admin.get("/quota/:id", async (c) => {
    const raw = c.req.param("id");
    if (!raw || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      return jsonError(400, "connection ID must be a positive integer", "invalid_request_error");
    }
    const force = c.req.query("force") ?? "0";
    if (force !== "0" && force !== "1") {
      return jsonError(400, "force must be 0 or 1", "invalid_request_error");
    }
    const connection = getConnection(c.get("db"), Number(raw));
    if (!connection || connection.provider !== "codex") {
      return jsonError(404, "Codex connection not found", "not_found");
    }
    const snapshot = await quotaSnapshotForConnection(c.get("db"), connection, force === "1");
    return Response.json(snapshot);
  });


  admin.route("/cli-tools", createCliToolsApp());

  app.route("/api/admin", admin);

  // Explicit /login SPA route before the wildcard.
  app.get("/login", (c) =>
    serveDashboardFile("/") ??
    jsonError(404, "not found", "not_found"));

  // --- Static dashboard -----------------------------------------------------
  app.get("*", (c) =>
    serveDashboardFile(new URL(c.req.url).pathname) ??
    jsonError(404, "not found", "not_found"));

  return app;
}
