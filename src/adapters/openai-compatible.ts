// [OI]-compatible adapter: Chat Completions against a configured base URL
// with Bearer API-key auth. Official [OI] is only the default base URL preset.
import {
  toOpenaiChatRequest,
  translateStream,
  extractUsage,
  type ClientFormat,
} from "../translate/index.ts";
import { OPENAI_PRESET_BASE_URL } from "../catalog.ts";
import { isEventStream, type AdapterArgs, type AdapterResult } from "./types.ts";
import { streamWithUsage } from "./anthropic.ts";
import { fetchAuthenticated } from "../network.ts";
import { readResponseTextLimited } from "../upstream-error.ts";

function chatCompletionsUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "") + "/chat/completions";
}

function safeRateLimitHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["retry-after", "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens"]) {
    const v = res.headers.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

export async function callOpenaiCompatible(args: AdapterArgs): Promise<AdapterResult> {
  const { request, connection, upstreamModel, signal } = args;
  const apiKey = connection.data.apiKey;
  if (!apiKey) {
    return { ok: false, status: 500, bodyText: JSON.stringify({ error: { message: "connection is missing an API key" } }), retryAfter: null };
  }
  const baseUrl = connection.data.baseUrl ?? OPENAI_PRESET_BASE_URL;
  const payload = toOpenaiChatRequest({ ...request, model: upstreamModel });

  const res = await fetchAuthenticated(chatCompletionsUrl(baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok) {
    const bodyText = await readResponseTextLimited(res).catch(() => "");
    return { ok: false, status: res.status, bodyText, retryAfter: res.headers.get("retry-after") };
  }

  const rateLimitHeaders = safeRateLimitHeaders(res);

  if (request.stream && (!res.body || !isEventStream(res))) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, status: 502, bodyText: JSON.stringify({ error: { message: "upstream did not return an event stream" } }), retryAfter: null };
  }
  if (request.stream && res.body) {
    const monitored = streamWithUsage(res.body, "openai", args.signal);
    return {
      ok: true,
      result: {
        kind: "stream",
        streamCompleted: monitored.isComplete,
        format: "openai" as ClientFormat,
        body: monitored.body,
        rateLimitHeaders,
        usage: monitored.usage,
      },
    };
  }

  const body = (await res.json()) as Record<string, unknown>;
  return {
    ok: true,
    result: {
      kind: "json",
      format: "openai" as ClientFormat,
      body,
      rateLimitHeaders,
      usage: Promise.resolve(extractUsage(body, "openai")),
    },
  };
}

export const openaiCompatibleAdapter = {
  id: "openai" as const,
  call: callOpenaiCompatible,
};
