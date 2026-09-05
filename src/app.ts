// Hono application: gateway auth, /v1/models, generation endpoints, admin
// API (connections, OAuth, aliases, gateway, status, usage), static dashboard.
//
// The app is constructed with an open Database handle; `app.fetch` is the
// testing seam.

import { timingSafeEqual } from "node:crypto";
import { Hono, type Context, type Env } from "hono";
import { cors } from "hono/cors";
import type { Database } from "bun:sqlite";
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
  setGatewayKey,
  setGatewayEnforce,
  setModelsDisabled,
  usageSummary,
  requestUsageDetails,
  type ConnectionData,
  type ProviderConnectionWithCooldown,
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
import { canonicalBaseUrl, fetchAuthenticated, isLoopbackAddress, isLoopbackHostname, isValidGatewayKey } from "./network.ts";
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

import { liveUsageSnapshot, subscribeUsageChanges } from "./usage-live.ts";
export interface AppEnv extends Env {
  Variables: {
    db: Database;
    logger: Logger;
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
// Validation
// ---------------------------------------------------------------------------


/** Base URL rules: http(s) only, no username/password/fragment/query. */
export function validateBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return "base URL must be a string";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "base URL must be a valid absolute http(s) URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "base URL must use http or https";
  }
  if (url.username || url.password) return "base URL must not contain credentials";
  if (url.hash) return "base URL must not contain a fragment";
  if (url.search) return "base URL must not contain a query string";
  return null;
}


/** Compatible prefix syntax and upstream-consistency rules. */
export function validatePrefix(
  prefix: unknown,
  db: Database,
  baseUrl: string,
  excludeConnectionId?: number,
): string | null {
  if (typeof prefix !== "string" || prefix === "") {
    return "prefix is required for openai-compatible connections";
  }
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(prefix)) {
    return "prefix must be 1-32 chars of lowercase letters, digits, or dashes";
  }
  // cx/anthropic belong to the fixed providers; `oa` is the official [OI]
  // preset namespace and is allowed.
  if (prefix === "cx" || prefix === "anthropic") {
    return `prefix '${prefix}' is reserved`;
  }
  const normalizedBaseUrl = canonicalBaseUrl(baseUrl);
  if (prefix === "oa" && normalizedBaseUrl !== canonicalBaseUrl(OPENAI_PRESET_BASE_URL)) {
    return "prefix 'oa' is reserved for the official OpenAI endpoint";
  }
  const conflict = listConnections(db).find(
    (connection) =>
      connection.id !== excludeConnectionId &&
      connection.provider === "openai" &&
      connection.data.prefix === prefix &&
      canonicalBaseUrl(connection.data.baseUrl ?? OPENAI_PRESET_BASE_URL) !== normalizedBaseUrl,
  );
  if (conflict) return `prefix '${prefix}' is already assigned to a different upstream`;
  return null;
}

const PROVIDER_DATA_KEYS = {
  codex: ["accessToken", "refreshToken", "idToken", "expiresAt", "accountId", "email", "planType", "models", "autoPing"],
  anthropic: ["apiKey", "baseUrl", "models", "autoPing"],
  openai: ["apiKey", "baseUrl", "prefix", "models", "autoPing"],
} as const;

function validateConnectionInput(
  db: Database,
  body: Record<string, unknown>,
  existing?: ProviderConnectionWithCooldown,
): { error: string } | { data: ConnectionData; provider: string; name: string; isActive: boolean; priority: number } {
  if (existing && body.provider !== undefined && body.provider !== existing.provider) {
    return { error: "connection provider cannot be changed" };
  }
  const provider = body.provider ?? existing?.provider;
  if (provider !== "codex" && provider !== "anthropic" && provider !== "openai") {
    return { error: "provider must be one of codex, anthropic, openai" };
  }
  const name = body.name ?? existing?.name;
  if (typeof name !== "string" || name.trim() === "") return { error: "name is required" };
  if (body.isActive !== undefined && typeof body.isActive !== "boolean") {
    return { error: "isActive must be a boolean" };
  }
  const priority = body.priority ?? existing?.priority ?? 0;
  if (typeof priority !== "number" || !Number.isSafeInteger(priority)) {
    return { error: "priority must be an integer" };
  }

  const rawDataValue = body.data;
  if (rawDataValue !== undefined && (rawDataValue === null || typeof rawDataValue !== "object" || Array.isArray(rawDataValue))) {
    return { error: "data must be a JSON object" };
  }
  const rawData = { ...((rawDataValue ?? {}) as Record<string, unknown>) };
  const allowedDataKeys = PROVIDER_DATA_KEYS[provider] as readonly string[];
  const unsupportedKey = Object.keys(rawData).find((key) => !allowedDataKeys.includes(key));
  if (unsupportedKey) {
    return { error: `unsupported ${provider} connection data field: ${unsupportedKey}` };
  }

  if (rawData.apiKey === MASK) {
    if (!existing?.data.apiKey) return { error: "masked API key sentinel cannot be stored" };
    delete rawData.apiKey;
  }

  const existingData = Object.fromEntries(
    Object.entries(existing?.data ?? {}).filter(([key]) => allowedDataKeys.includes(key)),
  );
  const merged = { ...existingData, ...rawData } as Record<string, unknown>;
  if (rawData.apiKey === null) delete merged.apiKey;
  for (const key of ["apiKey", "accessToken", "refreshToken", "idToken", "accountId", "email", "planType"] as const) {
    if (merged[key] !== undefined && typeof merged[key] !== "string") {
      return { error: `${key} must be a string` };
    }
  }
  if (merged.expiresAt !== undefined && (typeof merged.expiresAt !== "number" || !Number.isFinite(merged.expiresAt))) {
    return { error: "expiresAt must be a finite number" };
  }
  if (merged.baseUrl !== undefined) {
    const baseUrlError = validateBaseUrl(merged.baseUrl);
    if (baseUrlError) return { error: baseUrlError };
    merged.baseUrl = canonicalBaseUrl(merged.baseUrl as string);
  }
  if (merged.models !== undefined) {
    if (!Array.isArray(merged.models) || merged.models.some((model) => typeof model !== "string" || model.trim() === "")) {
      return { error: "models must be an array of non-empty strings" };
    }
    merged.models = [...new Set(merged.models.map((model) => model.trim()))];
  }
  if (merged.autoPing !== undefined && typeof merged.autoPing !== "boolean") {
    return { error: "autoPing must be a boolean" };
  }
  if (provider === "openai") {
    merged.baseUrl ??= OPENAI_PRESET_BASE_URL;
    if (typeof merged.baseUrl !== "string") return { error: "base URL must be a string" };
    const prefixError = validatePrefix(merged.prefix, db, merged.baseUrl, existing?.id);
    if (prefixError) return { error: prefixError };
  }

  // All ConnectionData fields have been narrowed above.
  const data = merged as ConnectionData;
  return {
    provider,
    name: name.trim(),
    isActive: body.isActive !== undefined ? body.isActive : (existing ? existing.isActive === 1 : true),
    priority,
    data,
  };
}

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

