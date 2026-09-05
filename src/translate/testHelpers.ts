// Test helpers: run translateStream over fixture frames and collect output.
import { translateStream, type ClientFormat } from "./index.ts";

export const enc = new TextEncoder();

export function chatChunkSse(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function responsesEventSse(eventType: string, event: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function claudeEventSse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function runStream(
  from: ClientFormat,
  to: ClientFormat,
  input: string,
  opts?: { model?: string; customToolNames?: Set<string> },
): Promise<string> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(input));
      controller.close();
    },
  });
  const output = source.pipeThrough(translateStream(from, to, opts));
  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Parse SSE text into frames — data stays the raw string (incl. [DONE]). */
export function parseSse(text: string): { event?: string; data: string }[] {
  const frames: { event?: string; data: string }[] = [];
  for (const raw of text.split(/\r?\n\r?\n/)) {
    if (!raw.trim()) continue;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("event:")) event = line.slice(6).replace(/^ /, "");
    }
    if (dataLines.length) frames.push({ event, data: dataLines.join("\n") });
  }
  return frames;
}

type Json = Record<string, unknown>;

/** Parse SSE text; JSON-decode data lines (skips [DONE]). */
export function parseSseJson(text: string): { event?: string; data: Json }[] {
  return parseSse(text)
    .filter((f) => f.data !== "[DONE]")
    .map((f) => ({ event: f.event, data: JSON.parse(f.data) as Json }));
}

function asJson(v: unknown): Json {
  return (v ?? {}) as Json;
}

/**
 * Aggregate chat-completions SSE chunks into a chat.completion body
 * (forced-SSE-to-JSON, as the routing layer does for non-stream clients
 * behind streaming-only upstreams).
 */
export function aggregateChatChunks(chunks: Json[]): Json {
  const message: Json = { role: "assistant" };
  let content = "";
  let reasoning = "";
  const toolCalls: Json[] = [];
  let finishReason: string | null = null;
  let usage: Json | undefined;
  for (const c of chunks) {
    const rawUsage = asJson(c.usage);
    if (Object.keys(rawUsage).length) usage = rawUsage;
    const choice = asJson((c.choices as Json[] | undefined)?.[0]);
    if (!choice) continue;
    const d = asJson(choice.delta);
    if (typeof d.content === "string") content += d.content;
    if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
    for (const tc of (Array.isArray(d.tool_calls) ? d.tool_calls : []) as Json[]) {
      const idx = typeof tc.index === "number" ? tc.index : 0;
      const fn = asJson(tc.function);
      if (!toolCalls[idx]) {
        toolCalls[idx] = {
          id: typeof tc.id === "string" ? tc.id : "",
          type: "function",
          function: { name: "", arguments: "" },
        };
      }
      const slot = asJson(toolCalls[idx]);
      if (typeof tc.id === "string" && tc.id) slot.id = tc.id;
      const slotFn = asJson(slot.function);
      if (typeof fn.name === "string" && fn.name) slotFn.name = fn.name;
      if (typeof fn.arguments === "string") slotFn.arguments += fn.arguments;
    }
    if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
  }
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) {
    if (content) message.content = content;
    else message.content = null;
    message.tool_calls = toolCalls;
  } else {
    message.content = content;
  }
  return {
    id: (chunks[0]?.id as string) ?? "chatcmpl-aggregated",
    object: "chat.completion",
    created: (chunks[0]?.created as number) ?? Math.floor(Date.now() / 1000),
    model: (chunks[0]?.model as string) ?? "unknown",
    choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
    ...(usage ? { usage } : {}),
  };
}

/** Aggregate the chat chunks out of a translated stream (parses [DONE] off). */
export function aggregateStreamChatChunks(text: string): Json {
  const chunks = parseSse(text)
    .filter((f) => f.data !== "[DONE]")
    .map((f) => JSON.parse(f.data) as Json);
  return aggregateChatChunks(chunks);
}
