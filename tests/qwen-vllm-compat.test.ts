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
    qwenVllmCompat: {},
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
  test("tool turns strip stop, disable thinking, and force one tool call", () => {
    const adapter = createOpenAIChatAdapter(provider());
    const body = JSON.parse(adapter.buildRequest(parsed(true)).body) as Record<string, unknown>;

    expect(body.stop).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.thinking_budget).toBeUndefined();
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.parallel_tool_calls).toBe(false);
  });

  test("plain text turns are unchanged", () => {
    const adapter = createOpenAIChatAdapter(provider());
    const body = JSON.parse(adapter.buildRequest(parsed(false)).body) as Record<string, unknown>;

    expect(body.stop).toEqual(["<|im_end|>"]);
    expect(body.reasoning_effort).toBe("high");
    expect(body.chat_template_kwargs).toBeUndefined();
    expect(body.parallel_tool_calls).toBeUndefined();
  });

  test("every request adjustment can be disabled independently", () => {
    const p = provider({
      qwenVllmCompat: {
        stripStopOnToolTurns: false,
        disableThinkingOnToolTurns: false,
        forceSingleToolCall: false,
      },
    });
    const body: Record<string, unknown> = {
      stop: ["END"],
      reasoning_effort: "medium",
      parallel_tool_calls: true,
    };

    expect(applyQwenVllmRequestCompat(body, p, true)).toEqual({ enabled: true, thinkingDisabled: false });
    expect(body.stop).toEqual(["END"]);
    expect(body.reasoning_effort).toBe("medium");
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
