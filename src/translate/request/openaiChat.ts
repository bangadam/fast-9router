// Chat Completions (client format "openai") ↔ internal normalized request.
// Derived from 9Router (https://github.com/decolua/9router), MIT License,
// Copyright (c) 2024-2026 decolua and contributors.

import type {
  ContentPart,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedTool,
} from "../types.ts";
import { safeParseJSON } from "../helpers.ts";

type Any = Record<string, unknown>;

const PASS_THROUGH_KEYS = [
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "n",
  "logprobs",
  "top_logprobs",
  "user",
  "service_tier",
  "response_format",
  "stream_options",
  "parallel_tool_calls",
  "modalities",
  "audio",
  "prediction",
  "web_search_options",
] as const;

export function fromOpenaiChatRequest(body: Any): NormalizedRequest {
  const req: NormalizedRequest = {
    model: String(body.model ?? ""),
    stream: body.stream === true,
    messages: [],
  };

  for (const msg of (Array.isArray(body.messages) ? body.messages : []) as Any[]) {
    if (!msg || typeof msg !== "object") continue;
    const m: NormalizedMessage = {
      role: (typeof msg.role === "string" ? msg.role : "user") as NormalizedMessage["role"],
      content: typeof msg.content === "string" ? msg.content : "",
    };
    if (Array.isArray(msg.content)) {
      m.content = (msg.content as Any[]).map(fromOpenaiContentPart);
    }
    // Multi-turn reasoning metadata (assistant history from reasoning models).
    if (typeof msg.reasoning_content === "string" && msg.reasoning_content) {
      m.reasoning_content = msg.reasoning_content;
    }
    if (typeof msg.encrypted_content === "string" && msg.encrypted_content) {
      m.encrypted_content = msg.encrypted_content;
    } else if (
      typeof msg.reasoning_encrypted_content === "string" &&
      msg.reasoning_encrypted_content
    ) {
      m.encrypted_content = msg.reasoning_encrypted_content;
    }
    // tool_calls → tool_call parts (content array).
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const parts: ContentPart[] = Array.isArray(m.content)
        ? (m.content as ContentPart[])
        : m.content
          ? [{ type: "text", text: String(m.content) }]
          : [];
      for (const tc of msg.tool_calls as Any[]) {
        const fn = (tc.function ?? {}) as Any;
        if (fn.name) {
          parts.push({
            type: "tool_call",
            id: String(tc.id ?? ""),
            name: String(fn.name),
            arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
          });
        }
      }
      m.content = parts;
    }
    // Tool message: fold into a tool_result part so other formats can group.
    if (m.role === "tool" && typeof msg.tool_call_id === "string") {
      m.content = [
        {
          type: "tool_result",
          tool_call_id: msg.tool_call_id,
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
        },
      ];
    }
    req.messages.push(m);
  }

  if (Array.isArray(body.tools)) {
    req.tools = (body.tools as Any[])
      .map((tool) => normalizeChatTool(tool))
      .filter((t): t is NormalizedTool => t !== null);
  }
  if (body.tool_choice !== undefined) req.tool_choice = body.tool_choice;

  if (typeof body.reasoning_effort === "string") {
    req.reasoning = { effort: body.reasoning_effort };
  } else if (body.reasoning && typeof body.reasoning === "object") {
    const r = body.reasoning as Any;
    const intent: { effort?: string; budget_tokens?: number } = {};
    if (typeof r.effort === "string") intent.effort = r.effort;
    if (typeof r.budget_tokens === "number") intent.budget_tokens = r.budget_tokens;
    if (Object.keys(intent).length) req.reasoning = intent;
  }

  const maxTok = body.max_completion_tokens ?? body.max_tokens;
  if (typeof maxTok === "number") req.max_tokens = maxTok;
  if (typeof body.temperature === "number") req.temperature = body.temperature;
  if (typeof body.top_p === "number") req.top_p = body.top_p;

  const pass: Any = {};
  for (const key of PASS_THROUGH_KEYS) {
    if (body[key] !== undefined) pass[key] = body[key];
  }
  if (Object.keys(pass).length) req.passthrough = pass;

  return req;
}

function fromOpenaiContentPart(part: unknown): ContentPart {
  const p = (part ?? {}) as Any;
  if (p.type === "text" || typeof p.text === "string") {
    return { type: "text", text: String(p.text ?? "") };
  }
  if (p.type === "image_url" && p.image_url && typeof p.image_url === "object") {
    const iu = p.image_url as Any;
    return {
      type: "image",
      image_url: String(iu.url ?? ""),
      ...(typeof iu.detail === "string" ? { detail: iu.detail } : {}),
    };
  }
  if (p.type === "image" && typeof p.source === "object") {
    // Anthropic-style base64 source inside a chat body.
    const src = p.source as Any;
    if (src.type === "base64") {
      return {
        type: "image",
        image_url: `data:${src.media_type};base64,${src.data}`,
      };
    }
    if (src.type === "url") return { type: "image", image_url: String(src.url ?? "") };
  }
  if (p.type === "tool_use") {
    return {
      type: "tool_call",
      id: String(p.id ?? ""),
      name: String(p.name ?? ""),
      arguments: JSON.stringify(p.input ?? {}),
    };
  }
  if (p.type === "tool_result") {
    return {
      type: "tool_result",
      tool_call_id: String(p.tool_use_id ?? ""),
      content: typeof p.content === "string" ? p.content : JSON.stringify(p.content ?? ""),
      ...(p.is_error ? { is_error: true } : {}),
    };
  }
  // Unknown part — keep text form.
  return { type: "text", text: String(p.text ?? p.content ?? JSON.stringify(p)) };
}

