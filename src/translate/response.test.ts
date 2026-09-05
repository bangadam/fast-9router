// Streaming + non-streaming response translation tests.
// Ported/narrowed from 9Router tests: openai-responses-terminal-event.test.js,
// openai-responses-empty-toolcalls.test.js, openai-responses-nonstream.test.js,
// openai-to-claude-response-tools.test.js.
// Derived from 9Router (https://github.com/decolua/9router), MIT License,
// Copyright (c) 2024-2026 decolua and contributors.

import {
  fromClaudeRequest,
  fromOpenaiChatRequest,
  fromResponsesRequest,
  toClaudeRequest,
  toOpenaiChatRequest,
  toResponsesRequest,
  translateResponse,
  extractUsage,
} from "./index.ts";
import { makeEventStream } from "./sse.ts";

import { describe, expect, it } from "bun:test";
import {
  aggregateStreamChatChunks,
  chatChunkSse,
  claudeEventSse,
  parseSseJson,
  responsesEventSse,
  runStream,
} from "./testHelpers.ts";

type Json = Record<string, unknown>;

const CHAT_TOOL_BODY = {
  id: "chatcmpl-abc123",
  object: "chat.completion",
  created: 1700000000,
  model: "cl/",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "shell", arguments: '{"cmd":"ls"}' },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

describe("usage extraction", () => {
  it("keeps direct Responses usage support", () => {
    expect(extractUsage(
      { usage: { input_tokens: 7, output_tokens: 4 } },
      "openai-responses",
    )).toEqual({ promptTokens: 7, completionTokens: 4 });
  });
});

describe("SSE UTF-8 decoder isolation", () => {
  it("keeps interleaved streams from sharing partial multibyte state", async () => {
    const encoder = new TextEncoder();
    const frameA = encoder.encode('data: {"text":"🙂"}\n\n');
    const frameB = encoder.encode('data: {"text":"界"}\n\n');
    const splitA = encoder.encode('data: {"text":"').byteLength + 2;
    const eventsA: string[] = [];
    const eventsB: string[] = [];
    const streamA = makeEventStream((event) => eventsA.push(event.data), () => {});
    const streamB = makeEventStream((event) => eventsB.push(event.data), () => {});
    const drainA = new Response(streamA.transform.readable).arrayBuffer();
    const drainB = new Response(streamB.transform.readable).arrayBuffer();
    const writerA = streamA.transform.writable.getWriter();
    const writerB = streamB.transform.writable.getWriter();

    await writerA.write(frameA.subarray(0, splitA));
    await writerB.write(frameB);
    await writerA.write(frameA.subarray(splitA));
    await writerA.close();
    await writerB.close();
    await Promise.all([drainA, drainB]);

    expect(eventsA).toEqual(['{"text":"🙂"}']);
    expect(eventsB).toEqual(['{"text":"界"}']);
  });

  it("decodes a split multibyte character within one stream", async () => {
    const encoder = new TextEncoder();
    const frame = encoder.encode('data: {"text":"🙂"}\n\n');
    const split = encoder.encode('data: {"text":"').byteLength + 1;
    const events: string[] = [];
    const stream = makeEventStream((event) => events.push(event.data), () => {});
    const drain = new Response(stream.transform.readable).arrayBuffer();
    const writer = stream.transform.writable.getWriter();

    await writer.write(frame.subarray(0, split));
    await writer.write(frame.subarray(split));
    await writer.close();
    await drain;

    expect(events).toEqual(['{"text":"🙂"}']);
  });
});

