// translateStream — the streaming seam the routing layer pipes upstream
// response bodies through. Upstream SSE bytes in → client-format SSE bytes
// out, fully incremental (per-frame transform, no whole-stream buffering).
// Derived from 9Router (https://github.com/decolua/9router), MIT License,
// Copyright (c) 2024-2026 decolua and contributors.

import type { ClientFormat, TranslateOptions } from "./types.ts";
import { makeEventStream, parseSseData } from "./sse.ts";
import {
  ResponsesToChatState,
  responsesEventToChatChunks,
  responsesToChatFlush,
  makeChatToResponsesState,
  chatChunkToResponsesEvents,
  chatToResponsesFlush,
} from "./stream/responses.ts";
import {
  ChatToClaudeState,
  chatChunkToClaudeEvents,
  claudeEventToChatChunks,
  makeClaudeToChatState,
} from "./stream/claude.ts";

type Any = Record<string, unknown>;

/**
 * Build the streaming translator. Pipe the upstream fetch body through
 * `.readable`/`.writable`; the readable side emits client-format SSE bytes.
 * Identity passthrough when from === to.
 *
 * Terminal-event contract:
 *  - client openai: final chunk carries finish_reason, then `data: [DONE]`.
 *  - client openai-responses: response.completed (or response.failed when the
 *    stream ends without a terminal event) before `data: [DONE]`, each once.
 *  - client claude: message_delta with stop_reason, then message_stop.
 */
export function translateStream(
  from: ClientFormat,
  to: ClientFormat,
  opts: TranslateOptions = {},
): TransformStream<Uint8Array, Uint8Array> {
  // Same-format responses→responses still needs the terminal-event wrapper:
  // if the upstream stream closes (or sends [DONE]) without
  // response.completed/response.done, emit response.failed BEFORE [DONE].
  if (from === "openai-responses" && to === "openai-responses") {
    return responsesPassthroughWithWrapper();
  }
  if (from === to) return new TransformStream<Uint8Array, Uint8Array>();

  switch (`${from}>${to}`) {
    case "openai>openai-responses":
      return chatToResponsesStream(opts);
    case "openai>claude":
      return chatToClaudeStream();
    case "openai-responses>openai":
      return responsesToChatStream(opts);
    case "openai-responses>claude":
      return responsesToClaudeStream();
    case "claude>openai":
      return claudeToChatStream(opts);
    case "claude>openai-responses":
      return claudeToResponsesStream(opts);
    default:
      throw new Error(`translateStream: unsupported pair ${from} → ${to}`);
  }
}

// openai chat → openai responses
function chatToResponsesStream(opts: TranslateOptions): TransformStream<Uint8Array, Uint8Array> {
  const state = makeChatToResponsesState(opts);
  let doneSent = false;

  const stream = makeEventStream(
    (ev) => {
      if (ev.data === "[DONE]") {
        // Terminal wrapper: flush (completed or failed) BEFORE [DONE], once.
        if (!state.completedSent) {
          chatToResponsesFlush(state, (eventType, data) => stream.emit(data, eventType));
        }
        if (!doneSent) {
          doneSent = true;
          stream.emitRaw("[DONE]");
        }
        return;
      }
      const parsed = parseSseData(ev.data);
      if (parsed) {
        chatChunkToResponsesEvents(parsed, state, (eventType, data) => stream.emit(data, eventType));
      }
    },
    () => {
      if (!state.completedSent) {
        chatToResponsesFlush(state, (eventType, data) => stream.emit(data, eventType));
      }
      if (!doneSent) {
        doneSent = true;
        stream.emitRaw("[DONE]");
      }
    },
  );
  return stream.transform;
}

// openai chat → claude
function chatToClaudeStream(): TransformStream<Uint8Array, Uint8Array> {
  const state = new ChatToClaudeState();

  const stream = makeEventStream(
    (ev) => {
      if (ev.data === "[DONE]") return; // chat terminal; claude ends with message_stop
      const parsed = parseSseData(ev.data);
      if (!parsed) return;
      const events = chatChunkToClaudeEvents(parsed, state);
      if (events) for (const e of events) stream.emit(e);
    },
    () => {
      // Upstream ended without a finish_reason chunk — synthesize terminal
      // events so the claude client still gets blocks closed + message_stop.
      if (!state.messageStopSent) {
        const events = chatChunkToClaudeEvents(
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          state,
        );
        if (events) for (const e of events) stream.emit(e);
      }
    },
  );
  return stream.transform;
}

// openai responses → openai chat
function responsesToChatStream(opts: TranslateOptions): TransformStream<Uint8Array, Uint8Array> {
  const state = new ResponsesToChatState();
  if (opts.model) state.model = opts.model;
  let doneSent = false;

  const stream = makeEventStream(
    (ev) => {
      const chunks = responsesEventToChatChunks(ev, state);
      if (chunks) for (const c of chunks) stream.emit(c);
    },
    () => {
      const chunks = responsesToChatFlush(state);
      if (chunks) for (const c of chunks) stream.emit(c);
      if (!doneSent) {
        doneSent = true;
        stream.emitRaw("[DONE]");
      }
    },
  );
  return stream.transform;
}

