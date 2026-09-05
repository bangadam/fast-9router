// The provider adapter seam: three implementations (codex, anthropic,
// openai-compatible) behind one small interface. Routing tests against fake
// upstreams never need provider details.

import type { Database } from "bun:sqlite";
import type { ProviderConnectionWithCooldown } from "../db.ts";
import type { ClientFormat, NormalizedRequest } from "../translate/index.ts";

/** Usage as reported by the upstream; null token counts when unreported. */
export interface NormalizedUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens?: number;
}

export interface AdapterArgs {
  /** Normalized request; `model` is already the upstream model id. */
  request: NormalizedRequest;
  connection: ProviderConnectionWithCooldown;
  upstreamModel: string;
  signal?: AbortSignal;
  db: Database;
}



export interface AdapterSuccess {
  kind: "json" | "stream";
  /** For kind "json": the parsed upstream response body. For kind "stream": SSE bytes. */
  body: Record<string, unknown> | ReadableStream<Uint8Array>;
  /** Upstream wire format the body is encoded in. */
  format: ClientFormat;
  /** Safe rate-limit headers propagated from the upstream response. */
  rateLimitHeaders: Record<string, string>;
  /** Resolves when the upstream finishes; null counts mean "unreported". */
  usage: Promise<NormalizedUsage | null>;
  /** Source-protocol terminal state, checked when the client cancels early. */
  streamCompleted?: () => boolean;
}

export type AdapterResult =
  | { ok: true; result: AdapterSuccess }
  | {
      ok: false;
      status: number;
      bodyText: string;
      retryAfter: string | null;
    };

export function isEventStream(response: Response): boolean {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    === "text/event-stream";
}

export function isJsonResponse(response: Response): boolean {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json"
    || (mediaType?.startsWith("application/") === true && mediaType.endsWith("+json"));
}

export interface ProviderAdapter {
  id: "codex" | "anthropic" | "openai";
  call(args: AdapterArgs): Promise<AdapterResult>;
}
