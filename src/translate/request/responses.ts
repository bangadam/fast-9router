// OpenAI Responses API (client/upstream format "openai-responses") ↔ internal
// normalized request, plus Codex-specific upstream normalization.
// Derived from 9Router (https://github.com/decolua/9router), MIT License,
// Copyright (c) 2024-2026 decolua and contributors.

import type {
  ContentPart,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedTool,
} from "../types.ts";
import { clampCallId, normalizeToolParameters } from "../helpers.ts";

type Any = Record<string, unknown>;
interface ReasoningSource {
  encrypted_content?: unknown;
  reasoning_content?: unknown;
  reasoning_encrypted_content?: unknown;
  reasoning?: unknown;
  reasoning_details?: unknown;
}

type ResponsesRequest = Any & { input: Any[] };


/** input: string | array → array of message items (placeholder when empty). */
export function normalizeResponsesInput(input: unknown): Any[] | null {
  if (typeof input === "string") {
    const text = input.trim() === "" ? "..." : input;
    return [
      { type: "message", role: "user", content: [{ type: "input_text", text }] },
    ];
  }
  if (Array.isArray(input)) {
    if (input.length === 0) {
      return [
        { type: "message", role: "user", content: [{ type: "input_text", text: "..." }] },
      ];
    }
    return input as Any[];
  }
  return null;
}

function reasoningSummaryText(item: Any): string {
  if (Array.isArray(item.summary)) {
    const txt = (item.summary as Any[])
      .map((s) => (typeof s?.text === "string" ? s.text : ""))
      .filter(Boolean)
      .join("\n");
    if (txt) return txt;
  }
  if (Array.isArray(item.content)) {
    const txt = (item.content as Any[])
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
    if (txt) return txt;
  }
  return "";
}

