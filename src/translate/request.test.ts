// Ported/narrowed from 9Router tests: openai-to-claude.test.js,
// openai-to-claude-tools-no-type.test.js, openai-responses-multiturn.test.js,
// codex-tool-normalization.test.js.
// Derived from 9Router (https://github.com/decolua/9router), MIT License,
// Copyright (c) 2024-2026 decolua and contributors.

import { describe, expect, it } from "bun:test";
import {
  fromOpenaiChatRequest,
  fromResponsesRequest,
  toClaudeRequest,
  toResponsesRequest,
  normalizeCodexResponsesRequest,
  normalizeReasoningEffort,
} from "./index.ts";

type Json = Record<string, unknown>;

const chatToClaude = (body: Json) => toClaudeRequest(fromOpenaiChatRequest(body));

function systemText(result: Json): string {
  return ((result.system as Json[]) ?? [])
    .map((s) => (s.type === "text" ? String(s.text) : ""))
    .join("\n");
}

describe("openai→claude request: response_format handling", () => {
  it("injects JSON schema instructions for json_schema type", () => {
    const out = chatToClaude({
      messages: [{ role: "user", content: "What is 2+2?" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "math_response",
          schema: {
            type: "object",
            properties: {
              answer: { type: "number" },
              explanation: { type: "string" },
            },
            required: ["answer", "explanation"],
          },
        },
      },
    });
    expect(Array.isArray(out.system)).toBe(true);
    const text = systemText(out);
    expect(text).toContain("You must respond with valid JSON");
    expect(text).toContain('"answer"');
    expect(text).toContain('"explanation"');
    expect(text).toContain("Respond ONLY with the JSON object");
  });

  it("injects basic JSON instructions for json_object type", () => {
    const out = chatToClaude({
      messages: [{ role: "user", content: "Give me a JSON object" }],
      response_format: { type: "json_object" },
    });
    const text = systemText(out);
    expect(text).toContain("You must respond with valid JSON");
    expect(text).toContain("Respond ONLY with a JSON object");
  });

  it("does not add JSON instructions when response_format is missing", () => {
    const out = chatToClaude({ messages: [{ role: "user", content: "Hello" }] });
    expect(out.system).toBeUndefined();
  });

  it("preserves existing system messages when adding response_format", () => {
    const out = chatToClaude({
      messages: [
        { role: "system", content: "You are a helpful math tutor." },
        { role: "user", content: "What is 2+2?" },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          schema: { type: "object", properties: { result: { type: "number" } } },
        },
      },
    });
    const text = systemText(out);
    expect(text).toContain("You are a helpful math tutor");
    expect(text).toContain("You must respond with valid JSON");
  });
});

