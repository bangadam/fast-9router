// Anthropic adapter: official Messages API with API-key auth.
//
// Derived from 9Router (https://github.com/decolua/9router),
// MIT License, Copyright (c) 2024-2026 decolua and contributors.

import {
  toClaudeRequest,
  extractUsage,
  type ClientFormat,
} from "../translate/index.ts";
import { SseParser, type SseFrame } from "../translate/sse.ts";
import { isEventStream, type AdapterArgs, type AdapterResult, type NormalizedUsage } from "./types.ts";
import { fetchAuthenticated } from "../network.ts";
import { readResponseTextLimited } from "../upstream-error.ts";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_BETA = "claude-code-20250219,interleaved-thinking-2025-05-14";

export function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "Anthropic-Beta": ANTHROPIC_BETA,
  };
}

function safeRateLimitHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  const wanted = ["retry-after", "anthropic-ratelimit-requests-limit", "anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-requests-reset", "anthropic-ratelimit-tokens-limit", "anthropic-ratelimit-tokens-remaining", "anthropic-ratelimit-tokens-reset"];
  for (const name of wanted) {
    const v = res.headers.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

export async function callAnthropic(args: AdapterArgs): Promise<AdapterResult> {
  const { request, connection, upstreamModel, signal } = args;
  const apiKey = connection.data.apiKey;
  if (!apiKey) {
    return { ok: false, status: 500, bodyText: JSON.stringify({ error: { message: "connection is missing an API key" } }), retryAfter: null };
  }
  const baseUrl = connection.data.baseUrl ?? ANTHROPIC_BASE_URL;

  const payload = toClaudeRequest({ ...request, model: upstreamModel });
  const res = await fetchAuthenticated(baseUrl, {
    method: "POST",
    headers: {
      ...anthropicHeaders(apiKey),
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
    const monitored = streamWithUsage(res.body, "claude", args.signal);
    return {
      ok: true,
      result: {
        kind: "stream",
        streamCompleted: monitored.isComplete,
        format: "claude" as ClientFormat,
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
      format: "claude" as ClientFormat,
      body,
      rateLimitHeaders,
      usage: Promise.resolve(extractUsage(body, "claude")),
    },
  };
}

/** Inspect usage inline with downstream pulls, preserving upstream backpressure. */
export function streamWithUsage(
  source: ReadableStream<Uint8Array>,
  from: ClientFormat,
  signal?: AbortSignal,
): { body: ReadableStream<Uint8Array>; usage: Promise<NormalizedUsage | null>; isComplete: () => boolean } {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const deferred = Promise.withResolvers<NormalizedUsage | null>();
  let observedUsage: NormalizedUsage | null = null;
  let settled = false;
  let ended = false;
  let terminal: "pending" | "complete" | "failed" = "pending";

  const settle = () => {
    if (settled) return;
    settled = true;
    deferred.resolve(observedUsage);
  };
  const inspect = (frames: SseFrame[]) => {
    for (const frame of frames) {
      if (frame.data === "[DONE]") {
        if (from === "openai" && terminal === "pending") terminal = "complete";
        continue;
      }
      try {
        const parsed = JSON.parse(frame.data) as Record<string, unknown>;
        const type = typeof parsed.type === "string" ? parsed.type : frame.event;
        if (parsed.error !== undefined || type === "error"
          || type === "response.failed" || type === "response.incomplete") {
          terminal = "failed";
        } else if (terminal === "pending") {
          if (from === "claude" && type === "message_stop") terminal = "complete";
          if (from === "openai-responses" && (type === "response.completed" || type === "response.done")) terminal = "complete";
          if (from === "openai") {
            const choices = parsed.choices;
            if (Array.isArray(choices) && choices.some((choice) =>
              choice && typeof choice === "object" && typeof (choice as Record<string, unknown>).finish_reason === "string")) {
              terminal = "complete";
            }
          }
        }
        const usage = extractUsage(parsed, from);
        if (!usage) continue;
        observedUsage = {
          promptTokens: usage.promptTokens ?? observedUsage?.promptTokens ?? null,
          completionTokens: usage.completionTokens ?? observedUsage?.completionTokens ?? null,
          ...(usage.cachedTokens === undefined && observedUsage?.cachedTokens === undefined ? {} : { cachedTokens: usage.cachedTokens ?? observedUsage?.cachedTokens }),
        };
      } catch {
        // Malformed or partial provider frame: forward unchanged.
      }
    }
  };
  const stop = () => signal?.removeEventListener("abort", abort);
  const abort = () => {
    if (ended) return;
    ended = true;
    void reader.cancel(signal?.reason).finally(() => {
      settle();
      stop();
    });
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          ended = true;
          parser.push(decoder.decode());
          inspect([...parser.drain(), ...parser.flushTrailing()]);
          settle();
          stop();
          if (terminal === "complete") {
            controller.close();
          } else {
            controller.error(new Error(terminal === "failed"
              ? "upstream stream reported a terminal failure"
              : "upstream stream ended without a terminal event"));
          }
          return;
        }
        parser.push(decoder.decode(chunk.value, { stream: true }));
        inspect(parser.drain());
        controller.enqueue(chunk.value);
      } catch (error) {
        ended = true;
        settle();
        stop();
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (!ended) {
        ended = true;
        await reader.cancel(reason).catch(() => {});
      }
      settle();
      stop();
    },
  });
  return { body, usage: deferred.promise, isComplete: () => terminal === "complete" };
}

export const anthropicAdapter = {
  id: "anthropic" as const,
  call: callAnthropic,
};