export function fromResponsesRequest(body: Any): NormalizedRequest {
  const req: NormalizedRequest = {
    model: String(body.model ?? ""),
    stream: body.stream === true,
    messages: [],
  };
  if (typeof body.instructions === "string" && body.instructions) {
    req.system = body.instructions;
  }

  const inputItems = normalizeResponsesInput(body.input) ?? [];
  // Buffer reasoning text/encrypted blobs to attach to the next assistant turn.
  let pendingReasoning = "";
  let pendingReasoningEncrypted = "";
  const attachPendingReasoning = (msg: NormalizedMessage) => {
    if (pendingReasoning) msg.reasoning_content = pendingReasoning;
    if (pendingReasoningEncrypted) msg.encrypted_content = pendingReasoningEncrypted;
    pendingReasoning = "";
    pendingReasoningEncrypted = "";
  };

  for (const item of inputItems) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const itemType =
      typeof item.type === "string" && item.type
        ? item.type
        : typeof item.role === "string"
          ? "message"
          : null;

    if (itemType === "message") {
      const msg: NormalizedMessage = {
        role: (typeof item.role === "string" ? item.role : "user") as NormalizedMessage["role"],
        content: responsesContentToParts(item),
      };
      if (msg.role === "assistant") {
        attachPendingReasoning(msg);
      } else {
        pendingReasoning = "";
        pendingReasoningEncrypted = "";
      }
      req.messages.push(msg);
    } else if (itemType === "function_call" || itemType === "custom_tool_call") {
      const name = typeof item.name === "string" ? item.name : "";
      if (!name || name.trim() === "") continue;
      // Append to the last assistant message when adjacent, else new one.
      let last = req.messages[req.messages.length - 1];
      if (!last || last.role !== "assistant" || !Array.isArray(last.content) || lastContentHasToolCall(last)) {
        last = { role: "assistant", content: [] };
        attachPendingReasoning(last);
        req.messages.push(last);
      }
      const args =
        itemType === "custom_tool_call"
          ? typeof item.input === "string"
            ? JSON.stringify({ input: item.input })
            : JSON.stringify({ input: JSON.stringify(item.input ?? "") })
          : typeof item.arguments === "string"
            ? item.arguments
            : JSON.stringify(item.arguments ?? {});
      (last.content as ContentPart[]).push({
        type: "tool_call",
        id: typeof item.call_id === "string" ? item.call_id : "",
        name,
        arguments: args,
      });
    } else if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      req.messages.push({
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_call_id: typeof item.call_id === "string" ? item.call_id : "",
            content:
              typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
          },
        ],
      });
    } else if (itemType === "reasoning") {
      const txt = reasoningSummaryText(item);
      if (txt) pendingReasoning = pendingReasoning ? `${pendingReasoning}\n${txt}` : txt;
      if (typeof item.encrypted_content === "string" && item.encrypted_content) {
        pendingReasoningEncrypted = item.encrypted_content;
      }
    } else if (itemType === "additional_tools") {
      // handled below with body.tools
    }
  }

  const customToolNames = new Set<string>();
  const tools: NormalizedTool[] = [];
  for (const tool of [
    ...(Array.isArray(body.tools) ? (body.tools as Any[]) : []),
    ...(Array.isArray(body.additional_tools) ? (body.additional_tools as Any[]) : []),
  ]) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    const name = typeof tool.name === "string" ? tool.name : "";
    if (tool.function) {
      // Already Chat-Completions nested shape.
      const fn = tool.function as Any;
      if (typeof fn.name === "string" && fn.name) {
        tools.push({
          name: fn.name,
          ...(typeof fn.description === "string" ? { description: fn.description } : {}),
          ...(fn.parameters && typeof fn.parameters === "object"
            ? { parameters: fn.parameters as Record<string, unknown> }
            : {}),
        });
      }
      continue;
    }
    if (!name || name.trim() === "") continue; // hosted tool without a name
    if (tool.type === "custom") {
      customToolNames.add(name);
      tools.push({ name, custom: true, ...(tool.description ? { description: String(tool.description) } : {}) });
      continue;
    }
    if (typeof tool.type === "string" && tool.type !== "function") {
      tools.push({ name, passthrough: { ...tool } }); // hosted tool
      continue;
    }
    tools.push({
      name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(tool.parameters && typeof tool.parameters === "object"
        ? { parameters: tool.parameters as Record<string, unknown> }
        : {}),
    });
  }
  if (tools.length > 0) req.tools = tools;
  if (customToolNames.size > 0) req.passthrough = { ...req.passthrough, _customToolNames: [...customToolNames] };
  if (body.tool_choice !== undefined) req.tool_choice = body.tool_choice;

  if (body.reasoning && typeof body.reasoning === "object") {
    const r = body.reasoning as Any;
    const intent: { effort?: string; budget_tokens?: number } = {};
    if (typeof r.effort === "string") intent.effort = r.effort;
    if (typeof r.budget_tokens === "number") intent.budget_tokens = r.budget_tokens;
    if (Object.keys(intent).length) req.reasoning = intent;
  } else if (typeof body.reasoning_effort === "string") {
    req.reasoning = { effort: body.reasoning_effort };
  }

  if (typeof body.max_output_tokens === "number") req.max_tokens = body.max_output_tokens;
  if (typeof body.temperature === "number") req.temperature = body.temperature;
  if (typeof body.top_p === "number") req.top_p = body.top_p;

  const pass: Any = {};
  for (const key of ["service_tier", "text", "prompt_cache_key", "background", "truncation", "previous_response_id", "instructions_after"] as const) {
    if (body[key] !== undefined) pass[key] = body[key];
  }
  if (Object.keys(pass).length) req.passthrough = { ...pass, ...(req.passthrough ?? {}) };

  return req;
}

function lastContentHasToolCall(msg: NormalizedMessage): boolean {
  return (
    Array.isArray(msg.content) &&
    (msg.content as ContentPart[]).some((p) => p.type === "tool_call" || p.type === "tool_result")
  );
}