describe("non-stream chat upstream → Responses client", () => {
  it("translates chat.completion tool_calls into Responses function_call output", () => {
    const out = translateResponse(CHAT_TOOL_BODY, "openai", "openai-responses") as Json;
    expect(out.object).toBe("response");
    expect(out).not.toHaveProperty("choices");
    const fc = (out.output as Json[]).find((o) => o.type === "function_call");
    expect(fc).toBeTruthy();
    expect(fc!.call_id).toBe("call_1");
    expect(fc!.name).toBe("shell");
    expect(fc!.arguments).toBe('{"cmd":"ls"}');
  });

  it("translates marked Chat tools into Responses custom_tool_call output", () => {
    const customBody = structuredClone(CHAT_TOOL_BODY);
    ((customBody.choices as Json[])[0]!.message as Json).tool_calls = [
      {
        id: "call_exec",
        type: "function",
        function: {
          name: "exec",
          arguments: '{"input":"return await tools.shell({command: \'pwd\'});"}',
        },
      },
    ];
    const out = translateResponse(customBody, "openai", "openai-responses", {
      customToolNames: new Set(["exec"]),
    }) as Json;
    const call = (out.output as Json[]).find((item) => item.type === "custom_tool_call");
    expect(call).toMatchObject({
      call_id: "call_exec",
      name: "exec",
      input: "return await tools.shell({command: 'pwd'});",
    });
    expect((out.output as Json[]).some((item) => item.type === "function_call")).toBe(false);
  });

  it("keeps chat.completion text content as a Responses message item", () => {
    const body = {
      ...CHAT_TOOL_BODY,
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    };
    const out = translateResponse(body, "openai", "openai-responses") as Json;
    const msg = (out.output as Json[]).find((o) => o.type === "message");
    expect(msg).toBeTruthy();
    const content = msg!.content as Json[];
    expect(content[0]!.type).toBe("output_text");
    expect(content[0]!.text).toBe("hello");
  });

  it("leaves chat→chat untouched", () => {
    const out = translateResponse(CHAT_TOOL_BODY, "openai", "openai") as Json;
    expect(out.object).toBe("chat.completion");
    const tc = ((out.choices as Json[])[0]!.message as Json).tool_calls as Json[];
    expect(tc[0]!.function).toMatchObject({ name: "shell" });
  });

  it("translates claude body → chat body with tool_calls and reasoning", () => {
    const claudeBody = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-x",
      content: [
        { type: "thinking", thinking: "pondering" },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "toolu_1", name: "shell", input: { cmd: "ls" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 7, output_tokens: 3 },
    };
    const out = translateResponse(claudeBody, "claude", "openai") as Json;
    const message = (out.choices as Json[])[0]!.message as Json;
    expect(message.content).toBe("answer");
    expect(message.reasoning_content).toBe("pondering");
    const tc = message.tool_calls as Json[];
    expect(tc[0]).toMatchObject({
      id: "toolu_1",
      type: "function",
      function: { name: "shell", arguments: '{"cmd":"ls"}' },
    });
    expect((out.choices as Json[])[0]!.finish_reason).toBe("tool_calls");
    expect(out.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  });

  it("translates responses body → chat body", () => {
    const responsesBody = {
      id: "resp_1",
      object: "response",
      created_at: 1700000000,
      model: "gpt-x",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "hmm" }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hi", annotations: [] }],
        },
        { type: "function_call", call_id: "call_2", name: "shell", arguments: '{"cmd":"ls"}' },
      ],
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    };
    const out = translateResponse(responsesBody, "openai-responses", "openai") as Json;
    const message = (out.choices as Json[])[0]!.message as Json;
    expect(message.content).toBe("hi");
    expect(message.reasoning_content).toBe("hmm");
    const tc = message.tool_calls as Json[];
    expect(tc[0]).toMatchObject({ id: "call_2", function: { name: "shell" } });
    expect((out.choices as Json[])[0]!.finish_reason).toBe("tool_calls");
    expect(out.usage).toMatchObject({ prompt_tokens: 4, completion_tokens: 2 });
  });
});