describe("openai→claude request: tool_choice handling", () => {
  const baseBody = {
    messages: [{ role: "user", content: "add a todo" }],
    tools: [
      {
        type: "function",
        function: {
          name: "todo_write",
          description: "write todos",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  };

  const choiceOf = (tc: unknown) =>
    chatToClaude({ ...baseBody, tool_choice: tc }).tool_choice;

  it("converts forced tool ({type:'function'}) to {type:'tool'}", () => {
    expect(choiceOf({ type: "function", function: { name: "todo_write" } })).toEqual({
      type: "tool",
      name: "todo_write",
    });
  });

  it("maps string tool_choice values", () => {
    expect(choiceOf("auto")).toEqual({ type: "auto" });
    expect(choiceOf("none")).toEqual({ type: "auto" });
    expect(choiceOf("required")).toEqual({ type: "any" });
  });

  it("passes through Claude-native tool_choice objects unchanged", () => {
    expect(choiceOf({ type: "tool", name: "todo_write" })).toEqual({
      type: "tool",
      name: "todo_write",
    });
    expect(choiceOf({ type: "any" })).toEqual({ type: "any" });
    expect(choiceOf({ type: "none" })).toEqual({ type: "none" });
  });

  it("never leaks an invalid type (falls back to auto)", () => {
    expect(choiceOf({ type: "function", function: {} })).toEqual({ type: "auto" });
    expect(choiceOf({ type: "function" })).toEqual({ type: "auto" });
    expect(choiceOf({ type: "bogus" })).toEqual({ type: "auto" });
  });

  it("omits tool_choice entirely when the request has none", () => {
    expect(chatToClaude(baseBody).tool_choice).toBeUndefined();
  });
});

describe("openai→claude request: tools shape fidelity", () => {
  const baseBody = (extra: Json) => ({
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  });

  it("tool WITH explicit type:'function' is rewritten to Anthropic shape", () => {
    const out = chatToClaude(
      baseBody({
        tools: [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }],
      }),
    ) as Json;
    const tools = out.tools as Json[];
    expect(tools).toHaveLength(1);
    expect(tools[0]).not.toHaveProperty("type");
    expect(tools[0]).not.toHaveProperty("function");
    expect(tools[0]!.name).toBe("echo");
    expect(tools[0]!.input_schema).toEqual({ type: "object" });
  });

  it("tool WITHOUT explicit type but WITH function wrapper preserves the name", () => {
    const out = chatToClaude(
      baseBody({
        tools: [{ function: { name: "echo", parameters: { type: "object" } } }],
      }),
    ) as Json;
    const tools = out.tools as Json[];
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("echo");
    expect(tools[0]!.input_schema).toEqual({ type: "object" });
    expect(tools[0]).not.toHaveProperty("function");
    expect(tools[0]).not.toHaveProperty("type");
  });

  it("flat Anthropic-shape tool is passed through with name preserved", () => {
    const out = chatToClaude(
      baseBody({
        tools: [{ name: "echo", description: "echo input", input_schema: { type: "object" } }],
      }),
    ) as Json;
    const tools = out.tools as Json[];
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("echo");
    expect(tools[0]!.description).toBe("echo input");
    expect(tools[0]!.input_schema).toEqual({ type: "object" });
  });

  it("non-function built-in tool types are passed through", () => {
    const out = chatToClaude(
      baseBody({ tools: [{ type: "web_search_20250305", name: "web_search" }] }),
    ) as Json;
    const tools = out.tools as Json[];
    expect(tools).toHaveLength(1);
    expect(tools[0]!.type).toBe("web_search_20250305");
    expect(tools[0]!.name).toBe("web_search");
  });
});

describe("openai↔responses multi-turn reasoning", () => {
  it("openai→responses re-emits reasoning item with summary + encrypted_content", () => {
    const out = toResponsesRequest(
      fromOpenaiChatRequest({
        model: "grok-4.5",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "hello",
            reasoning_content: "thinking hard about greeting",
            encrypted_content: "enc_blob_turn1",
          },
          { role: "user", content: "next" },
        ],
      }),
    );
    expect(out.store).toBe(false);

    const reasoning = (out.input as Json[]).filter((i) => i.type === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]!.encrypted_content).toBe("enc_blob_turn1");
    expect(
      ((reasoning[0]!.summary as Json[])[0] as Json).text,
    ).toMatch(/thinking hard/);

    // Order: user → reasoning → assistant → user
    const types = (out.input as Json[]).map((i) => i.type || i.role);
    expect(types).toEqual(["message", "reasoning", "message", "message"]);
    expect((out.input as Json[])[0]!.role).toBe("user");
    expect((out.input as Json[])[2]!.role).toBe("assistant");
    expect((out.input as Json[])[3]!.role).toBe("user");
  });

  it("accepts reasoning_encrypted_content alias on assistant messages", () => {
    const out = toResponsesRequest(
      fromOpenaiChatRequest({
        model: "m",
        messages: [
          { role: "assistant", content: "ok", reasoning_encrypted_content: "alt_enc" },
        ],
      }),
    );
    expect(
      (out.input as Json[]).find((i) => i.type === "reasoning")?.encrypted_content,
    ).toBe("alt_enc");
  });

  it("responses→openai attaches reasoning_content + encrypted_content to assistant", () => {
    const normalized = fromResponsesRequest({
      model: "grok-4.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "plan A" }],
          encrypted_content: "enc_xyz",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello" }],
        },
      ],
    });
    const assistant = normalized.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeTruthy();
    expect(assistant!.reasoning_content).toBe("plan A");
    expect(assistant!.encrypted_content).toBe("enc_xyz");
  });

  it("round-trips encrypted_content through openai → responses → openai", () => {
    const original = {
      model: "grok-4.5",
      messages: [
        { role: "user", content: "q1" },
        {
          role: "assistant",
          content: "a1",
          reasoning_content: "r1",
          encrypted_content: "ENC_KEEP_ME",
        },
        { role: "user", content: "q2" },
      ],
    };
    const responses = toResponsesRequest(fromOpenaiChatRequest(structuredClone(original)));
    const back = fromResponsesRequest(responses as Json);
    const again = toResponsesRequest(back);
    const enc = (again.input as Json[]).find((i) => i.type === "reasoning")?.encrypted_content;
    expect(enc).toBe("ENC_KEEP_ME");
  });
});

