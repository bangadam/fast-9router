// Streaming translation: [OI] Responses SSE ↔ Chat Completions SSE.
// Derived from 9Router (https://github.com/decolua/9router), MIT License,
// Copyright (c) 2024-2026 decolua and contributors.

import {
  buildChunk,
  buildUsage,
  extractReasoningText,
  fallbackToolCallId,
  MODEL_FALLBACK,
  reasoningDelta,
} from "../helpers.ts";
import type { TranslateOptions } from "../types.ts";
import { parseSseData } from "../sse.ts";

type Any = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Responses SSE → Chat Completions SSE
// ---------------------------------------------------------------------------

export class ResponsesToChatState {
  chatId = "";
  created = 0;
  started = false;
  finishReasonSent = false;
  finishReason: string | null = null;
  toolCallIndex = 0;
  currentToolCallId: string | null = null;
  usage: Any | null = null;
  model = MODEL_FALLBACK;
  doneSent = false;
}

/** One Responses SSE event → 0..n chat.completion.chunk objects (null when none). */
export function responsesEventToChatChunks(
  event: { event?: string; data: string },
  state: ResponsesToChatState,
): Any[] | null {
  const parsed = parseSseData(event.data);
  if (!parsed) return null;
  const eventType = typeof parsed.type === "string" ? parsed.type : event.event ?? "";
  const nestedData = parsed.data ?? parsed;
  const data: Any = nestedData && typeof nestedData === "object" && !Array.isArray(nestedData)
    ? nestedData as Any
    : {};
  if (!state.started) {
    state.started = true;
    state.chatId = `chatcmpl-${Date.now()}`;
    state.created = Math.floor(Date.now() / 1000);
  }

  const chunk = (delta: Any, finishReason: string | null = null) =>
    buildChunk(
      { id: state.chatId, created: state.created, model: state.model },
      delta,
      finishReason,
    );

  // Text content delta
  if (eventType === "response.output_text.delta") {
    const delta = typeof data.delta === "string" ? data.delta : "";
    if (!delta) return null;
    return [chunk({ content: delta })];
  }
  if (eventType === "response.output_text.done") return null;

  // Function call started (standard function_call or custom_tool_call)
  if (
    eventType === "response.output_item.added" &&
    ((data.item as Any | undefined)?.type === "function_call" ||
      (data.item as Any | undefined)?.type === "custom_tool_call")
  ) {
    const item = data.item as Any;
    state.currentToolCallId =
      typeof item.call_id === "string" && item.call_id ? item.call_id : fallbackToolCallId();
    return [
      chunk({
        tool_calls: [
          {
            index: state.toolCallIndex,
            id: state.currentToolCallId,
            type: "function",
            function: { name: item.name || "", arguments: "" },
          },
        ],
      }),
    ];
  }

  // Function call arguments delta (standard or custom variant)
  if (
    eventType === "response.function_call_arguments.delta" ||
    eventType === "response.custom_tool_call_input.delta"
  ) {
    const argsDelta = typeof data.delta === "string" ? data.delta : "";
    if (!argsDelta) return null;
    return [
      chunk({
        tool_calls: [{ index: state.toolCallIndex, function: { arguments: argsDelta } }],
      }),
    ];
  }

  // Function call done
  if (
    eventType === "response.output_item.done" &&
    ((data.item as Any | undefined)?.type === "function_call" ||
      (data.item as Any | undefined)?.type === "custom_tool_call")
  ) {
    state.toolCallIndex++;
    return null;
  }

  // Response completed
  if (eventType === "response.completed" || eventType === "response.done") {
    const responseUsage = (data.response as Any | undefined)?.usage;
    if (responseUsage && typeof responseUsage === "object") {
      const usage = responseUsage as Any;
      const num = (value: unknown): number => typeof value === "number" ? value : 0;
      const inputTokens = num(usage.input_tokens) || num(usage.prompt_tokens);
      const outputTokens = num(usage.output_tokens) || num(usage.completion_tokens);
      // Responses API: input_tokens already includes cached; cache in details
      const inputDetails = usage.input_tokens_details as Any | undefined;
      const cacheReadTokens =
        num(inputDetails?.cached_tokens) || num(usage.cache_read_input_tokens);
      state.usage = buildUsage({
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
        cachedTokens: cacheReadTokens,
      });
    }

    if (!state.finishReasonSent) {
      const finishReason =
        state.toolCallIndex > 0 || state.currentToolCallId ? "tool_calls" : "stop";
      state.finishReasonSent = true;
      state.finishReason = finishReason;
      const finalChunk = chunk({}, finishReason);
      if (state.usage) finalChunk.usage = state.usage;
      return [finalChunk];
    }
    return null;
  }

  // Error events
  if (eventType === "error" || eventType === "response.failed") {
    if (state.finishReasonSent) return null;
    const response = data.response as Any | undefined;
    const error = data.error ?? response?.error;
    if (error) {
      const errorObject = typeof error === "object" && !Array.isArray(error) ? error as Any : null;
      const message = errorObject?.message ?? JSON.stringify(error);
      state.finishReasonSent = true;
      return [
        chunk(
          { content: `[Error] ${message}` },
          "stop",
        ),
      ];
    }
    return null;
  }

  // Reasoning summary delta → reasoning_content
  if (eventType === "response.reasoning_summary_text.delta") {
    const delta = typeof data.delta === "string" ? data.delta : "";
    if (!delta) return null;
    return [chunk(reasoningDelta(delta))];
  }

  return null;
}