function responsesContentToParts(item: Any): string | ContentPart[] {
  const content = item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: ContentPart[] = [];
  for (const c of content as Any[]) {
    if (c?.type === "input_text" || c?.type === "output_text" || c?.type === "summary_text") {
      parts.push({ type: "text", text: String(c.text ?? "") });
    } else if (c?.type === "input_image") {
      parts.push({
        type: "image",
        image_url: String(c.image_url ?? c.file_id ?? ""),
        ...(typeof c.detail === "string" ? { detail: c.detail } : {}),
      });
    } else if (c && typeof c === "object") {
      parts.push({ type: "text", text: String((c as Any).text ?? JSON.stringify(c)) });
    }
  }
  return parts;
}

/** Build a Responses reasoning input item from chat assistant-message fields. */
export function buildReasoningInputItem(msg: ReasoningSource): Any | null {
  const encrypted =
    (typeof msg.encrypted_content === "string" && msg.encrypted_content) ||
    (typeof msg.reasoning_encrypted_content === "string" && msg.reasoning_encrypted_content) ||
    (msg.reasoning && typeof msg.reasoning === "object" && typeof (msg.reasoning as Any).encrypted_content === "string"
      ? (msg.reasoning as Any).encrypted_content
      : "") ||
    "";

  let summaryText = "";
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) {
    summaryText = msg.reasoning_content;
  } else if (typeof msg.reasoning === "string" && msg.reasoning.trim()) {
    summaryText = msg.reasoning;
  } else if (Array.isArray(msg.reasoning_details)) {
    summaryText = (msg.reasoning_details as Any[])
      .map((d) =>
        typeof d?.text === "string" ? d.text : typeof d?.content === "string" ? d.content : "",
      )
      .filter(Boolean)
      .join("\n");
  }

  if (!encrypted && !summaryText) return null;

  const item: Any = { type: "reasoning" };
  if (summaryText) item.summary = [{ type: "summary_text", text: summaryText }];
  if (encrypted) item.encrypted_content = encrypted; // store=false continuity blob
  return item;
}