describe("forced-SSE JSON path: chat SSE → Responses client (stream + aggregate)", () => {
  const RAW = [
    chatChunkSse({
      id: "chatcmpl-sse",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "gpt-x",
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_9", type: "function", function: { name: "shell", arguments: "" } },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    chatChunkSse({
      id: "chatcmpl-sse",
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":"pwd"}' } }] },
          finish_reason: null,
        },
      ],
    }),
    chatChunkSse({
      id: "chatcmpl-sse",
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    }),
    "data: [DONE]\n\n",
  ].join("");

  it("parses chat SSE chunks into a Responses function_call body", async () => {
    const text = await runStream("openai", "openai-responses", RAW);
    const events = parseSseJson(text);
    expect(events.find((e) => e.data.type === "response.completed")).toBeTruthy();
    const added = events.filter(
      (e) => e.data.type === "response.output_item.added" && (e.data.item as Json)?.type === "function_call",
    );
    expect(added).toHaveLength(1);
    expect((added[0]!.data.item as Json).call_id).toBe("call_9");
    const argsDone = events.find((e) => e.data.type === "response.function_call_arguments.done");
    expect((argsDone!.data as Json).arguments).toBe('{"cmd":"pwd"}');
    expect(text).toContain("data: [DONE]");
    expect((text.match(/data: \[DONE\]/g) ?? []).length).toBe(1);
  });

  it("returns a custom_tool_call for a marked tool", async () => {
    const text = await runStream("openai", "openai-responses", RAW, {
      customToolNames: new Set(["shell"]),
    });
    const events = parseSseJson(text);
    const added = events.find(
      (e) => e.data.type === "response.output_item.added" && (e.data.item as Json)?.type === "custom_tool_call",
    );
    expect(added).toBeTruthy();
    expect((added!.data.item as Json).call_id).toBe("call_9");
    const inputDone = events.find((e) => e.data.type === "response.custom_tool_call_input.done");
    expect((inputDone!.data as Json).input).toBe('{"cmd":"pwd"}');
  });

  it("still returns chat chunks for a plain chat client", async () => {
    const text = await runStream("openai", "openai", RAW);
    const body = aggregateStreamChatChunks(text);
    expect(body.object).toBe("chat.completion");
    const tc = (((body.choices as Json[])[0]!.message as Json).tool_calls as Json[])[0]!;
    expect(tc.function).toMatchObject({ name: "shell", arguments: '{"cmd":"pwd"}' });
  });
});

describe("terminal-event wrapper for responses clients", () => {
  it("emits response.failed before [DONE] when the stream closes before a terminal event", async () => {
    const text = await runStream("claude", "openai-responses", [
      claudeEventSse({ type: "message_start", message: { id: "msg_t", model: "m" } }),
      claudeEventSse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      claudeEventSse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }),
    ].join(""));
    expect(text).toContain("event: response.failed");
    expect(text).toContain('"type":"response.failed"');
    expect(text).not.toContain("data: null");
    expect(text).toContain("data: [DONE]");
    expect(text.indexOf("event: response.failed")).toBeLessThan(text.indexOf("data: [DONE]"));
    expect((text.match(/data: \[DONE\]/g) ?? []).length).toBe(1);
  });

  it("does not add response.failed when the stream already completed", async () => {
    const text = await runStream("claude", "openai-responses", [
      claudeEventSse({ type: "message_start", message: { id: "msg_t", model: "m" } }),
      claudeEventSse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      claudeEventSse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
      claudeEventSse({ type: "content_block_stop", index: 0 }),
      claudeEventSse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
      claudeEventSse({ type: "message_stop" }),
    ].join(""));
    expect(text).toContain("response.completed");
    expect(text).not.toContain("response.failed");
    expect(text).not.toContain("data: null");
    expect(text).toContain("data: [DONE]");
    expect((text.match(/data: \[DONE\]/g) ?? []).length).toBe(1);
  });

  it("emits response.failed before [DONE] when upstream ends abruptly without message_stop", async () => {
    const text = await runStream("claude", "openai-responses", [
      claudeEventSse({ type: "message_start", message: { id: "msg_t", model: "m" } }),
    ].join(""));
    expect(text).toContain("event: response.failed");
    expect(text.indexOf("event: response.failed")).toBeLessThan(text.indexOf("data: [DONE]"));
  });
});