/** Terminal fallback when the stream ends without response.completed. */
export function responsesToChatFlush(state: ResponsesToChatState): Any[] | null {
  if (state.finishReasonSent || !state.started) return null;
  state.finishReasonSent = true;
  const finishReason =
    state.toolCallIndex > 0 || state.currentToolCallId ? "tool_calls" : "stop";
  state.finishReason = finishReason;
  const finalChunk = buildChunk(
    { id: state.chatId, created: state.created, model: state.model },
    {},
    finishReason,
  );
  if (state.usage) finalChunk.usage = state.usage;
  return [finalChunk];
}

// ---------------------------------------------------------------------------
// Chat Completions SSE → Responses SSE
// ---------------------------------------------------------------------------

interface ChatToResponsesState {
  seq: number;
  responseId: string;
  created: number;
  started: boolean;
  completedSent: boolean;
  inThinking: boolean;
  reasoningId: string | null;
  reasoningIndex: number;
  reasoningBuf: string;
  reasoningDone: boolean;
  reasoningPartAdded: boolean;
  msgItemAdded: Record<string, boolean>;
  msgContentAdded: Record<string, boolean>;
  msgItemDone: Record<string, boolean>;
  msgTextBuf: Record<string, string>;
  funcCallIds: Record<string, string>;
  funcNames: Record<string, string>;
  funcItemAdded: Record<string, boolean>;
  funcItemDone: Record<string, boolean>;
  funcArgsBuf: Record<string, string>;
  customToolNames?: Set<string>;
}