export function toResponsesRequest(req: NormalizedRequest): Any {
  const result: ResponsesRequest = {
    model: req.model,
    input: [],
    stream: req.stream,
    store: false,
  };

  let hasSystemMessage = false;
  const customToolNames: string[] = [];

  const ensureInstructions = () => {
    if (!hasSystemMessage) {
      result.instructions = "";
      hasSystemMessage = true;
    }
  };

  for (const msg of req.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      if (!hasSystemMessage) {
        result.instructions = typeof msg.content === "string" ? msg.content : textPartsJoined(msg.content);
        hasSystemMessage = true;
      }
      continue;
    }

    if (msg.role === "user" || msg.role === "assistant") {
      // Multi-turn continuity for store=false backends: re-emit a reasoning
      // item before the assistant message when history carried reasoning.
      if (msg.role === "assistant") {
        const reasoningItem = buildReasoningInputItem(msg);
        if (reasoningItem) result.input.push(reasoningItem);
      }

      const contentType = msg.role === "user" ? "input_text" : "output_text";
      const content: Any[] = [];
      if (typeof msg.content === "string") {
        if (msg.content) content.push({ type: contentType, text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const c of msg.content as ContentPart[]) {
          if (c.type === "text") {
            if (c.text) content.push({ type: contentType, text: c.text });
          } else if (c.type === "image") {
            content.push({
              type: "input_image",
              image_url: c.image_url,
              ...(c.detail ? { detail: c.detail } : { detail: "auto" }),
            });
          }
          // tool_call / tool_result parts are handled separately below.
        }
      }
      const toolCalls = Array.isArray(msg.content)
        ? (msg.content as ContentPart[]).filter(
            (p): p is Extract<ContentPart, { type: "tool_call" }> => p.type === "tool_call",
          )
        : [];

      if (content.length > 0) {
        result.input.push({ type: "message", role: msg.role, content });
      }
      for (const tc of toolCalls) {
        result.input.push({
          type: "function_call",
          call_id: clampCallId(tc.id),
          name: tc.name || "_unknown",
          arguments: tc.arguments || "{}",
        });
      }
      continue;
    }

    if (msg.role === "tool") {
      const results = Array.isArray(msg.content)
        ? (msg.content as ContentPart[]).filter(
            (p): p is Extract<ContentPart, { type: "tool_result" }> => p.type === "tool_result",
          )
        : [];
      if (results.length > 0) {
        for (const tr of results) {
          result.input.push({
            type: "function_call_output",
            call_id: clampCallId(tr.tool_call_id),
            output: tr.content,
          });
        }
      } else if (typeof msg.content === "string") {
        result.input.push({ type: "function_call_output", call_id: "", output: msg.content });
      }
    }
  }

  ensureInstructions();

  if (req.tools && req.tools.length > 0) {
    result.tools = req.tools.map((t) => {
      if (t.passthrough) return t.passthrough;
      if (t.custom) {
        customToolNames.push(t.name);
        return { type: "custom", name: t.name, ...(t.description ? { description: t.description } : {}) };
      }
      return {
        type: "function",
        name: t.name,
        description: t.description ?? "",
        parameters: normalizeToolParameters(t.parameters),
      };
    });
  }

  if (typeof req.temperature === "number") result.temperature = req.temperature;
  if (typeof req.max_tokens === "number") result.max_output_tokens = req.max_tokens;
  if (typeof req.top_p === "number") result.top_p = req.top_p;
  if (req.reasoning) {
    const r: Any = {};
    if (req.reasoning.effort) r.effort = req.reasoning.effort;
    if (req.reasoning.budget_tokens) r.budget_tokens = req.reasoning.budget_tokens;
    r.summary = "auto";
    result.reasoning = r;
  }
  if (req.tool_choice !== undefined) result.tool_choice = req.tool_choice;

  const pass = req.passthrough ?? {};
  if (pass.service_tier !== undefined) result.service_tier = pass.service_tier;
  if (pass.text !== undefined) result.text = pass.text;
  if (pass.prompt_cache_key !== undefined) result.prompt_cache_key = pass.prompt_cache_key;

  if (customToolNames.length > 0) {
    result._customToolNames = customToolNames;
  }

  return result;
}

function textPartsJoined(content: string | ContentPart[] | undefined): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Codex upstream normalization
// ---------------------------------------------------------------------------

// Server-generated item id prefixes that Codex /responses cannot resolve when store=false
const SERVER_ID_PATTERN = /^(rs|fc|resp|msg)_/;

// Hosted tool types that Codex/[OI] Responses executes server-side
const CODEX_HOSTED_TOOL_TYPES: Record<string, true> = {
  image_generation: true,
  web_search: true,
  web_search_preview: true,
  file_search: true,
  computer: true,
  computer_use_preview: true,
  code_interpreter: true,
  mcp: true,
  local_shell: true,
  tool_search: true,
};

const CODEX_PASSTHROUGH_TOOL_TYPES: Record<string, true> = { custom: true };

export function convertSystemToDeveloperRole(body: Any): void {
  if (!Array.isArray(body.input)) return;
  for (const item of body.input as Any[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const isSystemMsg = item.role === "system" && (!item.type || item.type === "message");
    if (isSystemMsg) item.role = "developer";
  }
}

export function stripStoredItemReferences(body: Any): void {
  if (!Array.isArray(body.input)) return;
  body.input = (body.input as unknown[]).filter((item) => {
    if (typeof item === "string" && SERVER_ID_PATTERN.test(item)) return false;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const it = item as Any;
      if (it.type === "item_reference") return false;
      if (typeof it.id === "string" && SERVER_ID_PATTERN.test(it.id)) delete it.id;
    }
    return true;
  });
}