function gatewayKeyMatches(candidate: string | null, expected: string): boolean {
  if (candidate === null) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length
    && timingSafeEqual(candidateBytes, expectedBytes);
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
    allowHeaders: ["authorization", "content-type"],
  }));

  // --- Gateway auth ---------------------------------------------------------
  app.use("/v1/*", async (c, next) => {
    const settings = getSettings(db);
    if (!settings.gatewayEnforce) return next();
    if (!isValidGatewayKey(settings.gatewayKey)) {
      return jsonError(503, "gateway authentication is misconfigured", "server_error");
    }
    const token = bearerToken(c.req.header("authorization"));
    if (!gatewayKeyMatches(token, settings.gatewayKey)) {
      return jsonError(401, "invalid or missing gateway API key", "invalid_request_error");
    }
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
    const keyName = getSettings(c.get("db")).gatewayEnforce ? "Gateway API Key" : "Local (No API Key)";
    return routeGenerationRequest(
      c.get("db"),
      c.get("logger"),
      endpoint,
      body,
      c.req.raw.signal,
      policy.upstreamConnectTimeoutMs,
      undefined,
      keyName,
    );
  };
  app.post("/v1/chat/completions", generationEndpoint("/v1/chat/completions"));
  app.post("/v1/responses", generationEndpoint("/v1/responses"));
  app.post("/v1/messages", generationEndpoint("/v1/messages"));

  // Browser calls must also be same-origin. A hostile website can connect to
  // 127.0.0.1, so peer-loopback alone is not a CSRF boundary. Origin-less
  // local CLI requests remain supported.
  app.use("/api/admin/*", async (c, next) => {
    const peer = resolvePeer(c);
    if (!peer || !isLoopbackAddress(peer) || !allowsAdminBrowserRequest(c.req.raw)) {
      return jsonError(403, "dashboard administration is restricted to same-origin loopback clients", "forbidden");
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
    const result = validateConnectionInput(c.get("db"), body as Record<string, unknown>);
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
    const result = validateConnectionInput(c.get("db"), body as Record<string, unknown>, existing);
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

  // Gateway settings
  admin.get("/gateway", (c) => {
    const s = getSettings(c.get("db"));
    const keyConfigured = isValidGatewayKey(s.gatewayKey);
    return Response.json({
      enforce: s.gatewayEnforce,
      keyConfigured,
      keyMasked: keyConfigured ? MASK : null,
      enforceRequired: policy.gatewayEnforcementRequired === true,
    });
  });

  admin.put("/gateway/key", async (c) => {
    const body = await c.req.json().catch(() => null);
    const key = (body as { key?: unknown } | null)?.key;
    const normalizedKey = typeof key === "string" ? key.trim() : "";
    if (!isValidGatewayKey(normalizedKey)) {
      return jsonError(400, "gateway key must be a non-empty string of at least 8 characters", "invalid_request_error");
    }
    setGatewayKey(c.get("db"), normalizedKey);
    return Response.json({ ok: true });
  });

  admin.put("/gateway/enforce", async (c) => {
    const body = await c.req.json().catch(() => null);
    const enforce = (body as { enforce?: unknown } | null)?.enforce;
    if (typeof enforce !== "boolean") return jsonError(400, "enforce must be a boolean", "invalid_request_error");
    if (!enforce && policy.gatewayEnforcementRequired) {
      return jsonError(400, "gateway enforcement is required for the active non-loopback listener", "invalid_request_error");
    }
    if (enforce && !isValidGatewayKey(getSettings(c.get("db")).gatewayKey)) {
      return jsonError(400, "cannot enable enforcement without a valid gateway key", "invalid_request_error");
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


  app.route("/api/admin", admin);

  // --- Static dashboard -----------------------------------------------------
  app.get("*", (c) =>
    serveDashboardFile(new URL(c.req.url).pathname) ??
    jsonError(404, "not found", "not_found"));

  return app;
}