describe("chat → responses: empty tool_calls arrays", () => {
  const chunks = (deltas: Json[], finish: string | null) =>
    deltas
      .map((delta, i) =>
        chatChunkSse({
          id: "cmb-test",
          choices: [
            { index: 0, delta, finish_reason: i === deltas.length - 1 ? finish : null },
          ],
        }),
      )
      .join("");

  it("does not emit output_text.done early when every chunk carries tool_calls: []", async () => {
    const text = await runStream(
      "openai",
      "openai-responses",
      chunks(
        [
          { role: "assistant", content: "", reasoning_content: "", tool_calls: [] },
          { content: "", reasoning_content: "thinking", tool_calls: [] },
          { content: "cod", reasoning_content: "", tool_calls: [] },
          { content: "ex", reasoning_content: "", tool_calls: [] },
          { content: "-ok", reasoning_content: "", tool_calls: [] },
          { content: "", reasoning_content: "", tool_calls: [] },
        ],
        "stop",
      ),
    );
    const events = parseSseJson(text);
    const textDone = events.filter((e) => e.data.type === "response.output_text.done");
    const textDeltas = events.filter((e) => e.data.type === "response.output_text.delta");
    expect(textDone).toHaveLength(1);
    expect((textDone[0]!.data as Json).text).toBe("codex-ok");
    expect(textDeltas.map((e) => (e.data as Json).delta).join("")).toBe("codex-ok");
    expect(events.indexOf(textDone[0]!)).toBe(
      events.indexOf(textDeltas[textDeltas.length - 1]!) + 1,
    );
  });

  it("still closes the message before a real tool call", async () => {
    const text = await runStream(
      "openai",
      "openai-responses",
      chunks(
        [
          { content: "Let me run that.", tool_calls: [] },
          {
            tool_calls: [
              { index: 0, id: "call_1", type: "function", function: { name: "exec", arguments: "" } },
            ],
          },
          {},
        ],
        "tool_calls",
      ),
    );
    const events = parseSseJson(text);
    const added = events.find(
      (e) => e.data.type === "response.output_item.added" && (e.data.item as Json)?.type === "function_call",
    );
    const textDone = events.find((e) => e.data.type === "response.output_text.done");
    expect(added).toBeTruthy();
    expect((textDone!.data as Json).text).toBe("Let me run that.");
  });
});

describe("chat → claude streaming: tool argument fidelity", () => {
  it("preserves tool id/name/input and emits a single input_json_delta", async () => {
    const text = await runStream(
      "openai",
      "claude",
      [
        chatChunkSse({
          id: "chatcmpl-test",
          model: "test-model",
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_read", type: "function", function: { name: "Read", arguments: "" } },
                ],
              },
            },
          ],
        }),
        chatChunkSse({
          id: "chatcmpl-test",
          model: "test-model",
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: JSON.stringify({ file_path: "/tmp/example.txt", offset: 0, limit: 120 }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      ].join(""),
    );
    const events = parseSseJson(text);
    const start = events.find(
      (e) => e.data.type === "content_block_start" && (e.data.content_block as Json)?.type === "tool_use",
    );
    expect(start).toBeTruthy();
    const block = start!.data.content_block as Json;
    expect(block.id).toBe("call_read");
    expect(block.name).toBe("Read");
    const inputDeltas = events.filter(
      (e) => e.data.type === "content_block_delta" && (e.data.delta as Json)?.type === "input_json_delta",
    );
    expect(inputDeltas).toHaveLength(1);
    expect(JSON.parse((inputDeltas[0]!.data.delta as Json).partial_json as string)).toEqual({
      file_path: "/tmp/example.txt",
      offset: 0,
      limit: 120,
    });
    const messageDelta = events.find((e) => e.data.type === "message_delta");
    expect((messageDelta!.data.delta as Json).stop_reason).toBe("tool_use");
    expect(events.some((e) => e.data.type === "message_stop")).toBe(true);
  });
});