export function normalizeCodexTools(body: Any): void {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set<string>();
  body.tools = (body.tools as Any[]).filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const type = typeof tool.type === "string" ? tool.type : "";
    if (type === "namespace") {
      if (Array.isArray(tool.tools)) {
        for (const st of tool.tools as Any[]) {
          const n = typeof st?.name === "string" ? st.name.trim().slice(0, 128) : "";
          if (n) validNames.add(n);
        }
      }
      return true;
    }
    if (type !== "function") {
      if (CODEX_PASSTHROUGH_TOOL_TYPES[type]) return true;
      if (!type || tool.function || typeof tool.name === "string") return false;
      return !!CODEX_HOSTED_TOOL_TYPES[type];
    }
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? (tool.function as Any) : null;
    const rawName = typeof tool.name === "string" ? tool.name : typeof fn?.name === "string" ? fn.name : "";
    const name = rawName.trim();
    if (!name) return false;
    const description =
      typeof tool.description === "string"
        ? tool.description
        : typeof fn?.description === "string"
          ? fn.description
          : "";
    const parameters =
      tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters)
        ? tool.parameters
        : fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
          ? fn.parameters
          : { type: "object", properties: {} };
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.slice(0, 128);
    if (description) tool.description = description;
    tool.parameters = parameters;
    validNames.add(name);
    return true;
  });
  // Drop tool_choice if it references an unknown function name
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    const tc = body.tool_choice as Any;
    if (tc.type === "function") {
      const n = typeof tc.name === "string" ? tc.name.trim() : "";
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
}

export function normalizeReasoningEffort(
  value: string,
  supportedLevels?: string[],
): string {
  if (supportedLevels?.includes(value)) return value;
  if (value === "ultra" && supportedLevels?.includes("max")) return "max";
  if (value === "max" || value === "ultra") return "xhigh";
  return value;
}

/**
 * Full Codex upstream normalization. Apply after toResponsesRequest (or to a
 * passthrough Responses body): mutates and returns the same object.
 * Skips model-mapping / session-id / default-instructions executor concerns —
 * this is protocol translation only.
 */
export function normalizeCodexResponsesRequest(body: Any): Any {
  const normalized = normalizeResponsesInput(body.input);
  if (normalized) body.input = normalized;
  if (!body.input || (Array.isArray(body.input) && (body.input as unknown[]).length === 0)) {
    body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
  }

  convertSystemToDeveloperRole(body);
  stripStoredItemReferences(body);
  normalizeCodexTools(body);

  body.stream = true;
  body.store = false;

  // Priority: explicit reasoning.effort > reasoning_effort param > default low
  if (!body.reasoning) {
    const effort = normalizeReasoningEffort(
      typeof body.reasoning_effort === "string" ? body.reasoning_effort : "low",
    );
    body.reasoning = { effort, summary: "auto" };
  } else {
    const r = body.reasoning as Any;
    if (typeof r.effort === "string") {
      r.effort = normalizeReasoningEffort(r.effort);
    }
    if (!r.summary) r.summary = "auto";
  }
  delete body.reasoning_effort;

  if (body.reasoning && typeof body.reasoning === "object" && (body.reasoning as Any).effort && (body.reasoning as Any).effort !== "none") {
    body.include = ["reasoning.encrypted_content"];
  }

  delete body.temperature;
  delete body.top_p;
  delete body.frequency_penalty;
  delete body.presence_penalty;
  delete body.logprobs;
  delete body.top_logprobs;
  delete body.n;
  delete body.seed;
  delete body.max_tokens;
  delete body.max_completion_tokens;
  delete body.max_output_tokens; // Codex rejects this even though Responses API accepts it
  delete body.user;
  delete body.prompt_cache_retention;
  delete body.metadata;
  delete body.stream_options;
  delete body.client_metadata;

  return body;
}
