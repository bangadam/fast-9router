// Shared pure helpers used across the translators.
// Derived from 9Router (https://github.com/decolua/9router), MIT License,
// Copyright (c) 2024-2026 decolua and contributors.

export function safeParseJSON(str: unknown, fallback: unknown): unknown {
  if (typeof str !== "string") return str;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export function encodeDataUri(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`;
}

// [\s\S] tolerates newlines inside the base64 payload.
const DATA_URI_RE = /^data:([^;]+);base64,([\s\S]+)$/;

export function parseDataUri(
  url: unknown,
): { mimeType: string; base64: string } | null {
  if (typeof url !== "string") return null;
  const m = url.match(DATA_URI_RE);
  return m ? { mimeType: m[1]!, base64: m[2]! } : null;
}

export const MODEL_FALLBACK = "gpt-4o";

/** Chat-Completions tool parameters must be an object schema with properties. */
export function normalizeToolParameters(
  params: unknown,
): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { type: "object", properties: {} };
  }
  const p = params as Record<string, unknown>;
  if (p.type === "object" && !p.properties) {
    return { ...p, properties: {} };
  }
  return p;
}

/** Claude finish_reason → Chat-Completions finish_reason. */
export function claudeToOpenaiFinish(reason: string | null | undefined): string {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "end_turn":
    case "stop_sequence":
    default:
      return "stop";
  }
}

/** Chat-Completions finish_reason → Claude stop_reason. */
export function openaiToClaudeFinish(reason: string | null | undefined): string {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "stop":
    default:
      return "end_turn";
  }
}

/** Build a chat.completion.chunk. Caller owns id/created/model semantics. */
export function buildChunk(
  base: { id: string; created: number; model: string },
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id: base.id,
    object: "chat.completion.chunk",
    created: base.created,
    model: base.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function reasoningDelta(text: string): Record<string, unknown> {
  return { reasoning_content: text };
}

/** Extract reasoning text from a Chat-Completions delta across vendor shapes. */
export function extractReasoningText(delta: unknown): string {
  if (!delta || typeof delta !== "object") return "";
  const d = delta as Record<string, unknown>;
  if (typeof d.reasoning_content === "string" && d.reasoning_content) {
    return d.reasoning_content;
  }
  if (typeof d.reasoning === "string" && d.reasoning) return d.reasoning;
  if (Array.isArray(d.reasoning_details)) {
    return (d.reasoning_details as unknown[])
      .map((x) => {
        if (typeof x === "string") return x;
        if (x && typeof x === "object") {
          const r = x as Record<string, unknown>;
          if (typeof r.text === "string") return r.text;
          if (typeof r.content === "string") return r.content;
        }
        return "";
      })
      .join("");
  }
  return "";
}

export function buildUsage(args: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
}): Record<string, number | object> {
  const usage: Record<string, number | object> = {
    prompt_tokens: args.promptTokens,
    completion_tokens: args.completionTokens,
    total_tokens: args.totalTokens,
  };
  const cached = args.cachedTokens ?? 0;
  const cacheCreation = args.cacheCreationTokens ?? 0;
  if (cached > 0 || cacheCreation > 0) {
    const details: Record<string, number> = {};
    if (cached > 0) details.cached_tokens = cached;
    if (cacheCreation > 0) details.cache_creation_tokens = cacheCreation;
    usage.prompt_tokens_details = details;
  }
  if ((args.reasoningTokens ?? 0) > 0) {
    usage.completion_tokens_details = {
      reasoning_tokens: args.reasoningTokens!,
    };
  }
  return usage;
}

/**
 * Claude-native usage math: prompt side = input + cache_read + cache_creation
 * (Claude reports cache tokens separately; the sum is the billed prompt).
 */
export function claudePromptTokens(raw: {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): number {
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  return (
    n(raw.input_tokens) +
    n(raw.cache_read_input_tokens) +
    n(raw.cache_creation_input_tokens)
  );
}

/**
 * Unwrap freeform custom-tool input from a Chat-Completions JSON wrapper
 * ({"input": "..."}); falls back to the raw string when not parseable.
 */
export function extractCustomToolInput(argumentsText: unknown): string {
  const text =
    typeof argumentsText === "string"
      ? argumentsText
      : JSON.stringify(argumentsText ?? {});
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const parsedObject = parsed as Record<string, unknown>;
      if (typeof parsedObject.input === "string") return parsedObject.input;
    }
  } catch {
    // raw freeform input
  }
  return text;
}

const MAX_CALL_ID_LEN = 64;

/** Responses API enforces max 64 chars on call_id. */
export function clampCallId(id: string): string {
  return id.length > MAX_CALL_ID_LEN ? id.substring(0, MAX_CALL_ID_LEN) : id;
}

export function fallbackToolCallId(): string {
  return `call_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
