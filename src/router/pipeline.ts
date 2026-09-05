// Routing pipeline shared by the three generation endpoints: model
// resolution (alias -> canonical -> provider + upstream model), account
// routing with fallback, response translation, streaming with backpressure,
// usage recording, and request logging.

import type { Database } from "bun:sqlite";
import { CATALOGS, OPENAI_PRESET_BASE_URL } from "../catalog.ts";
import {
  listActiveConnections,
  getSettings,
  listAliases,
  recordUsage,
  type ProviderConnectionWithCooldown,
} from "../db.ts";
import type { Logger } from "../log.ts";
import {
  fromOpenaiChatRequest,
  fromResponsesRequest,
  fromClaudeRequest,
  translateResponse,
  translateStream,
  type ClientFormat,
  type NormalizedRequest,
} from "../translate/index.ts";
import { callAnthropic } from "../adapters/anthropic.ts";
import { callOpenaiCompatible } from "../adapters/openai-compatible.ts";
import { callCodex } from "../adapters/codex.ts";
import type { AdapterResult } from "../adapters/types.ts";
import { beginActiveRequest, endActiveRequest, setActiveRequestConnection } from "../usage-live.ts";
import { routeWithFallback, classifyFailure, cooldownConnection, type AttemptOutcome } from "./accounts.ts";
import { canonicalBaseUrl } from "../network.ts";

export type Endpoint = "/v1/chat/completions" | "/v1/responses" | "/v1/messages";

const CLIENT_FORMATS: Record<Endpoint, ClientFormat> = {
  "/v1/chat/completions": "openai",
  "/v1/responses": "openai-responses",
  "/v1/messages": "claude",
};

const DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS = 60_000;

/** Client-format normalizer per endpoint. */
const NORMALIZERS: Record<Endpoint, (body: Record<string, unknown>) => NormalizedRequest> = {
  "/v1/chat/completions": (body) => fromOpenaiChatRequest(body),
  "/v1/responses": (body) => fromResponsesRequest(body),
  "/v1/messages": (body) => fromClaudeRequest(body),
};

export interface ResolvedModel {
  provider: "codex" | "anthropic" | "openai";
  /** Router-canonical model id (used for usage rows). */
  canonical: string;
  /** Upstream model id sent to the provider. */
  upstreamModel: string;
  /** openai-compatible connections must match this prefix. */
  prefix?: string;
  /** Eligible compatible connection ids for this exact prefix/model. */
  connectionIds?: readonly number[];
}

/**
 * Resolve the requested model: alias -> canonical; canonical `prefix/model`
 * -> provider + upstream model via catalog (cx -review variants map to the
 * base upstream id) or via openai-compatible connection prefixes. Unknown
 * model -> null (400).
 */
export function connectionIsRoutable(
  connection: ProviderConnectionWithCooldown,
  now = Date.now(),
): boolean {
  if (connection.provider === "openai" && connection.data.prefix === "oa") {
    try {
      if (canonicalBaseUrl(connection.data.baseUrl ?? OPENAI_PRESET_BASE_URL)
        !== canonicalBaseUrl(OPENAI_PRESET_BASE_URL)) return false;
    } catch {
      return false;
    }
  }
  if (connection.provider === "codex") {
    if (!connection.data.accessToken) return false;
    return typeof connection.data.expiresAt !== "number"
      || connection.data.expiresAt > now
      || Boolean(connection.data.refreshToken);
  }
  return Boolean(connection.data.apiKey);
}

export function connectionSupportsModel(
  connection: ProviderConnectionWithCooldown,
  model: string,
): boolean {
  const models = connection.data.models ?? [];
  return models.length === 0 || models.includes(model);
}
const THINKING_SUFFIXES = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function splitThinkingSuffix(requested: string): { model: string; effort?: string } {
  const match = /^(.*)\(([^()]+)\)$/.exec(requested);
  if (!match || !THINKING_SUFFIXES.has(match[2]!)) return { model: requested };
  return { model: match[1]!, effort: match[2]! };
}