// openai responses → claude (responses events → chat chunks → claude events)
function responsesToClaudeStream(): TransformStream<Uint8Array, Uint8Array> {
  const responsesState = new ResponsesToChatState();
  const claudeState = new ChatToClaudeState();

  const stream = makeEventStream(
    (ev) => {
      if (ev.data === "[DONE]") return;
      const chunks = responsesEventToChatChunks(ev, responsesState);
      if (!chunks) return;
      for (const c of chunks) {
        const events = chatChunkToClaudeEvents(c, claudeState);
        if (events) for (const e of events) stream.emit(e);
      }
    },
    () => {
      const chunks = responsesToChatFlush(responsesState);
      const all = chunks ?? [];
      for (const c of all) {
        const events = chatChunkToClaudeEvents(c, claudeState);
        if (events) for (const e of events) stream.emit(e);
      }
      if (!claudeState.messageStopSent) {
        const events = chatChunkToClaudeEvents(
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          claudeState,
        );
        if (events) for (const e of events) stream.emit(e);
      }
    },
  );
  return stream.transform;
}

// claude → openai chat
function claudeToChatStream(opts: TranslateOptions): TransformStream<Uint8Array, Uint8Array> {
  const state = makeClaudeToChatState(opts.model);
  let doneSent = false;

  const stream = makeEventStream(
    (ev) => {
      if (ev.data === "[DONE]") return;
      const chunks = claudeEventToChatChunks(ev, state);
      if (chunks) for (const c of chunks) stream.emit(c);
    },
    () => {
      // Upstream ended without message_stop — fallback terminal chunk.
      if (!state.finishReasonSent) {
        const messageStop = { event: "message_stop", data: JSON.stringify({ type: "message_stop" }) };
        const chunks = claudeEventToChatChunks(messageStop, state);
        if (chunks) for (const c of chunks) stream.emit(c);
      }
      if (!doneSent) {
        doneSent = true;
        stream.emitRaw("[DONE]");
      }
    },
  );
  return stream.transform;
}

// claude → openai responses (claude events → chat chunks → responses events)
function claudeToResponsesStream(opts: TranslateOptions): TransformStream<Uint8Array, Uint8Array> {
  const claudeState = makeClaudeToChatState(opts.model);
  const responsesState = makeChatToResponsesState(opts);
  let doneSent = false;

  const stream = makeEventStream(
    (ev) => {
      if (ev.data === "[DONE]") return;
      const chunks = claudeEventToChatChunks(ev, claudeState);
      if (!chunks) return;
      for (const c of chunks) {
        chatChunkToResponsesEvents(c, responsesState, (eventType, data) => stream.emit(data, eventType));
      }
    },
    () => {
      // Terminal wrapper: response.completed/failed before [DONE], once each.
      if (!responsesState.completedSent) {
        chatToResponsesFlush(responsesState, (eventType, data) => stream.emit(data, eventType));
      }
      if (!doneSent) {
        doneSent = true;
        stream.emitRaw("[DONE]");
      }
    },
  );
  return stream.transform;
}


// responses → responses passthrough with terminal-event wrapper
function responsesPassthroughWithWrapper(): TransformStream<Uint8Array, Uint8Array> {
  let sawTerminal = false; // response.completed | response.done | response.failed
  let doneSent = false;

  const stream = makeEventStream(
    (ev) => {
      // Pass every frame through verbatim, watching for terminal events.
      const parsed = ev.data === "[DONE]" ? null : parseSseData(ev.data);
      if (parsed) {
        const t = (parsed.type as string) ?? "";
        if (t === "response.completed" || t === "response.done" || t === "response.failed") {
          sawTerminal = true;
        }
      }
      if (ev.data === "[DONE]") {
        if (!sawTerminal) {
          stream.emit(
            {
              type: "response.failed",
              response: {
                object: "response",
                status: "failed",
                background: false,
                error: {
                  code: "stream_closed",
                  message: "Upstream stream closed before completion",
                },
              },
            },
            "response.failed",
          );
        }
        if (!doneSent) {
          doneSent = true;
          stream.emitRaw("[DONE]");
        }
        return;
      }
      stream.emitRaw(ev.data);
    },
    () => {
      if (!sawTerminal) {
        stream.emit(
          {
            type: "response.failed",
            response: {
              object: "response",
              status: "failed",
              background: false,
              error: {
                code: "stream_closed",
                message: "Upstream stream closed before completion",
              },
            },
          },
          "response.failed",
        );
      }
      if (!doneSent) {
        doneSent = true;
        stream.emitRaw("[DONE]");
      }
    },
  );
  return stream.transform;
}