/**
 * Chat tools arrive in three shapes (fixture-tested):
 *   (a) { type: "function", function: { name, ... } }
 *   (b) { function: { name, ... } }             (no parent type)
 *   (c) flat Anthropic shape { name, description, input_schema }
 * plus hosted tool types that pass through untouched.
 */
export function normalizeChatTool(tool: Any): NormalizedTool | null {
  const type = typeof tool.type === "string" ? tool.type : "";
  if (type && type !== "function") {
    // Hosted / built-in tool — pass through verbatim.
    return { name: String(tool.name ?? type), passthrough: { ...tool } };
  }
  const toolData = (tool.function ?? tool) as Any;
  const name = typeof toolData?.name === "string" ? toolData.name : "";
  if (!name) return null;
  const t: NormalizedTool = { name };
  if (typeof toolData.description === "string") t.description = toolData.description;
  const params = toolData.parameters ?? toolData.input_schema;
  if (params && typeof params === "object") {
    t.parameters = params as Record<string, unknown>;
  }
  return t;
}

export function toOpenaiChatRequest(req: NormalizedRequest): Any {
  const body: Any = { model: req.model, stream: req.stream, messages: [] };

  const messages: Any[] = [];
  if (req.system !== undefined && req.system !== "") {
    messages.push({ role: "system", content: req.system });
  }

  for (const msg of req.messages) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }
    const parts = msg.content as ContentPart[];
    const textParts = parts.filter(
      (p): p is Extract<ContentPart, { type: "text" }> => p.type === "text",
    );
    const toolCalls = parts.filter(
      (p): p is Extract<ContentPart, { type: "tool_call" }> => p.type === "tool_call",
    );
    const toolResults = parts.filter(
      (p): p is Extract<ContentPart, { type: "tool_result" }> => p.type === "tool_result",
    );
    const images = parts.filter(
      (p): p is Extract<ContentPart, { type: "image" }> => p.type === "image",
    );

    for (const tr of toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: tr.tool_call_id,
        content: tr.content,
      });
    }

    if (toolCalls.length > 0 || images.length > 0 || textParts.length > 0) {
      const out: Any = { role: msg.role };
      const content: Any[] = [];
      for (const tp of textParts) {
        content.push({ type: "text", text: tp.text });
      }
      for (const ip of images) {
        content.push({
          type: "image_url",
          image_url: { url: ip.image_url, ...(ip.detail ? { detail: ip.detail } : {}) },
        });
      }
      if (toolCalls.length > 0) {
        out.content = content.length > 0 ? content : null;
        out.tool_calls = toolCalls.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: t.arguments },
        }));
      } else {
        out.content = content.length === 1 && content[0]!.type === "text" ? (content[0] as Any).text : content;
      }
      if (msg.reasoning_content) out.reasoning_content = msg.reasoning_content;
      if (msg.encrypted_content) out.encrypted_content = msg.encrypted_content;
      messages.push(out);
    } else if (toolResults.length === 0 && msg.role !== "system" && msg.role !== "developer") {
      // Empty content — keep the turn so the message sequence stays intact.
      messages.push({ role: msg.role, content: "" });
    }
  }

  body.messages = messages;

  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => {
      if (t.passthrough) return t.passthrough;
      const fn: Any = {
        name: t.name,
        description: t.description ?? "",
        parameters: t.parameters ?? { type: "object", properties: {} },
      };
      if (t.custom) {
        fn.parameters = {
          type: "object",
          properties: {
            input: { type: "string", description: "Raw freeform input for this custom tool" },
          },
          required: ["input"],
          additionalProperties: false,
        };
      }
      return { type: "function", function: fn };
    });
  }
  if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;
  if (req.reasoning?.effort) body.reasoning_effort = req.reasoning.effort;
  if (typeof req.max_tokens === "number") body.max_tokens = req.max_tokens;
  if (typeof req.temperature === "number") body.temperature = req.temperature;
  if (typeof req.top_p === "number") body.top_p = req.top_p;
  if (req.passthrough) Object.assign(body, req.passthrough);
  return body;
}

/** Collapse reasoning input from a chat message for Responses reasoning items. */
export function chatReasoningSummary(msg: Any): string {
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) {
    return msg.reasoning_content;
  }
  if (typeof msg.reasoning === "string" && msg.reasoning.trim()) return msg.reasoning;
  if (Array.isArray(msg.reasoning_details)) {
    return (msg.reasoning_details as Any[])
      .map((d) =>
        typeof d?.text === "string" ? d.text : typeof d?.content === "string" ? d.content : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export { safeParseJSON };