export function makeChatToResponsesState(opts: TranslateOptions = {}): ChatToResponsesState {
  return {
    seq: 0,
    responseId: `resp_${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    started: false,
    completedSent: false,
    inThinking: false,
    reasoningId: null,
    reasoningIndex: 0,
    reasoningBuf: "",
    reasoningDone: false,
    reasoningPartAdded: false,
    msgItemAdded: {},
    msgContentAdded: {},
    msgItemDone: {},
    msgTextBuf: {},
    funcCallIds: {},
    funcNames: {},
    funcItemAdded: {},
    funcItemDone: {},
    funcArgsBuf: {},
    customToolNames: opts.customToolNames,
  };
}

type Emit = (eventType: string, data: Any) => void;

/**
 * One chat.completion.chunk → Responses SSE events. Returns the raw chunk for
 * [DONE] pass-through detection (data === "[DONE]").
 */
export function chatChunkToResponsesEvents(
  chunk: Any,
  state: ChatToResponsesState,
  emit: Emit,
): void {
  const choices = chunk.choices as Any[] | undefined;
  if (!choices || choices.length === 0) return;

  const choice = choices[0]!;
  const idx = typeof choice.index === "number" ? choice.index : 0;
  const delta = (choice.delta ?? {}) as Any;

  // Emit initial events
  if (!state.started) {
    state.started = true;
    if (typeof chunk.id === "string" && chunk.id) {
      state.responseId = `resp_${chunk.id}`;
    }
    emit("response.created", {
      type: "response.created",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "in_progress",
        background: false,
        error: null,
        output: [],
      },
    });
    emit("response.in_progress", {
      type: "response.in_progress",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "in_progress",
      },
    });
  }

  // Reasoning across vendor shapes
  const reasoningText = extractReasoningText(delta);
  if (reasoningText) {
    startReasoning(state, emit, idx);
    emitReasoningDelta(state, emit, reasoningText);
  }

  // Text content
  if (delta.content) {
    let content = String(delta.content);

    if (content.includes("<think>")) {
      state.inThinking = true;
      content = content.replace("<think>", "");
      startReasoning(state, emit, idx);
    }

    if (content.includes("</think>")) {
      const parts = content.split("</think>");
      const thinkPart = parts[0] ?? "";
      const textPart = parts.slice(1).join("</think>");
      if (thinkPart) emitReasoningDelta(state, emit, thinkPart);
      closeReasoning(state, emit);
      state.inThinking = false;
      content = textPart;
    }

    if (state.inThinking && content) {
      emitReasoningDelta(state, emit, content);
      return;
    }

    if (content) {
      emitTextContent(state, emit, idx, content);
    }
  }

  // Tool calls — empty array is truthy but has no real call (GLM quirk)
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
    closeMessage(state, emit, String(idx));
    for (const tc of delta.tool_calls as Any[]) {
      emitToolCall(state, emit, tc);
    }
  }

  // Finish
  if (choice.finish_reason) {
    for (const i of Object.keys(state.msgItemAdded)) closeMessage(state, emit, i);
    closeReasoning(state, emit);
    for (const i of Object.keys(state.funcCallIds)) closeToolCall(state, emit, i);
    sendCompleted(state, emit);
  }
}

function startReasoning(state: ChatToResponsesState, emit: Emit, idx: number): void {
  if (!state.reasoningId) {
    state.reasoningId = `rs_${state.responseId}_${idx}`;
    state.reasoningIndex = idx;

    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: idx,
      item: { id: state.reasoningId, type: "reasoning", summary: [] },
    });

    emit("response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      item_id: state.reasoningId,
      output_index: idx,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    });
    state.reasoningPartAdded = true;
  }
}

function emitReasoningDelta(state: ChatToResponsesState, emit: Emit, text: string): void {
  if (!text || !state.reasoningId) return;
  state.reasoningBuf += text;
  emit("response.reasoning_summary_text.delta", {
    type: "response.reasoning_summary_text.delta",
    item_id: state.reasoningId,
    output_index: state.reasoningIndex,
    summary_index: 0,
    delta: text,
  });
}

function closeReasoning(state: ChatToResponsesState, emit: Emit): void {
  if (!state.reasoningId || state.reasoningDone) return;
  state.reasoningDone = true;

  emit("response.reasoning_summary_text.done", {
    type: "response.reasoning_summary_text.done",
    item_id: state.reasoningId,
    output_index: state.reasoningIndex,
    summary_index: 0,
    text: state.reasoningBuf,
  });

  emit("response.reasoning_summary_part.done", {
    type: "response.reasoning_summary_part.done",
    item_id: state.reasoningId,
    output_index: state.reasoningIndex,
    summary_index: 0,
    part: { type: "summary_text", text: state.reasoningBuf },
  });

  emit("response.output_item.done", {
    type: "response.output_item.done",
    output_index: state.reasoningIndex,
    item: {
      id: state.reasoningId,
      type: "reasoning",
      summary: [{ type: "summary_text", text: state.reasoningBuf }],
    },
  });
}

function emitTextContent(
  state: ChatToResponsesState,
  emit: Emit,
  idx: number,
  content: string,
): void {
  const key = String(idx);
  if (!state.msgItemAdded[key]) {
    state.msgItemAdded[key] = true;
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: idx,
      item: {
        id: `msg_${state.responseId}_${key}`,
        type: "message",
        content: [],
        role: "assistant",
      },
    });
  }

  if (!state.msgContentAdded[key]) {
    state.msgContentAdded[key] = true;
    emit("response.content_part.added", {
      type: "response.content_part.added",
      item_id: `msg_${state.responseId}_${key}`,
      output_index: idx,
      content_index: 0,
      part: { type: "output_text", annotations: [], logprobs: [], text: "" },
    });
  }

  emit("response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: `msg_${state.responseId}_${key}`,
    output_index: idx,
    content_index: 0,
    delta: content,
    logprobs: [],
  });

  state.msgTextBuf[key] = (state.msgTextBuf[key] ?? "") + content;
}

function closeMessage(state: ChatToResponsesState, emit: Emit, key: string): void {
  if (!state.msgItemAdded[key] || state.msgItemDone[key]) return;
  state.msgItemDone[key] = true;
  const fullText = state.msgTextBuf[key] || "";
  const msgId = `msg_${state.responseId}_${key}`;
  const idx = parseInt(key, 10);

  emit("response.output_text.done", {
    type: "response.output_text.done",
    item_id: msgId,
    output_index: idx,
    content_index: 0,
    text: fullText,
    logprobs: [],
  });

  emit("response.content_part.done", {
    type: "response.content_part.done",
    item_id: msgId,
    output_index: idx,
    content_index: 0,
    part: { type: "output_text", annotations: [], logprobs: [], text: fullText },
  });

  emit("response.output_item.done", {
    type: "response.output_item.done",
    output_index: idx,
    item: {
      id: msgId,
      type: "message",
      content: [{ type: "output_text", annotations: [], logprobs: [], text: fullText }],
      role: "assistant",
    },
  });
}

function isCustomTool(state: ChatToResponsesState, name: string | undefined): boolean {
  return !!name && !!state.customToolNames?.has(name);
}

function emitToolCall(state: ChatToResponsesState, emit: Emit, tc: Any): void {
  const tcIdx = String(typeof tc.index === "number" ? tc.index : 0);
  const newCallId = typeof tc.id === "string" ? tc.id : undefined;
  const fn = (tc.function ?? {}) as Any;
  const funcName = typeof fn.name === "string" ? fn.name : undefined;

  if (funcName) state.funcNames[tcIdx] = funcName;
  if (newCallId) state.funcCallIds[tcIdx] = newCallId;

  // Some providers split id and name across chunks — wait for both before
  // deciding function_call vs custom_tool_call.
  const callId = state.funcCallIds[tcIdx];
  if (!state.funcItemAdded[tcIdx] && callId && state.funcNames[tcIdx]) {
    state.funcItemAdded[tcIdx] = true;
    const custom = isCustomTool(state, state.funcNames[tcIdx]);

    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: parseInt(tcIdx, 10),
      item: {
        id: `${custom ? "ctc" : "fc"}_${callId}`,
        type: custom ? "custom_tool_call" : "function_call",
        ...(custom ? { input: "" } : { arguments: "" }),
        call_id: callId,
        name: state.funcNames[tcIdx] || "",
      },
    });
  }

  state.funcArgsBuf[tcIdx] = state.funcArgsBuf[tcIdx] ?? "";

  if (fn.arguments) {
    const refCallId = state.funcCallIds[tcIdx] || newCallId;
    if (
      state.funcItemAdded[tcIdx] &&
      refCallId &&
      !isCustomTool(state, state.funcNames[tcIdx])
    ) {
      emit("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: `fc_${refCallId}`,
        output_index: parseInt(tcIdx, 10),
        delta: fn.arguments,
      });
    }
    // Custom input is emitted once at close (after JSON unwrap).
    state.funcArgsBuf[tcIdx] += String(fn.arguments);
  }
}

function closeToolCall(state: ChatToResponsesState, emit: Emit, key: string): void {
  const callId = state.funcCallIds[key];
  if (!callId || state.funcItemDone[key]) return;
  const args = state.funcArgsBuf[key] || "{}";
  const custom = isCustomTool(state, state.funcNames[key]);
  const idx = parseInt(key, 10);

  if (custom) {
    const input = extractInput(args);
    emit("response.custom_tool_call_input.delta", {
      type: "response.custom_tool_call_input.delta",
      item_id: `ctc_${callId}`,
      output_index: idx,
      delta: input,
    });
    emit("response.custom_tool_call_input.done", {
      type: "response.custom_tool_call_input.done",
      item_id: `ctc_${callId}`,
      output_index: idx,
      input,
    });
  } else {
    emit("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: `fc_${callId}`,
      output_index: idx,
      arguments: args,
    });
  }

  emit("response.output_item.done", {
    type: "response.output_item.done",
    output_index: idx,
    item: {
      id: `${custom ? "ctc" : "fc"}_${callId}`,
      type: custom ? "custom_tool_call" : "function_call",
      ...(custom ? { input: extractInput(args) } : { arguments: args }),
      call_id: callId,
      name: state.funcNames[key] || "",
    },
  });

  state.funcItemDone[key] = true;
}

function extractInput(args: string): string {
  try {
    const parsed = JSON.parse(args);
    if (parsed && typeof parsed === "object" && typeof (parsed as Any).input === "string") {
      return (parsed as Any).input as string;
    }
  } catch {
    // raw freeform input
  }
  return args;
}

function sendCompleted(state: ChatToResponsesState, emit: Emit): void {
  if (state.completedSent) return;
  state.completedSent = true;
  emit("response.completed", {
    type: "response.completed",
    response: {
      id: state.responseId,
      object: "response",
      created_at: state.created,
      status: "completed",
      background: false,
      error: null,
    },
  });
}

/**
 * Terminal flush for chat→responses: close all open items, then either
 * response.completed (normal) or response.failed (stream ended without a
 * finish_reason chunk) BEFORE `data: [DONE]` — exactly once.
 */
export function chatToResponsesFlush(
  state: ChatToResponsesState,
  emit: Emit,
): "completed" | "failed" {
  for (const i of Object.keys(state.msgItemAdded)) closeMessage(state, emit, i);
  closeReasoning(state, emit);
  for (const i of Object.keys(state.funcCallIds)) closeToolCall(state, emit, i);

  if (state.completedSent) return "completed";
  emit("response.failed", {
    type: "response.failed",
    response: {
      id: state.responseId,
      object: "response",
      created_at: state.created,
      status: "failed",
      background: false,
      error: { code: "stream_closed", message: "Upstream stream closed before completion" },
    },
  });
  return "failed";
}
