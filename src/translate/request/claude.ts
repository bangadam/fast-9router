// Claude Messages API (client format "claude") ↔ internal normalized request.
// Derived from 9Router (https://github.com/decolua/9router), MIT License,
// Copyright (c) 2024-2026 decolua and contributors.

import type {
  ContentPart,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedTool,
} from "../types.ts";
import { encodeDataUri, safeParseJSON } from "../helpers.ts";

type Any = Record<string, unknown>;

/** Claude tool_choice only accepts auto | any | tool | none — never leak others. */
const CLAUDE_TOOL_CHOICE_TYPES: Record<string, true> = {
  auto: true,
  any: true,
  tool: true,
  none: true,
};

export function fromClaudeRequest(body: Any): NormalizedRequest {
  const req: NormalizedRequest = {
    model: String(body.model ?? ""),
    stream: body.stream === true,
    messages: [],
  };

  // system: string or block array → joined text.
  if (typeof body.system === "string" && body.system) {
    req.system = body.system;
  } else if (Array.isArray(body.system)) {
    const text = (body.system as Any[])
      .map((s) => (typeof s?.text === "string" ? s.text : ""))
      .filter(Boolean)
      .join("\n");
    if (text) req.system = text;
  }

  for (const msg of (Array.isArray(body.messages) ? body.messages : []) as Any[]) {
    if (!msg || typeof msg !== "object") continue;
    req.messages.push(fromClaudeMessage(msg));
  }

  if (Array.isArray(body.tools)) {
    req.tools = (body.tools as Any[]).map(fromClaudeTool);
  }
  if (body.tool_choice !== undefined) req.tool_choice = body.tool_choice;

  if (typeof body.reasoning_effort === "string") {
    req.reasoning = { effort: body.reasoning_effort };
  } else if (body.thinking && typeof body.thinking === "object") {
    const t = body.thinking as Any;
    if (typeof t.budget_tokens === "number") {
      req.reasoning = { budget_tokens: t.budget_tokens };
    }
  }
  if (typeof body.max_tokens === "number") req.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") req.temperature = body.temperature;
  if (typeof body.top_p === "number") req.top_p = body.top_p;

  const pass: Any = {};
  if (Array.isArray(body.stop_sequences)) pass.stop = body.stop_sequences;
  if (typeof body.top_k === "number") pass.top_k = body.top_k;
  if (Object.keys(pass).length) req.passthrough = pass;

  return req;
}

function fromClaudeMessage(msg: Any): NormalizedMessage {
  // Mid-conversation system → user with <instructions> wrapper (Claude request
  // semantics ported from 9Router: avoids Anthropic prefill 400 on replay).
  if (msg.role === "system") {
    const text = claudeSystemText(msg.content);
    return { role: "user", content: text ? `<instructions>\n${text}\n</instructions>` : "" };
  }
  const role = msg.role === "user" ? "user" : "assistant";
  if (typeof msg.content === "string") {
    return { role, content: msg.content };
  }
  const parts: ContentPart[] = [];
  for (const block of (Array.isArray(msg.content) ? msg.content : []) as Any[]) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: String(block.text ?? "") });
        break;
      case "image": {
        const src = block.source as Any | undefined;
        if (src?.type === "base64") {
          parts.push({
            type: "image",
            image_url: encodeDataUri(String(src.media_type ?? "image/png"), String(src.data ?? "")),
          });
        } else if (src?.type === "url") {
          parts.push({ type: "image", image_url: String(src.url ?? "") });
        }
        break;
      }
      case "tool_use":
        parts.push({
          type: "tool_call",
          id: String(block.id ?? ""),
          name: String(block.name ?? ""),
          arguments: JSON.stringify(block.input ?? {}),
        });
        break;
      case "tool_result":
        parts.push({
          type: "tool_result",
          tool_call_id: String(block.tool_use_id ?? ""),
          content: claudeToolResultContent(block.content),
          ...(block.is_error ? { is_error: true } : {}),
        });
        break;
      // thinking / document blocks have no chat-side request equivalent — dropped.
    }
  }
  return { role, content: parts, ...(msg.cache_control !== undefined ? { cache_control: msg.cache_control } : {}) };
}

function claudeSystemText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Any[])
    .map((c) => (c?.type === "text" && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

function claudeToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = (content as Any[])
      .filter((c) => c?.type === "text")
      .map((c) => String(c.text ?? ""))
      .join("\n");
    if (text) return text;
    return JSON.stringify(content);
  }
  if (content && typeof content === "object") return JSON.stringify(content);
  return "";
}

function fromClaudeTool(tool: Any): NormalizedTool {
  const name = typeof tool.name === "string" ? tool.name : String(tool.type ?? "");
  const t: NormalizedTool = { name };
  if (typeof tool.description === "string") t.description = tool.description;
  if (tool.input_schema && typeof tool.input_schema === "object") {
    t.parameters = tool.input_schema as Record<string, unknown>;
  }
  // Hosted Claude tools (web_search_*, computer_*, …) pass through verbatim.
  if (typeof tool.type === "string" && tool.type !== "custom" && tool.type !== "function") {
    t.passthrough = { ...tool };
  }
  return t;
}