describe("codex tool normalization", () => {
  it("preserves Responses text.format and deletes metadata", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { title: { type: "string" } },
      required: ["title"],
    };
    const body = {
      model: "gpt-5.4-mini",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "test for session title" }],
        },
      ],
      stream: true,
      metadata: { unsupported: true },
      text: {
        format: {
          type: "json_schema",
          name: "codex_output_schema",
          strict: true,
          schema,
        },
      },
    };
    const out = normalizeCodexResponsesRequest(body as Json);
    expect(out.text).toEqual({
      format: { type: "json_schema", name: "codex_output_schema", strict: true, schema },
    });
    expect(out.metadata).toBeUndefined();
  });

  it("preserves Responses-native tool_search / namespace / plain function tools", () => {
    const body = {
      model: "gpt-5.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "probe" }] },
      ],
      tools: [
        {
          type: "tool_search",
          execution: "sync",
          description: "Discover deferred tools",
          parameters: { type: "object", properties: {} },
        },
        {
          type: "namespace",
          name: "codex_app",
          description: "app tools",
          tools: [
            {
              type: "function",
              name: "automation_update",
              description: "automation",
              parameters: { type: "object", properties: {} },
              defer_loading: true,
            },
          ],
        },
        {
          type: "function",
          name: "plain_fn",
          description: "plain",
          parameters: { type: "object", properties: {} },
        },
      ],
      stream: true,
    };
    const out = normalizeCodexResponsesRequest(body as Json);
    expect((out.tools as Json[]).map((t) => `${t.type}:${t.name ?? ""}`)).toEqual([
      "tool_search:",
      "namespace:codex_app",
      "function:plain_fn",
    ]);
  });

  it("preserves hosted Responses tools", () => {
    const body = {
      model: "gpt-5.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "probe" }] },
      ],
      tools: [
        { type: "web_search", search_context_size: "medium" },
        { type: "image_generation", size: "1024x1024" },
        { type: "mcp", server_label: "docs", server_url: "https://example.com/mcp" },
        { type: "local_shell" },
        { type: "code_interpreter", container: { type: "auto" } },
        { type: "computer", display_width: 1024, display_height: 768, environment: "browser" },
      ],
      stream: true,
    };
    const out = normalizeCodexResponsesRequest(body as Json);
    expect((out.tools as Json[]).map((t) => t.type)).toEqual([
      "web_search",
      "image_generation",
      "mcp",
      "local_shell",
      "code_interpreter",
      "computer",
    ]);
  });

  it("preserves custom freeform tools with format payloads", () => {
    const body = {
      model: "gpt-5.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "probe" }] },
      ],
      tools: [
        {
          type: "custom",
          name: "apply_patch",
          description: "patch",
          format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
        },
      ],
      stream: true,
    };
    const out = normalizeCodexResponsesRequest(body as Json);
    expect(out.tools).toEqual([
      {
        type: "custom",
        name: "apply_patch",
        description: "patch",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
      },
    ]);
  });

  it("flattens chat-shaped nested tools and drops unknown tool_choice", () => {
    const body = {
      model: "gpt-5.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "probe" }] },
      ],
      tools: [
        {
          type: "function",
          function: { name: "nested_fn", description: "d", parameters: { type: "object", properties: { a: { type: "string" } } } },
        },
      ],
      tool_choice: { type: "function", name: "not_declared" },
      stream: true,
    };
    const out = normalizeCodexResponsesRequest(body as Json);
    expect(out.tools).toEqual([
      {
        type: "function",
        name: "nested_fn",
        description: "d",
        parameters: { type: "object", properties: { a: { type: "string" } } },
      },
    ]);
    expect(out.tool_choice).toBeUndefined();
  });

  it("converts system→developer, strips server item IDs, sets stream/store/reasoning", () => {
    const body = {
      model: "gpt-5.5",
      input: [
        { type: "message", role: "system", content: [{ type: "input_text", text: "be brief" }] },
        { id: "rs_123", type: "reasoning", summary: [] },
        { type: "item_reference", id: "fc_9" },
        "msg_abc",
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
      reasoning_effort: "ultra",
    };
    const out = normalizeCodexResponsesRequest(body as Json);
    const input = out.input as Array<Json | string>;
    expect((input[0] as Json).role).toBe("developer");
    expect(input.some((i) => i === "msg_abc")).toBe(false);
    expect(input.some((i) => i && typeof i === "object" && i.type === "item_reference")).toBe(false);
    expect(input.every((i) => !(i && typeof i === "object" && typeof i.id === "string"))).toBe(true);
    expect(out.stream).toBe(true);
    expect(out.store).toBe(false);
    expect((out.reasoning as Json).effort).toBe("xhigh");
    expect(out.include).toEqual(["reasoning.encrypted_content"]);
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.max_output_tokens).toBeUndefined();
  });
});

describe("normalizeReasoningEffort", () => {
  it("keeps supported levels", () => {
    expect(normalizeReasoningEffort("medium", ["low", "medium", "high"])).toBe("medium");
  });
  it("maps ultra→max when max is supported", () => {
    expect(normalizeReasoningEffort("ultra", ["low", "max"])).toBe("max");
  });
  it("falls back max/ultra→xhigh", () => {
    expect(normalizeReasoningEffort("max")).toBe("xhigh");
    expect(normalizeReasoningEffort("ultra")).toBe("xhigh");
  });
  it("passes unknown levels through", () => {
    expect(normalizeReasoningEffort("minimal")).toBe("minimal");
  });
});
