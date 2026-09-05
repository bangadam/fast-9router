// Codex adapter: OAuth-authenticated upstream Responses API at the private
// ChatGPT backend endpoint. Every Codex-specific detail lives here (PRD):
// identity headers, account binding, tool normalization, reasoning effort
// normalization, system→developer conversion, server-item-ID stripping,
// image prefetch, and forced streaming.
import {
  toResponsesRequest,
  normalizeCodexResponsesRequest,
  extractUsage,
  type ClientFormat,
  type NormalizedRequest,
  type NormalizedMessage,
  type ContentPart,
} from "../translate/index.ts";
import type { Database } from "bun:sqlite";
import { getConnection } from "../db.ts";
import { ensureFreshCodexTokens } from "../oauth/codex.ts";
import {
  codexEndpoint,
  codexIdentityHeaders,
  prefetchImageAsDataUri,
  type CodexIdentity,
} from "./codex-transport.ts";
import { isEventStream, type AdapterArgs, type AdapterResult } from "./types.ts";
import { streamWithUsage } from "./anthropic.ts";
import { fetchAuthenticated } from "../network.ts";
import { readResponseTextLimited, safeUpstreamMessage, sanitizeErrorText } from "../upstream-error.ts";

/** Per-process session id per connection (identity header; not a secret). */
const sessionIds = new Map<number, string>();

function sessionIdFor(connectionId: number): string {
  let id = sessionIds.get(connectionId);
  if (!id) {
    id = crypto.randomUUID();
    sessionIds.set(connectionId, id);
  }
  return id;
}

async function prefetchImages(
  request: NormalizedRequest,
  signal?: AbortSignal,
): Promise<NormalizedRequest> {
  let touched = false;
  const messages = await Promise.all(
    request.messages.map(async (m: NormalizedMessage) => {
      if (typeof m.content === "string") return m;
      const content = await Promise.all(
        m.content.map(async (part: ContentPart) => {
          if (part.type !== "image" || part.image_url.startsWith("data:")) return part;
          const result = await prefetchImageAsDataUri(part.image_url, signal);
          // On failure keep the original URL: the upstream decides; a hard
          // client error here would break otherwise-valid requests.
          return result.dataUri ? { ...part, image_url: result.dataUri } : part;
        }),
      );
      touched = true;
      return { ...m, content };
    }),
  );
  return touched ? { ...request, messages } : request;
}

function safeRateLimitHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["retry-after", "x-codex-primary-used-percent", "x-codex-secondary-used-percent"]) {
    const v = res.headers.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

export async function callCodex(args: AdapterArgs): Promise<AdapterResult> {
  const { request, connection, upstreamModel, signal, db } = args;

  // Refresh single-flight: concurrent requests for this connection share one
  // refresh; the rotated refresh token persists atomically before we call.
  let data = connection.data;
  try {
    data = await ensureFreshCodexTokens(db, connection, signal);
  } catch (err) {
    if (signal?.aborted || ((err as Error).name === "AbortError")) throw err;
    return {
      ok: false,
      status: 502,
      bodyText: JSON.stringify({ error: { message: `token refresh failed: ${(err as Error).message}` } }),
      retryAfter: null,
    };
  }
  const accessToken = data.accessToken;
  if (!accessToken) {
    return { ok: false, status: 500, bodyText: JSON.stringify({ error: { message: "connection has no access token" } }), retryAfter: null };
  }

  const identity: CodexIdentity = {
    sessionId: sessionIdFor(connection.id),
    chatgptAccountId: data.accountId,
  };

  const withImages = await prefetchImages({ ...request, model: upstreamModel }, signal);
  // Codex upstream is always Responses-format and always streaming (the
  // backend rejects stream:false); non-streaming clients get the buffered
  // final payload from the routing layer.
  const payload = normalizeCodexResponsesRequest(
    toResponsesRequest({ ...withImages, stream: true }),
  );

  const res = await fetchAuthenticated(codexEndpoint(), {
    method: "POST",
    headers: {
      ...codexIdentityHeaders(identity),
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok) {
    const bodyText = await readResponseTextLimited(res).catch(() => "");
    return { ok: false, status: res.status, bodyText, retryAfter: res.headers.get("retry-after") };
  }

  if (!res.body || !isEventStream(res)) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, status: 502, bodyText: JSON.stringify({ error: { message: "codex upstream did not return an event stream" } }), retryAfter: null };
  }

  const rateLimitHeaders = safeRateLimitHeaders(res);
  const monitored = streamWithUsage(res.body, "openai-responses", args.signal);
  return {
    ok: true,
    result: {
      kind: "stream",
      format: "openai-responses" as ClientFormat,
      body: monitored.body,
      rateLimitHeaders,
      streamCompleted: monitored.isComplete,
      usage: monitored.usage,
    },
  };
}

export const codexAdapter = {
  id: "codex" as const,
  call: callCodex,
};

/** Connection-test probe: tiny responses request with max output 1. */
export async function testCodexConnection(
  db: Database,
  connectionId: number,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const connection = getConnection(db, connectionId);
  if (!connection) return { ok: false, status: 404, error: "connection not found" };
  let data = connection.data;
  try {
    data = await ensureFreshCodexTokens(db, connection);
  } catch (err) {
    return { ok: false, status: 401, error: `token refresh failed: ${sanitizeErrorText((err as Error).message, [connection.data.accessToken ?? "", connection.data.refreshToken ?? "", connection.data.idToken ?? ""])}` };
  }
  if (!data.accessToken) return { ok: false, status: 401, error: "connection has no access token" };
  if (typeof data.expiresAt === "number" && data.expiresAt <= Date.now()) {
    return { ok: false, status: 401, error: "access token expired" };
  }
  const payload = normalizeCodexResponsesRequest(
    toResponsesRequest({
      model: "gpt-5.4-mini",
      stream: true,
      max_tokens: 16,
      messages: [{ role: "user", content: "ping" }],
    }),
  );
  try {
    const res = await fetchAuthenticated(codexEndpoint(), {
      method: "POST",
      headers: {
        ...codexIdentityHeaders({ sessionId: sessionIdFor(connection.id), chatgptAccountId: data.accountId }),
        authorization: `Bearer ${data.accessToken}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = await readResponseTextLimited(res).catch(() => "");
      return { ok: false, status: res.status, error: safeUpstreamMessage(res.status, text, [data.accessToken, data.refreshToken ?? "", data.idToken ?? ""]) };
    }
    if (!isEventStream(res)) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, status: 502, error: "connection test expected an event stream" };
    }
    // A 2xx SSE response proves the credential; drain a little and stop.
    await res.body?.cancel().catch(() => {});
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, status: 502, error: sanitizeErrorText((err as Error).message, [data.accessToken, data.refreshToken ?? "", data.idToken ?? ""]) };
  }
}