export function toClaudeRequest(req: NormalizedRequest): Any {
  const body: Any = {
    model: req.model,
    stream: req.stream,
    max_tokens: typeof req.max_tokens === "number" ? req.max_tokens : 8192,
    messages: [],
  };
  if (typeof req.temperature === "number") body.temperature = req.temperature;
  if (typeof req.top_p === "number") body.top_p = req.top_p;

  const systemParts: string[] = [];
  if (req.system) systemParts.push(req.system);

  // response_format JSON mode → system instruction (chat-client passthrough).
  const rf = req.passthrough?.response_format as Any | undefined;
  if (rf && typeof rf === "object") {
    const schema = (rf.json_schema as Any | undefined)?.schema;
    if (rf.type === "json_schema" && schema) {
      systemParts.push(
        `You must respond with valid JSON that strictly follows this JSON schema:\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\`\nRespond ONLY with the JSON object, no other text.`,
      );
    } else if (rf.type === "json_object") {
      systemParts.push("You must respond with valid JSON. Respond ONLY with a JSON object, no other text.");
    }
  }
  if (systemParts.length > 0) {
    body.system = systemParts.map((text) => ({ type: "text", text }));
  }

  // Messages: tool_result parts become their own user message immediately;
  // tool_use-bearing messages flush right after push; same-role runs merge.
  const messages: Any[] = [];
  let currentRole: string | undefined;
  let currentParts: Any[] = [];

  const flushCurrentMessage = () => {
    if (currentRole && currentParts.length > 0) {
      messages.push({ role: currentRole, content: currentParts });
      currentParts = [];
    }
  };

  for (const msg of req.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      // Handled via systemParts when first; later ones are appended as system.
      const text = typeof msg.content === "string" ? msg.content : textContentJoined(msg.content);
      if (text) systemPartsPush(body, text);
      continue;
    }
    const newRole = msg.role === "user" || msg.role === "tool" ? "user" : "assistant";
    const blocks = claudeBlocksFromMessage(msg);
    const hasToolUse = blocks.some((b) => b.type === "tool_use");
    const hasToolResult = blocks.some((b) => b.type === "tool_result");

    if (hasToolResult) {
      const toolResultBlocks = blocks.filter((b) => b.type === "tool_result");
      const otherBlocks = blocks.filter((b) => b.type !== "tool_result");
      flushCurrentMessage();
      if (toolResultBlocks.length > 0) {
        messages.push({ role: "user", content: toolResultBlocks });
      }
      if (otherBlocks.length > 0) {
        currentRole = newRole;
        currentParts.push(...otherBlocks);
      }
      continue;
    }

    if (currentRole !== newRole) {
      flushCurrentMessage();
      currentRole = newRole;
    }
    currentParts.push(...blocks);
    if (hasToolUse) flushCurrentMessage();
  }
  flushCurrentMessage();
  body.messages = messages;

  if (req.tools && req.tools.length > 0) {
    const tools: Any[] = req.tools.map((t) => {
      if (t.passthrough) return t.passthrough;
      return {
        name: t.name,
        description: t.description ?? "",
        input_schema: t.parameters ?? { type: "object", properties: {}, required: [] },
      };
    });
    tools[tools.length - 1]!.cache_control = { type: "ephemeral", ttl: "1h" };
    body.tools = tools;
  }

  if (req.tool_choice !== undefined) {
    body.tool_choice = toClaudeToolChoice(req.tool_choice);
  }

  // thinking config
  if (req.reasoning?.budget_tokens) {
    body.thinking = { type: "enabled", budget_tokens: req.reasoning.budget_tokens };
  }

  return body;
}

function systemPartsPush(body: Any, text: string): void {
  if (!Array.isArray(body.system)) body.system = [];
  const system = body.system as Any[];
  system.push({ type: "text", text });
}

function textContentJoined(content: string | ContentPart[] | undefined): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function claudeBlocksFromMessage(msg: NormalizedMessage): Any[] {
  const blocks: Any[] = [];
  if (typeof msg.content === "string") {
    if (msg.content) blocks.push({ type: "text", text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      switch (part.type) {
        case "text":
          if (part.text) blocks.push({ type: "text", text: part.text });
          break;
        case "image": {
          const url = part.image_url;
          const m = /^data:([^;]+);base64,([\s\S]+)$/.exec(url);
          if (m) {
            blocks.push({
              type: "image",
              source: { type: "base64", media_type: m[1], data: m[2] },
            });
          } else if (url.startsWith("http://") || url.startsWith("https://")) {
            blocks.push({ type: "image", source: { type: "url", url } });
          }
          break;
        }
        case "tool_call":
          blocks.push({
            type: "tool_use",
            id: part.id,
            name: part.name,
            input: safeParseJSON(part.arguments, part.arguments) as Any,
          });
          break;
        case "tool_result":
          blocks.push({
            type: "tool_result",
            tool_use_id: part.tool_call_id,
            content: part.content,
            ...(part.is_error ? { is_error: part.is_error } : {}),
          });
          break;
      }
    }
  }
  return blocks;
}

function toClaudeToolChoice(choice: unknown): Any {
  if (!choice) return { type: "auto" };
  if (typeof choice === "string") {
    if (choice === "required") return { type: "any" };
    return { type: "auto" }; // "auto", "none", or anything unexpected
  }
  if (typeof choice === "object" && !Array.isArray(choice)) {
    const c = choice as Any;
    // Chat forced-tool shape — checked before native passthrough because its
    // .type ("function") is rejected by Claude.
    if (c.function && typeof c.function === "object" && (c.function as Any).name) {
      return { type: "tool", name: (c.function as Any).name };
    }
    if (typeof c.type === "string" && CLAUDE_TOOL_CHOICE_TYPES[c.type]) {
      return c;
    }
  }
  return { type: "auto" };
}
