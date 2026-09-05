// Streaming translation: Chat Completions SSE ↔ Claude Messages SSE.
// Derived from 9Router (https://github.com/decolua/9router), MIT License,
// Copyright (c) 2024-2026 decolua and contributors.

import {
  buildChunk,
  buildUsage,
  extractReasoningText,
  MODEL_FALLBACK,
} from "../helpers.ts";
import { parseSseData } from "../sse.ts";
type Any = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Chat Completions SSE → Claude SSE
// ---------------------------------------------------------------------------

export class ChatToClaudeState {
  messageStartSent = false;
  messageId = "";
  model = MODEL_FALLBACK;
  nextBlockIndex = 0;
  thinkingBlockStarted = false;
  thinkingBlockIndex = 0;
  textBlockStarted = false;
  textBlockClosed = false;
  textBlockIndex = 0;
  toolCalls = new Map<number, { id: string; name: string; blockIndex: number }>();
  toolArgBuffers = new Map<number, string>();
  usage: Any | null = null;
  messageStopSent = false;
}

function openaiToClaudeFinishReason(reason: unknown): string {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return "end_turn";
  }
}

/** One chat.completion.chunk → 0..n Claude SSE event objects. */
export function chatChunkToClaudeEvents(chunk: Any, state: ChatToClaudeState): Any[] | null {
  const choices = chunk.choices as Any[] | undefined;
  if (!choices || choices.length === 0) return null;
  const choice = choices[0]!;
  const delta = (choice.delta ?? {}) as Any;
  const results: Any[] = [];

  // Track usage from chat chunk if available
  if (chunk.usage && typeof chunk.usage === "object") {
    const u = chunk.usage as Any;
    const num = (v: unknown) => (typeof v === "number" ? v : 0);
    const promptTokens = num(u.prompt_tokens);
    const outputTokens = num(u.completion_tokens);
    const details = u.prompt_tokens_details as Any | undefined;
    const cacheRead = num(details?.cached_tokens);
    const cacheCreate = num(details?.cache_creation_tokens);
    // input = prompt − cached − cache_creation (prompt includes all prompt-side)
    const usage: Any = {
      input_tokens: promptTokens - cacheRead - cacheCreate,
      output_tokens: outputTokens,
    };
    if (cacheRead > 0) usage.cache_read_input_tokens = cacheRead;
    if (cacheCreate > 0) usage.cache_creation_input_tokens = cacheCreate;
    state.usage = usage;
  }

  // message_start first
  if (!state.messageStartSent) {
    state.messageStartSent = true;
    state.messageId =
      (typeof chunk.id === "string" ? chunk.id.replace("chatcmpl-", "") : "") ||
      `msg_${Date.now()}`;
    state.model = (typeof chunk.model === "string" && chunk.model) || MODEL_FALLBACK;
    state.nextBlockIndex = 0;
    results.push({
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  // Reasoning (thinking)
  const reasoningContent = extractReasoningText(delta);
  if (reasoningContent) {
    if (state.textBlockStarted && !state.textBlockClosed) {
      state.textBlockClosed = true;
      results.push({ type: "content_block_stop", index: state.textBlockIndex });
      state.textBlockStarted = false;
    }

    if (!state.thinkingBlockStarted) {
      state.thinkingBlockIndex = state.nextBlockIndex++;
      state.thinkingBlockStarted = true;
      results.push({
        type: "content_block_start",
        index: state.thinkingBlockIndex,
        content_block: { type: "thinking", thinking: "" },
      });
    }
    results.push({
      type: "content_block_delta",
      index: state.thinkingBlockIndex,
      delta: { type: "thinking_delta", thinking: reasoningContent },
    });
  }

  // Text content
  if (delta.content) {
    if (state.thinkingBlockStarted) {
      results.push({ type: "content_block_stop", index: state.thinkingBlockIndex });
      state.thinkingBlockStarted = false;
    }

    if (!state.textBlockStarted) {
      state.textBlockIndex = state.nextBlockIndex++;
      state.textBlockStarted = true;
      state.textBlockClosed = false;
      results.push({
        type: "content_block_start",
        index: state.textBlockIndex,
        content_block: { type: "text", text: "" },
      });
    }
    results.push({
      type: "content_block_delta",
      index: state.textBlockIndex,
      delta: { type: "text_delta", text: delta.content },
    });
  }

  // Tool calls
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls as Any[]) {
      const idx = typeof tc.index === "number" ? tc.index : 0;

      // GLM/fireworks repeats id+null-name on every arg chunk; open once per idx
      if (tc.id && !state.toolCalls.has(idx)) {
        if (state.thinkingBlockStarted) {
          results.push({ type: "content_block_stop", index: state.thinkingBlockIndex });
          state.thinkingBlockStarted = false;
        }
        if (state.textBlockStarted && !state.textBlockClosed) {
          state.textBlockClosed = true;
          results.push({ type: "content_block_stop", index: state.textBlockIndex });
          state.textBlockStarted = false;
        }

        const toolBlockIndex = state.nextBlockIndex++;
        const fn = tc.function as Any | undefined;
        const toolName = typeof fn?.name === "string" ? fn.name : "";
        state.toolCalls.set(idx, {
          id: String(tc.id),
          name: toolName,
          blockIndex: toolBlockIndex,
        });
        results.push({
          type: "content_block_start",
          index: toolBlockIndex,
          content_block: {
            type: "tool_use",
            id: String(tc.id),
            name: toolName,
            input: {},
          },
        });
      }

      const fnArgs = (tc.function as Any | undefined)?.arguments;
      if (fnArgs && state.toolCalls.has(idx)) {
        state.toolArgBuffers.set(
          idx,
          (state.toolArgBuffers.get(idx) ?? "") + String(fnArgs),
        );
      }
    }
  }

  // Finish
  if (choice.finish_reason) {
    if (state.thinkingBlockStarted) {
      results.push({ type: "content_block_stop", index: state.thinkingBlockIndex });
      state.thinkingBlockStarted = false;
    }
    if (state.textBlockStarted && !state.textBlockClosed) {
      state.textBlockClosed = true;
      results.push({ type: "content_block_stop", index: state.textBlockIndex });
      state.textBlockStarted = false;
    }

    for (const [toolIdx, toolInfo] of state.toolCalls) {
      const args = state.toolArgBuffers.get(toolIdx);
      if (args) {
        // ONE input_json_delta at finish — Claude clients expect buffered args.
        results.push({
          type: "content_block_delta",
          index: toolInfo.blockIndex,
          delta: { type: "input_json_delta", partial_json: args },
        });
      }
      results.push({ type: "content_block_stop", index: toolInfo.blockIndex });
    }

    const finalUsage = state.usage ?? { input_tokens: 0, output_tokens: 0 };
    results.push({
      type: "message_delta",
      delta: { stop_reason: openaiToClaudeFinishReason(choice.finish_reason) },
      usage: finalUsage,
    });
    results.push({ type: "message_stop" });
    state.messageStopSent = true;
  }

  return results.length > 0 ? results : null;
}

// ---------------------------------------------------------------------------
// Claude SSE → Chat Completions SSE
// ---------------------------------------------------------------------------

interface ClaudeToChatState {
  messageId: string;
  model: string;
  toolCallIndex: number;
  serverToolBlockIndex: number;
  textBlockStarted: boolean;
  inThinkingBlock: boolean;
  currentBlockIndex: number;
  toolCalls: Map<number, Any>;
  usage: Any | null;
  finishReason: string | null;
  finishReasonSent: boolean;
}

export function makeClaudeToChatState(model = MODEL_FALLBACK): ClaudeToChatState {
  return {
    messageId: `msg_${Date.now()}`,
    model,
    toolCallIndex: 0,
    serverToolBlockIndex: -1,
    textBlockStarted: false,
    inThinkingBlock: false,
    currentBlockIndex: -1,
    toolCalls: new Map(),
    usage: null,
    finishReason: null,
    finishReasonSent: false,
  };
}

function claudeToOpenaiFinishReason(reason: unknown): string {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}

/** One Claude SSE event → 0..n chat.completion.chunk objects. */
export function claudeEventToChatChunks(
  event: { event?: string; data: string },
  state: ClaudeToChatState,
): Any[] | null {
  const parsed = parseSseData(event.data);
  if (!parsed) return null;
  const ev = parsed as Any;
  const results: Any[] = [];

  const chunk = (delta: Any, finishReason: string | null = null) =>
    buildChunk(
      {
        id: `chatcmpl-${state.messageId}`,
        created: Math.floor(Date.now() / 1000),
        model: state.model,
      },
      delta,
      finishReason,
    );

  switch (ev.type) {
    case "message_start": {
      const message = ev.message as Any | undefined;
      state.messageId = (typeof message?.id === "string" && message.id) || state.messageId;
      if (typeof message?.model === "string" && message.model) state.model = message.model;
      state.toolCallIndex = 0;
      // Claude sends input + cache in message_start; message_delta carries only
      // output later — capture cache now so the delta doesn't reset it.
      const startUsage = message?.usage;
      if (startUsage && typeof startUsage === "object") {
        const u = startUsage as Any;
        const num = (v: unknown) => (typeof v === "number" ? v : 0);
        const inputTokens = num(u.input_tokens);
        const cacheRead = num(u.cache_read_input_tokens);
        const cacheCreation = num(u.cache_creation_input_tokens);
        const promptTokens = inputTokens + cacheRead + cacheCreation;
        state.usage = {
          prompt_tokens: promptTokens,
          completion_tokens: 0,
          total_tokens: promptTokens,
          input_tokens: inputTokens,
          output_tokens: 0,
        };
        if (cacheRead > 0) state.usage.cache_read_input_tokens = cacheRead;
        if (cacheCreation > 0) state.usage.cache_creation_input_tokens = cacheCreation;
      }
      results.push(chunk({ role: "assistant" }));
      break;
    }

    case "content_block_start": {
      const block = ev.content_block as Any | undefined;
      if (block?.type === "server_tool_use") {
        state.serverToolBlockIndex = typeof ev.index === "number" ? ev.index : -1;
        break;
      }
      if (block?.type === "text") {
        state.textBlockStarted = true;
      } else if (block?.type === "thinking") {
        state.inThinkingBlock = true;
        state.currentBlockIndex = typeof ev.index === "number" ? ev.index : -1;
        results.push(chunk({ content: "<think>" }));
      } else if (block?.type === "tool_use") {
        const toolCallIndex = state.toolCallIndex++;
        const toolCall = {
          index: toolCallIndex,
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: "" },
        };
        state.toolCalls.set(typeof ev.index === "number" ? ev.index : toolCallIndex, toolCall);
        results.push(chunk({ tool_calls: [toolCall] }));
      }
      break;
    }

    case "content_block_delta": {
      const idx = typeof ev.index === "number" ? ev.index : -1;
      if (idx === state.serverToolBlockIndex) break;
      const delta = ev.delta as Any | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        results.push(chunk({ content: delta.text }));
      } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
        results.push(chunk({ reasoning_content: delta.thinking }));
      } else if (
        delta?.type === "input_json_delta" &&
        typeof delta.partial_json === "string" &&
        delta.partial_json
      ) {
        const toolCall = state.toolCalls.get(idx);
        if (toolCall) {
          const fn = toolCall.function as Any;
          const argumentsText = typeof fn.arguments === "string" ? fn.arguments : "";
          fn.arguments = argumentsText + delta.partial_json;
          results.push(
            chunk({
              tool_calls: [
                {
                  index: toolCall.index,
                  id: toolCall.id,
                  function: { arguments: delta.partial_json },
                },
              ],
            }),
          );
        }
      }
      break;
    }

    case "content_block_stop": {
      const idx = typeof ev.index === "number" ? ev.index : -1;
      if (idx === state.serverToolBlockIndex) {
        state.serverToolBlockIndex = -1;
        break;
      }
      if (state.inThinkingBlock && idx === state.currentBlockIndex) {
        results.push(chunk({ content: "</think>" }));
        state.inThinkingBlock = false;
      }
      state.textBlockStarted = false;
      break;
    }

    case "message_delta": {
      if (ev.usage && typeof ev.usage === "object") {
        const u = ev.usage as Any;
        const prev = state.usage ?? {};
        const num = (v: unknown) => (typeof v === "number" ? v : 0);
        const inputTokens = typeof u.input_tokens === "number" ? u.input_tokens : num(prev.input_tokens);
        const outputTokens = num(u.output_tokens);
        const cacheRead =
          typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : num(prev.cache_read_input_tokens);
        const cacheCreation =
          typeof u.cache_creation_input_tokens === "number"
            ? u.cache_creation_input_tokens
            : num(prev.cache_creation_input_tokens);
        const promptTokens = inputTokens + cacheRead + cacheCreation;

        state.usage = {
          prompt_tokens: promptTokens,
          completion_tokens: outputTokens,
          total_tokens: promptTokens + outputTokens,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        };
        if (cacheRead > 0) state.usage.cache_read_input_tokens = cacheRead;
        if (cacheCreation > 0) state.usage.cache_creation_input_tokens = cacheCreation;
      }

      const delta = ev.delta as Any | undefined;
      if (delta?.stop_reason) {
        state.finishReason = claudeToOpenaiFinishReason(delta.stop_reason);
        const finalChunk = chunk({}, state.finishReason);
        if (state.usage) {
          finalChunk.usage = buildUsage({
            promptTokens: state.usage.prompt_tokens as number,
            completionTokens: state.usage.completion_tokens as number,
            totalTokens: state.usage.total_tokens as number,
            cachedTokens: state.usage.cache_read_input_tokens as number | undefined,
            cacheCreationTokens: state.usage.cache_creation_input_tokens as number | undefined,
          });
        }
        results.push(finalChunk);
        state.finishReasonSent = true;
      }
      break;
    }

    case "message_stop": {
      if (!state.finishReasonSent) {
        const finishReason =
          state.finishReason ?? (state.toolCalls.size > 0 ? "tool_calls" : "stop");
        const finalChunk = chunk({}, finishReason);
        if (state.usage) {
          const inputTokens = typeof state.usage.input_tokens === "number" ? state.usage.input_tokens : 0;
          const outputTokens = typeof state.usage.output_tokens === "number" ? state.usage.output_tokens : 0;
          finalChunk.usage = {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          };
        }
        results.push(finalChunk);
        state.finishReasonSent = true;
      }
      break;
    }
  }

  return results.length > 0 ? results : null;
}