describe("responses → chat streaming", () => {
  it("maps text deltas, tool calls, reasoning, usage, and terminal to chat chunks", async () => {
    const text = await runStream(
      "openai-responses",
      "openai",
      [
        responsesEventSse("response.created", { type: "response.created", response: { id: "resp_1" } }),
        responsesEventSse("response.reasoning_summary_text.delta", {
          type: "response.reasoning_summary_text.delta",
          delta: "thinking ",
        }),
        responsesEventSse("response.reasoning_summary_text.delta", {
          type: "response.reasoning_summary_text.delta",
          delta: "hard",
        }),
        responsesEventSse("response.output_text.delta", { type: "response.output_text.delta", delta: "Hel" }),
        responsesEventSse("response.output_text.delta", { type: "response.output_text.delta", delta: "lo" }),
        responsesEventSse("response.output_item.added", {
          type: "response.output_item.added",
          item: { type: "function_call", call_id: "call_a", name: "shell", arguments: "" },
        }),
        responsesEventSse("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          delta: '{"cmd"',
        }),
        responsesEventSse("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          delta: ':"ls"}',
        }),
        responsesEventSse("response.output_item.done", {
          type: "response.output_item.done",
          item: { type: "function_call", call_id: "call_a" },
        }),
        responsesEventSse("response.completed", {
          type: "response.completed",
          response: {
            usage: { input_tokens: 3, output_tokens: 4, input_tokens_details: { cached_tokens: 1 } },
          },
        }),
        "data: [DONE]\n\n",
      ].join(""),
    );
    const body = aggregateStreamChatChunks(text);
    const message = (body.choices as Json[])[0]!.message as Json;
    expect(message.content).toBe("Hello");
    expect(message.reasoning_content).toBe("thinking hard");
    const tc = (message.tool_calls as Json[])[0]!;
    expect(tc.id).toBe("call_a");
    expect(tc.function).toMatchObject({ name: "shell", arguments: '{"cmd":"ls"}' });
    expect((body.choices as Json[])[0]!.finish_reason).toBe("tool_calls");
    expect(body.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
      prompt_tokens_details: { cached_tokens: 1 },
    });
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("aggregates a plain text stream with finish_reason stop", async () => {
    const text = await runStream(
      "openai-responses",
      "openai",
      [
        responsesEventSse("response.output_text.delta", { type: "response.output_text.delta", delta: "a" }),
        responsesEventSse("response.output_text.delta", { type: "response.output_text.delta", delta: "b" }),
        responsesEventSse("response.completed", { type: "response.completed", response: {} }),
        "data: [DONE]\n\n",
      ].join(""),
    );
    const body = aggregateStreamChatChunks(text);
    expect(((body.choices as Json[])[0]!.message as Json).content).toBe("ab");
    expect((body.choices as Json[])[0]!.finish_reason).toBe("stop");
  });
});

describe("responses → claude streaming", () => {
  it("maps text + reasoning + tool call + terminal to claude events", async () => {
    const text = await runStream(
      "openai-responses",
      "claude",
      [
        responsesEventSse("response.output_text.delta", { type: "response.output_text.delta", delta: "Hi" }),
        responsesEventSse("response.reasoning_summary_text.delta", {
          type: "response.reasoning_summary_text.delta",
          delta: "thinking",
        }),
        responsesEventSse("response.output_item.added", {
          type: "response.output_item.added",
          item: { type: "function_call", call_id: "call_b", name: "shell", arguments: "" },
        }),
        responsesEventSse("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          delta: '{"x":1}',
        }),
        responsesEventSse("response.output_item.done", {
          type: "response.output_item.done",
          item: { type: "function_call", call_id: "call_b" },
        }),
        responsesEventSse("response.completed", {
          type: "response.completed",
          response: { usage: { input_tokens: 5, output_tokens: 6 } },
        }),
      ].join(""),
    );
    const events = parseSseJson(text);
    expect(events.some((e) => e.data.type === "message_start")).toBe(true);
    expect(
      events.some((e) => (e.data.delta as Json | undefined)?.type === "text_delta"),
    ).toBe(true);
    expect(
      events.some((e) => (e.data.delta as Json | undefined)?.type === "thinking_delta"),
    ).toBe(true);
    const toolStart = events.find(
      (e) => e.data.type === "content_block_start" && (e.data.content_block as Json)?.type === "tool_use",
    );
    expect((toolStart!.data.content_block as Json).id).toBe("call_b");
    const inputDeltas = events.filter(
      (e) => e.data.type === "content_block_delta" && (e.data.delta as Json)?.type === "input_json_delta",
    );
    expect((inputDeltas[0]!.data.delta as Json).partial_json).toBe('{"x":1}');
    const messageDelta = events.find((e) => e.data.type === "message_delta");
    expect((messageDelta!.data.delta as Json).stop_reason).toBe("tool_use");
    expect(events.some((e) => e.data.type === "message_stop")).toBe(true);
  });
});

