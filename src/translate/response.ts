// Non-streaming response translation: upstream JSON → client format.
// Derived from 9Router (https://github.com/decolua/9router), MIT License,
// Copyright (c) 2024-2026 decolua and contributors.

import type { ClientFormat, TranslateOptions, UsageCounts } from "./types.ts";
import { claudeToOpenaiFinish, extractCustomToolInput } from "./helpers.ts";

type Any = Record<string, unknown>;

function parseToolArguments(value: unknown): Any {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Any;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Chat Completions body → Claude Messages body. */
export function openaiChatToClaude(body: Any): Any {
  const choice = (body.choices as Any[] | undefined)?.[0];
  if (!choice) return body;
  const message = (choice.message ?? {}) as Any;
  const content: Any[] = [];

  const reasoning = message.reasoning_content;
  if (typeof reasoning === "string" && reasoning) {
    content.push({ type: "thinking", thinking: reasoning });
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  for (const toolCall of (message.tool_calls as Any[] | undefined) ?? []) {
    const fn = (toolCall.function ?? {}) as Any;
    content.push({
      type: "tool_use",
      id: toolCall.id || `toolu_${Date.now()}_${content.length}`,
      name: fn.name || toolCall.name || "",
      input: parseToolArguments(fn.arguments ?? toolCall.arguments),
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  const usage = (body.usage ?? {}) as Any;
  return {
    id: String(body.id ?? `msg_${Date.now()}`).replace(/^chatcmpl-/, ""),
    type: "message",
    role: "assistant",
    model: body.model || "unknown",
    content,
    stop_reason: claudeToOpenaiFinishToClaude(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    },
  };
}

function claudeToOpenaiFinishToClaude(reason: unknown): string {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return "end_turn";
  }
}

/** Chat Completions body → Responses API body. */
export function openaiChatToResponses(body: Any, customToolNames?: Set<string>): Any {
  const choice = (body.choices as Any[] | undefined)?.[0];
  if (!choice) return body;
  const message = (choice.message ?? {}) as Any;
  const output: Any[] = [];

  const reasoning = message.reasoning_content ?? message.reasoning;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    output.push({ type: "reasoning", summary: [{ type: "summary_text", text: reasoning }] });
  }
  const text = typeof message.content === "string" ? message.content : "";
  if (text.length > 0) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const tc of (message.tool_calls as Any[] | undefined) ?? []) {
    const fn = (tc.function ?? {}) as Any;
    const functionName = typeof fn.name === "string" ? fn.name : "";
    const custom = customToolNames?.has(functionName);
    output.push({
      type: custom ? "custom_tool_call" : "function_call",
      id: `${custom ? "ctc" : "fc"}_${tc.id ?? ""}`,
      call_id: tc.id ?? "",
      name: fn.name ?? "",
      ...(custom
        ? { input: extractCustomToolInput(fn.arguments) }
        : {
            arguments:
              typeof fn.arguments === "string"
                ? fn.arguments
                : JSON.stringify(fn.arguments ?? {}),
          }),
    });
  }

  const usage = (body.usage ?? {}) as Any;
  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : promptTokens + completionTokens;
  return {
    id: `resp_${body.id ?? ""}`.replace(/^resp_chatcmpl-/, "resp_"),
    object: "response",
    created_at: body.created || Math.floor(Date.now() / 1000),
    model: body.model || "unknown",
    status: "completed",
    background: false,
    error: null,
    output,
    usage: {
      input_tokens: promptTokens || inputTokens,
      output_tokens: completionTokens || outputTokens,
      total_tokens: totalTokens,
    },
  };
}

/** Claude Messages body → Chat Completions body. */
export function claudeToOpenaiChat(body: Any): Any {
  if (body.choices || (body.content && !Array.isArray(body.content))) return body;

  let textContent = "";
  let thinkingContent = "";
  const toolCalls: Any[] = [];

  for (const block of (Array.isArray(body.content) ? body.content : []) as Any[]) {
    if (block?.type === "text") {
      // Strip markdown JSON code fences some providers wrap around JSON.
      const raw = typeof block.text === "string" ? block.text : "";
      textContent += raw
        .replace(/^\s*```\s*json\s*\n?/i, "")
        .replace(/\n?\s*```\s*$/i, "");
    } else if (block?.type === "thinking") {
      thinkingContent += typeof block.thinking === "string" ? block.thinking : "";
    } else if (block?.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }

  const message: Any = { role: "assistant" };
  if (textContent) message.content = textContent;
  if (thinkingContent) message.reasoning_content = thinkingContent;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (!message.content && !message.tool_calls) message.content = "";

  let finishReason = typeof body.stop_reason === "string" ? body.stop_reason : "stop";
  finishReason = claudeToOpenaiFinish(finishReason);

  const result: Any = {
    id: `chatcmpl-${body.id ?? Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model || "claude",
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  if (body.usage) {
    const u = body.usage as Any;
    const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
    const output = typeof u.output_tokens === "number" ? u.output_tokens : 0;
    result.usage = {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output,
    };
  }
  return result;
}

/** Responses API body → Chat Completions body. */
export function responsesToOpenaiChat(body: Any): Any {
  if (!Array.isArray(body.output)) return body;

  let text = "";
  let reasoning = "";
  const toolCalls: Any[] = [];

  for (const item of body.output as Any[]) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      for (const c of (Array.isArray(item.content) ? item.content : []) as Any[]) {
        if (c?.type === "output_text" && typeof c.text === "string") text += c.text;
      }
    } else if (item.type === "reasoning") {
      for (const s of (Array.isArray(item.summary) ? item.summary : []) as Any[]) {
        if (typeof s?.text === "string") reasoning += s.text;
      }
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      toolCalls.push({
        id: item.call_id ?? item.id ?? "",
        type: "function",
        function: {
          name: item.name ?? "",
          arguments:
            item.type === "custom_tool_call"
              ? JSON.stringify({ input: item.input ?? "" })
              : typeof item.arguments === "string"
                ? item.arguments
                : JSON.stringify(item.arguments ?? {}),
        },
      });
    }
  }

  const message: Any = { role: "assistant" };
  if (text) message.content = text;
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
    if (!message.content) message.content = "";
  }
  if (!message.content && !message.tool_calls) message.content = "";

  const usage = (body.usage ?? {}) as Any;
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : inputTokens + outputTokens;

  return {
    id: `chatcmpl-${String(body.id ?? "").replace(/^resp_/, "")}`,
    object: "chat.completion",
    created: body.created_at || Math.floor(Date.now() / 1000),
    model: body.model || "unknown",
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: totalTokens,
    },
  };
}

/** Claude Messages body → Responses API body. */
export function claudeToResponses(body: Any): Any {
  if (Array.isArray(body.content) || body.type === "message") {
    const chat = claudeToOpenaiChat(body);
    return openaiChatToResponses(chat);
  }
  return body;
}

/** Responses API body → Claude Messages body. */
export function responsesToClaude(body: Any): Any {
  if (Array.isArray(body.output)) {
    const chat = responsesToOpenaiChat(body);
    return openaiChatToClaude(chat);
  }
  return body;
}

/**
 * Translate a non-streaming upstream body to the client's format.
 * Identity when from === to.
 */
export function translateResponse(
  upstreamBody: object,
  from: ClientFormat,
  to: ClientFormat,
  opts: TranslateOptions = {},
): object {
  if (from === to) return upstreamBody;
  const body = upstreamBody as Any;

  if (from === "openai") {
    if (to === "claude") return openaiChatToClaude(body);
    if (to === "openai-responses") return openaiChatToResponses(body, opts.customToolNames);
  }
  if (from === "claude") {
    if (to === "openai") return claudeToOpenaiChat(body);
    if (to === "openai-responses") return claudeToResponses(body);
  }
  if (from === "openai-responses") {
    if (to === "openai") return responsesToOpenaiChat(body);
    if (to === "claude") return responsesToClaude(body);
  }
  return body;
}

/**
 * Usage counts from an upstream body; null when the body carries no usage.
 * Claude: prompt = input + cache_read + cache_creation (billed prompt side).
 */
export function extractUsage(body: object, from: ClientFormat): UsageCounts | null {
  const b = body as Any;
  const response = b.response;
  const message = b.message;
  const usage = b.usage
    ?? (from === "openai-responses" && response && typeof response === "object" ? (response as Any).usage : undefined)
    ?? (from === "claude" && message && typeof message === "object" ? (message as Any).usage : undefined);
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Any;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

  if (from === "openai" || from === "openai-responses") {
    const details = (u.prompt_tokens_details ?? u.input_tokens_details) as Any | undefined;
    const cachedTokens = num(details?.cached_tokens) ?? num(u.cache_read_input_tokens);
    return {
      promptTokens: from === "openai" ? num(u.prompt_tokens) ?? num(u.input_tokens) : num(u.input_tokens) ?? num(u.prompt_tokens),
      completionTokens: from === "openai" ? num(u.completion_tokens) ?? num(u.output_tokens) : num(u.output_tokens) ?? num(u.completion_tokens),
      ...(cachedTokens === null ? {} : { cachedTokens }),
    };
  }
  const input = num(u.input_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheCreation = num(u.cache_creation_input_tokens);
  const hasPromptUsage = input !== null || cacheRead !== null || cacheCreation !== null;
  return {
    promptTokens: hasPromptUsage ? (input ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0) : null,
    completionTokens: num(u.output_tokens) ?? num(u.completion_tokens),
    ...(cacheRead === null ? {} : { cachedTokens: cacheRead }),
  };
}
