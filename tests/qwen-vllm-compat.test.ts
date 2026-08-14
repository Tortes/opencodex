import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import {
  applyQwenVllmRequestCompat,
  normalizeQwenVllmToolArguments,
} from "../src/adapters/qwen-vllm-compat";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "http://127.0.0.1:8000/v1",
    authMode: "local",
    qwenVllmCompat: { disableThinkingOnToolTurns: false },
    ...overrides,
  };
}

function parsed(withTools = true): OcxParsedRequest {
  return {
    modelId: "Qwen3.6-27B",
    context: {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
      ...(withTools ? {
        tools: [{
          name: "shell",
          description: "Run a command",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        }],
      } : {}),
    },
    stream: true,
    options: {
      stopSequences: ["<|im_end|>"],
      reasoning: "high",
      parallelToolCalls: true,
    },
  };
}

describe("Qwen-vLLM request compatibility", () => {
  test("agent-thinking tool turns preserve thinking and force one tool call", () => {
    const adapter = createOpenAIChatAdapter(provider());
    const body = JSON.parse(adapter.buildRequest(parsed(true)).body) as Record<string, unknown>;

    expect(body.stop).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.thinking_budget).toBeUndefined();
    expect(body.chat_template_kwargs).toEqual({
      enable_thinking: true,
      preserve_thinking: true,
    });
    expect(body.parallel_tool_calls).toBe(false);
  });

  test("agent-thinking applies Qwen chat-template flags on plain text turns too", () => {
    const adapter = createOpenAIChatAdapter(provider());
    const body = JSON.parse(adapter.buildRequest(parsed(false)).body) as Record<string, unknown>;

    expect(body.stop).toEqual(["<|im_end|>"]);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.chat_template_kwargs).toEqual({
      enable_thinking: true,
      preserve_thinking: true,
    });
    expect(body.parallel_tool_calls).toBeUndefined();
  });

  test("legacy empty profile still disables thinking only on tool turns", () => {
    const adapter = createOpenAIChatAdapter(provider({ qwenVllmCompat: {} }));
    const toolBody = JSON.parse(adapter.buildRequest(parsed(true)).body) as Record<string, unknown>;
    const textBody = JSON.parse(adapter.buildRequest(parsed(false)).body) as Record<string, unknown>;

    expect(toolBody.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(toolBody.reasoning_effort).toBeUndefined();
    expect(textBody.chat_template_kwargs).toBeUndefined();
    expect(textBody.reasoning_effort).toBe("high");
  });

  test("agent-thinking auto-registers the routed model for later reasoning replay", () => {
    const p = provider();
    const adapter = createOpenAIChatAdapter(p);
    adapter.buildRequest(parsed(true));

    expect(p.preserveReasoningContentModels).toContain("Qwen3.6-27B");

    const next = parsed(true);
    next.context.messages = [
      {
        role: "assistant",
        timestamp: 1,
        content: [
          { type: "thinking", thinking: "inspect the repository first" },
          { type: "toolCall", id: "call_1", name: "shell", arguments: { command: "pwd" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "shell",
        content: "/tmp/project",
        isError: false,
        timestamp: 2,
      },
    ];

    const body = JSON.parse(adapter.buildRequest(next).body) as { messages: Array<Record<string, unknown>> };
    const assistant = body.messages.find(message => message.role === "assistant");
    expect(assistant?.reasoning_content).toBe("inspect the repository first");
  });

  test("every legacy request adjustment can still be disabled independently", () => {
    const p = provider({
      qwenVllmCompat: {
        stripStopOnToolTurns: false,
        disableThinkingOnToolTurns: false,
        forceSingleToolCall: false,
      },
    });
    const body: Record<string, unknown> = {
      model: "Qwen3.6-27B",
      stop: ["END"],
      reasoning_effort: "medium",
      parallel_tool_calls: true,
    };

    expect(applyQwenVllmRequestCompat(body, p, true)).toEqual({ enabled: true, thinkingDisabled: false });
    expect(body.stop).toEqual(["END"]);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: true });
    expect(body.parallel_tool_calls).toBe(true);
  });
});

describe("Qwen-vLLM tool argument validation", () => {
  test("accepts and canonicalizes an object", () => {
    expect(normalizeQwenVllmToolArguments(' { "command": "pwd" } ', provider()))
      .toEqual({ ok: true, arguments: '{"command":"pwd"}' });
  });

  test("normalizes an empty no-arg call", () => {
    expect(normalizeQwenVllmToolArguments("", provider()))
      .toEqual({ ok: true, arguments: "{}" });
  });

  test("rejects truncated JSON, arrays, and primitives", () => {
    expect(normalizeQwenVllmToolArguments("{", provider())).toEqual({ ok: false });
    expect(normalizeQwenVllmToolArguments("[]", provider())).toEqual({ ok: false });
    expect(normalizeQwenVllmToolArguments('"text"', provider())).toEqual({ ok: false });
  });

  test("preserves legacy behavior when validation is disabled", () => {
    expect(normalizeQwenVllmToolArguments("{", provider({
      qwenVllmCompat: { validateToolArguments: false },
    }))).toEqual({ ok: true, arguments: "{" });
  });
});