describe("claude → chat streaming", () => {
  it("maps thinking tags, text, tool args, and usage to chat chunks", async () => {
    const text = await runStream(
      "claude",
      "openai",
      [
        claudeEventSse({
          type: "message_start",
          message: {
            id: "msg_9",
            model: "claude-4",
            usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 },
          },
        }),
        claudeEventSse({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
        claudeEventSse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "deep" } }),
        claudeEventSse({ type: "content_block_stop", index: 0 }),
        claudeEventSse({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
        claudeEventSse({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } }),
        claudeEventSse({ type: "content_block_stop", index: 1 }),
        claudeEventSse({
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use", id: "toolu_2", name: "shell", input: {} },
        }),
        claudeEventSse({
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '{"cmd":"ls"}' },
        }),
        claudeEventSse({ type: "content_block_stop", index: 2 }),
        claudeEventSse({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 6 } }),
        claudeEventSse({ type: "message_stop" }),
      ].join(""),
    );
    const body = aggregateStreamChatChunks(text);
    const message = (body.choices as Json[])[0]!.message as Json;
    expect(message.reasoning_content).toBe("deep");
    // <think> wrapper markers are part of the chat-side thinking convention.
    expect(message.content).toContain("Hi");
    expect(message.content).toContain("<think>");
    expect(message.content).toContain("</think>");
    const tc = (message.tool_calls as Json[])[0]!;
    expect(tc.id).toBe("toolu_2");
    expect(tc.function).toMatchObject({ name: "shell", arguments: '{"cmd":"ls"}' });
    expect((body.choices as Json[])[0]!.finish_reason).toBe("tool_calls");
    // prompt = input + cache_read + cache_creation = 10 + 4 + 1
    expect(body.usage).toEqual({
      prompt_tokens: 15,
      completion_tokens: 6,
      total_tokens: 21,
      prompt_tokens_details: { cached_tokens: 4, cache_creation_tokens: 1 },
    });
  });

  it("falls back to a terminal chunk when message_stop is missing", async () => {
    const text = await runStream("claude", "openai", [
      claudeEventSse({ type: "message_start", message: { id: "msg_z", model: "m" } }),
      claudeEventSse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      claudeEventSse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }),
    ].join(""));
    const body = aggregateStreamChatChunks(text);
    expect((body.choices as Json[])[0]!.finish_reason).toBe("stop");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});

describe("parallel tool calls", () => {
  it("keeps ids and args distinct across two interleaved tool calls", async () => {
    const text = await runStream(
      "openai",
      "openai-responses",
      [
        chatChunkSse({
          id: "c1",
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_x", type: "function", function: { name: "alpha", arguments: "" } },
                  { index: 1, id: "call_y", type: "function", function: { name: "beta", arguments: "" } },
                ],
              },
            },
          ],
        }),
        chatChunkSse({
          id: "c1",
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '{"a":' } },
                  { index: 1, function: { arguments: '{"b":' } },
                ],
              },
            },
          ],
        }),
        chatChunkSse({
          id: "c1",
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: "1}" } },
                  { index: 1, function: { arguments: "2}" } },
                ],
              },
            },
          ],
        }),
        chatChunkSse({ id: "c1", choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        "data: [DONE]\n\n",
      ].join(""),
    );
    const events = parseSseJson(text);
    const added = events.filter(
      (e) => e.data.type === "response.output_item.added" && (e.data.item as Json)?.type === "function_call",
    );
    expect(added).toHaveLength(2);
    expect((added[0]!.data.item as Json).call_id).toBe("call_x");
    expect((added[1]!.data.item as Json).call_id).toBe("call_y");
    const argsDone = events.filter((e) => e.data.type === "response.function_call_arguments.done");
    expect(argsDone).toHaveLength(2);
    expect((argsDone[0]!.data as Json).arguments).toBe('{"a":1}');
    expect((argsDone[1]!.data as Json).arguments).toBe('{"b":2}');
  });
});