export function resolveModel(
  db: Database,
  requested: string,
  activeConnections: ProviderConnectionWithCooldown[] = listActiveConnections(db),
): ResolvedModel | null {
  let canonical = requested;
  const alias = listAliases(db).find((a) => a.name === requested);
  if (alias) canonical = alias.target;
  if (getSettings(db).disabledModels.includes(canonical)) return null;

  const slash = canonical.indexOf("/");
  if (slash === -1) return null;
  const prefix = canonical.slice(0, slash);
  const model = canonical.slice(slash + 1);
  const prefixConnections = activeConnections.filter(
    (connection) => connection.provider === "openai" && connection.data.prefix === prefix,
  );
  const capableConnections = prefixConnections.filter((connection) =>
    connectionSupportsModel(connection, model));
  const anthropicConnections = activeConnections.filter((connection) => connection.provider === "anthropic");
  const capableAnthropicConnections = anthropicConnections.filter((connection) => connectionSupportsModel(connection, model));

  const catalog = CATALOGS.find((candidate) => candidate.prefix === prefix);
  if (catalog) {
    const entry = catalog.models.find((candidate) => candidate.id === model || candidate.canonical === canonical);
    if (entry) {
      if (prefix === "oa" && capableConnections.length === 0) return null;
      if (prefix === "anthropic" && capableAnthropicConnections.length === 0) return null;
      const connectionIds = prefix === "oa"
        ? capableConnections.map((connection) => connection.id)
        : prefix === "anthropic"
          ? capableAnthropicConnections.map((connection) => connection.id)
          : undefined;
      return {
        provider: catalog.provider as ResolvedModel["provider"],
        canonical: entry.canonical,
        upstreamModel: entry.upstreamModelId ?? entry.id,
        ...(prefix === "oa" ? { prefix } : {}),
        ...(connectionIds ? { connectionIds } : {}),
      };
    }
    if (prefix === "anthropic") {
      const declared = anthropicConnections.filter((connection) => connection.data.models?.includes(model));
      if (declared.length === 0) return null;
      return { provider: "anthropic", canonical, upstreamModel: model, connectionIds: declared.map((connection) => connection.id) };
    }
    if (prefix === "cx") {
      const declared = activeConnections.filter((connection) => connection.provider === "codex" && connection.data.models?.includes(model));
      if (declared.length === 0) return null;
      return { provider: "codex", canonical, upstreamModel: model, connectionIds: declared.map((connection) => connection.id) };
    }
    if (prefix !== "oa") return null;
  }
  if (capableConnections.length === 0) return null;
  return {
    provider: "openai",
    canonical,
    upstreamModel: model,
    prefix,
    connectionIds: capableConnections.map((connection) => connection.id),
  };
} 

// ---------------------------------------------------------------------------
// Adapter dispatch
// ---------------------------------------------------------------------------

function adapterFor(provider: ResolvedModel["provider"]) {
  switch (provider) {
    case "anthropic":
      return callAnthropic;
    case "codex":
      return callCodex;
    default:
      return callOpenaiCompatible;
  }
}

// ---------------------------------------------------------------------------
// Response construction
// ---------------------------------------------------------------------------

function sseResponse(
  stream: ReadableStream<Uint8Array>,
  rateLimitHeaders: Record<string, string>,
  status = 200,
): Response {
  return new Response(stream, {
    status,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...rateLimitHeaders,
    },
  });
}

export type StreamFinalizer = (failed: boolean, status: number) => Promise<void>;

/**
 * Pull-based pass-through stream. One source chunk is read per consumer pull;
 * terminal accounting runs exactly once for EOF, cancel, or source error.
 */
export function withStreamFinalizer(
  source: ReadableStream<Uint8Array>,
  abort: AbortController,
  successStatus: number,
  onFinalize: StreamFinalizer,
  streamCompleted: () => boolean = () => false,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let finalized = false;
  const finalize = async (failed: boolean, status: number) => {
    if (finalized) return;
    finalized = true;
    await onFinalize(failed, status);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          await finalize(false, successStatus);
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        const completed = streamCompleted();
        abort.abort(error);
        await finalize(!completed, completed ? successStatus : 502);
        if (completed) controller.close();
        else controller.error(error);
      }
    },
    async cancel(reason) {
      abort.abort(reason);
      try {
        await reader.cancel(reason);
      } finally {
        const completed = streamCompleted();
        await finalize(!completed, completed ? successStatus : 499);
      }
    },
  });
}