describe("image input passthrough", () => {
  it("openai→responses converts image_url parts to input_image", () => {
    const out = toResponsesRequest(
      fromOpenaiChatRequest({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image_url", image_url: { url: "https://x/img.png", detail: "high" } },
            ],
          },
        ],
      }),
    );
    const content = (out.input as Json[])[0]!.content as Json[];
    expect(content[0]).toEqual({ type: "input_text", text: "look" });
    expect(content[1]).toEqual({ type: "input_image", image_url: "https://x/img.png", detail: "high" });
  });

  it("openai→claude converts http urls to url sources and data URIs to base64", () => {
    const out = toClaudeRequest(
      fromOpenaiChatRequest({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "https://x/img.png" } },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ],
      }),
    ) as Json;
    const blocks = ((out.messages as Json[])[0]!.content as Json[]).filter(
      (b) => b.type === "image",
    );
    expect(blocks[0]!.source).toEqual({ type: "url", url: "https://x/img.png" });
    expect(blocks[1]!.source).toEqual({ type: "base64", media_type: "image/png", data: "AAAA" });
  });
});

describe("system / developer instruction semantics", () => {
  it("chat→responses hoists the first system/developer message to instructions", () => {
    const out = toResponsesRequest(
      fromOpenaiChatRequest({
        model: "m",
        messages: [
          { role: "system", content: "be terse" },
          { role: "developer", content: "also terse" },
          { role: "user", content: "hi" },
        ],
      }),
    );
    expect(out.instructions).toBe("be terse");
    expect((out.input as Json[]).every((i) => i.role !== "system")).toBe(true);
  });

  it("responses→chat turns instructions into a leading system message", () => {
    const out = toOpenaiChatRequest(
      fromResponsesRequest({
        model: "m",
        instructions: "be terse",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      }),
    );
    const messages = out.messages as Json[];
    expect(messages[0]).toEqual({ role: "system", content: "be terse" });
    expect(messages[1]!.role).toBe("user");
  });
});

describe("tool call id preservation round-trip", () => {
  it("responses→chat→responses preserves call_id through the internal form", () => {
    const start = {
      model: "m",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "function_call", call_id: "call_preserve_me", name: "shell", arguments: '{"cmd":"ls"}' },
        { type: "function_call_output", call_id: "call_preserve_me", output: "files" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "again" }] },
      ],
    };
    const chat = toOpenaiChatRequest(fromResponsesRequest(start as Json));
    const back = toResponsesRequest(fromOpenaiChatRequest(chat));
    const input = back.input as Json[];
    const fc = input.find((i) => i.type === "function_call") as Json;
    const fco = input.find((i) => i.type === "function_call_output") as Json;
    expect(fc.call_id).toBe("call_preserve_me");
    expect(fc.arguments).toBe('{"cmd":"ls"}');
    expect(fco.call_id).toBe("call_preserve_me");
    expect(fco.output).toBe("files");
  });
});

describe("claude request round-trip: tool_use ids and tool results", () => {
  it("preserves tool ids through claude→internal→claude", () => {
    const out = toClaudeRequest(
      fromClaudeRequest({
        model: "claude-x",
        max_tokens: 100,
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_p", name: "shell", input: { cmd: "ls" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_p", content: "files" }],
          },
        ],
        tools: [{ name: "shell", description: "run", input_schema: { type: "object", properties: {} } }],
      }),
    ) as Json;
    const messages = out.messages as Json[];
    const assistant = messages.find((m) => m.role === "assistant")!;
    const toolUse = (assistant.content as Json[]).find((b) => b.type === "tool_use") as Json;
    expect(toolUse.id).toBe("toolu_p");
    expect(toolUse.input).toEqual({ cmd: "ls" });
    // tool_result lands in its own user message immediately after tool_use
    const resultMsg = messages[messages.indexOf(assistant) + 1]!;
    expect(resultMsg.role).toBe("user");
    const toolResult = (resultMsg.content as Json[])[0] as Json;
    expect(toolResult.tool_use_id).toBe("toolu_p");
    expect(toolResult.content).toBe("files");
  });
});