/** Buffer an upstream SSE stream to its final frame and translate to the client format. */
async function bufferStreamToFinal(
  stream: ReadableStream<Uint8Array>,
  from: ClientFormat,
  to: ClientFormat,
  opts: { model?: string; customToolNames?: Set<string> },
): Promise<{ body: Record<string, unknown> | null; usage: { promptTokens: number | null; completionTokens: number | null } | null }> {
  const decoder = new TextDecoder();
  let text = "";
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  // Assemble the "final" upstream event from the SSE stream:
  // openai chat -> the last chunk with choices/usage; responses -> the
  // terminal response.completed object; claude -> reconstruct nothing (the
  // translator's stream->final assembler handles it via translateResponse on
  // the assembled terminal frame).
  let finalBody: Record<string, unknown> | null = null;
  let usage: { promptTokens: number | null; completionTokens: number | null } | null = null;
  for (const frame of text.split("\n\n")) {
    const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    const raw = dataLine.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (from === "openai-responses") {
      const type = parsed.type;
      if (type === "response.completed" && parsed.response && typeof parsed.response === "object") {
        finalBody = parsed.response as Record<string, unknown>;
      }
    } else {
      // chat completions / claude: keep the last parseable frame
      finalBody = parsed;
    }
  }
  return { body: finalBody, usage };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * Full routing pipeline for a generation endpoint. `body` is the parsed JSON
 * client payload. Never throws: errors come back as error Responses.
 */
export async function routeGenerationRequest(
  db: Database,
  logger: Logger,
  endpoint: Endpoint,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  upstreamConnectTimeoutMs = DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS,
  onlyConnectionIds?: readonly number[],
  keyName = "Local (No API Key)",
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const clientFormat = CLIENT_FORMATS[endpoint];
  const streamAbort = new AbortController();
  const abortSignal = signal
    ? AbortSignal.any([signal, streamAbort.signal])
    : streamAbort.signal;
  const requestedModel = body.model;
  if (typeof requestedModel !== "string" || requestedModel === "") {
    return errorJson(400, "request body must include a model", "invalid_request_error");
  }
  const selection = splitThinkingSuffix(requestedModel);
  const activeConnections = listActiveConnections(db).filter((connection) => connectionIsRoutable(connection) && (!onlyConnectionIds || onlyConnectionIds.includes(connection.id)));
  const resolved = resolveModel(db, selection.model, activeConnections);
  if (!resolved) {
    return errorJson(400, `unknown model: ${requestedModel}`, "invalid_request_error");
  }
  let normalized: NormalizedRequest;
  try {
    normalized = NORMALIZERS[endpoint](body);
  } catch (err) {
    return errorJson(400, `invalid request payload: ${(err as Error).message}`, "invalid_request_error");
  }
  if (selection.effort) normalized.reasoning = { ...(normalized.reasoning ?? {}), effort: selection.effort };

  const liveRequestId = beginActiveRequest(resolved.prefix ?? resolved.provider, resolved.canonical, 0);
  const customToolNames = new Set(
    (normalized.tools ?? [])
      .filter((t) => t.custom === true)
      .map((t) => t.name),
  );
  const translateOpts = { model: requestedModel, customToolNames };

  const adapter = adapterFor(resolved.provider);
  const held: {
    response?: Response;
    usage?: Promise<{ promptTokens: number | null; completionTokens: number | null; cachedTokens?: number } | null>;
    streamCompleted?: () => boolean;
  } = {};
  // Compatible prefixes are distinct upstream seams. The resolver also
  // narrows accounts to those that actually expose the requested model.
  const eligibleIds = resolved.connectionIds;
  const routeConnections = eligibleIds
    ? activeConnections.filter((connection) => eligibleIds.includes(connection.id))
    : activeConnections;
  const route = await routeWithFallback(
    db,
    resolved.provider,
    async (connection): Promise<AttemptOutcome> => {
      setActiveRequestConnection(liveRequestId, connection.id);
      const attemptAbort = new AbortController();
      const attemptSignal = AbortSignal.any([abortSignal, attemptAbort.signal]);
      const timeoutMs = Number.isFinite(upstreamConnectTimeoutMs) && upstreamConnectTimeoutMs > 0
        ? upstreamConnectTimeoutMs
        : DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        attemptAbort.abort();
      }, timeoutMs);
      let result: AdapterResult;
      try {
        result = await adapter({
          request: normalized,
          connection,
          upstreamModel: resolved.upstreamModel,
          signal: attemptSignal,
          db,
        });
      } catch (error) {
        if (timedOut && !abortSignal.aborted) throw new Error("upstream response timeout");
        throw error;
      } finally {
        clearTimeout(timeout);
      }
      if (!result.ok) {
        const sensitiveValues = [
          connection.data.apiKey,
          connection.data.accessToken,
          connection.data.refreshToken,
          connection.data.idToken,
        ].filter((value): value is string => typeof value === "string");
        return classifyFailure(result.status, result.bodyText, result.retryAfter, sensitiveValues);
      }

      // Success: build the client response now (before returning "ok") so
      // adapter errors during body handling surface as the correct outcome.
      const upstreamFormat = result.result.format;

      if (normalized.stream) {
        let streamBody: ReadableStream<Uint8Array>;
        if (upstreamFormat === clientFormat) {
          streamBody = result.result.body as ReadableStream<Uint8Array>;
        } else {
          const transform = translateStream(upstreamFormat, clientFormat, translateOpts);
          streamBody = (result.result.body as ReadableStream<Uint8Array>).pipeThrough(transform);
        }
        held.response = sseResponse(streamBody, result.result.rateLimitHeaders);
        held.usage = result.result.usage;
        held.streamCompleted = result.result.streamCompleted;
        return { kind: "ok" };
      }

      if (result.result.kind === "stream") {
        // Upstream only streams (codex): buffer to a final payload.
        const { body: finalBody } = await bufferStreamToFinal(
          result.result.body as ReadableStream<Uint8Array>,
          upstreamFormat,
          clientFormat,
          translateOpts,
        );
        if (!finalBody) {
          return classifyFailure(502, JSON.stringify({ error: { message: "upstream stream ended without a final payload" } }), null);
        }
        held.response = Response.json(finalBody, { headers: result.result.rateLimitHeaders });
        held.usage = result.result.usage;
        return { kind: "ok" };
      }

      const translated = translateResponse(
        result.result.body as Record<string, unknown>,
        upstreamFormat,
        clientFormat,
        translateOpts,
      ) as Record<string, unknown>;
      held.response = Response.json(translated, { headers: result.result.rateLimitHeaders });
      held.usage = result.result.usage;
      return { kind: "ok" };
    },
    { signal: abortSignal, connections: routeConnections },
  );

  
  if (route.error !== undefined || held.response === undefined || held.usage === undefined) {
    const e = route.error ??
      { status: 502, message: "routing produced no response", type: "server_error" };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if ("retryAfterSeconds" in e && e.retryAfterSeconds !== undefined) {
      headers["retry-after"] = String(e.retryAfterSeconds);
    }
    if ("connectionId" in e && e.connectionId !== undefined) {
      recordUsage(db, {
        provider: resolved.provider,
        model: resolved.canonical,
        connectionId: e.connectionId,
        promptTokens: null,
        completionTokens: null,
        failed: true,
        endpoint,
        status: e.status,
        latencyMs: Date.now() - startedAt,
        keyName,
      });
    }
    endActiveRequest(liveRequestId, true);
    logger.request({
      requestId,
      endpoint,
      provider: resolved.provider,
      model: resolved.canonical,
      connectionId: "connectionId" in e ? e.connectionId : undefined,
      latencyMs: Date.now() - startedAt,
      status: e.status,
    });
    const payload = JSON.stringify({ error: { message: e.message, type: e.type } });
    return new Response(payload, { status: e.status, headers });
  }

  const ttftMs = Date.now() - startedAt;
  const response = held.response;
  const connectionId = route.connection.id;

  const finish: StreamFinalizer = async (failed, status) => {
    if (failed && status >= 500) {
      cooldownConnection(db, route.connection, `upstream stream failed (${status})`);
    }
    const usage = await held.usage!.catch(() => null);
    recordUsage(db, {
      provider: resolved.provider,
      model: resolved.canonical,
      connectionId,
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      cachedTokens: usage?.cachedTokens ?? null,
      endpoint,
      status,
      latencyMs: Date.now() - startedAt,
      ttftMs,
      failed,
      keyName,
    });
    endActiveRequest(liveRequestId, failed);
    logger.request({
      requestId,
      endpoint,
      provider: resolved.provider,
      model: resolved.canonical,
      connectionId,
      latencyMs: Date.now() - startedAt,
      status,
      usage: usage ?? undefined,
    });
  };
  if (normalized.stream) {
    const inner = response.body;
    if (!inner) {
      await finish(true, 502);
      return new Response(null, { status: response.status, headers: response.headers });
    }
    return new Response(
      withStreamFinalizer(inner, streamAbort, response.status, finish, held.streamCompleted),
      {
        status: response.status,
        headers: response.headers,
      },
    );
  }
  await finish(false, response.status);
  return response;
}


function errorJson(status: number, message: string, type: string): Response {
  return Response.json({ error: { message, type } }, { status });
}
