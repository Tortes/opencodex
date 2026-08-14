import type { OcxProviderConfig } from "../types";

export interface QwenVllmRequestCompatResult {
  enabled: boolean;
  thinkingDisabled: boolean;
}

export type QwenVllmToolArgumentsResult =
  | { ok: true; arguments: string }
  | { ok: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compatConfig(provider: OcxProviderConfig) {
  const config = provider.qwenVllmCompat;
  return config && config.enabled !== false ? config : undefined;
}

function registerReasoningReplayModel(provider: OcxProviderConfig, body: Record<string, unknown>): void {
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) return;
  const existing = provider.preserveReasoningContentModels ?? [];
  if (!existing.includes(model)) {
    // The openai-chat history serializer consults this list before the next turn.
    // Register the actually-routed Qwen model after the first request so new sessions
    // automatically replay reasoning_content even when the operator omitted the list.
    // Operators should still configure preserveReasoningContentModels explicitly when
    // resumed sessions must be correct on their very first request after process start.
    provider.preserveReasoningContentModels = [...existing, model];
  }
}

function clearConflictingReasoningControls(body: Record<string, unknown>): void {
  delete body.reasoning;
  delete body.reasoning_effort;
  delete body.reasoning_split;
  delete body.thinking;
  delete body.thinking_budget;
}

/**
 * Apply compatibility adjustments that are useful for Qwen chat templates served by vLLM.
 * The profile is explicit and provider-local: no other OpenAI-compatible provider changes.
 *
 * Two modes intentionally coexist:
 * - legacy safe mode (default): tool turns disable Qwen thinking, matching the original preview;
 * - agent thinking mode (`disableThinkingOnToolTurns: false`): every request uses the Qwen
 *   chat-template controls with `enable_thinking=true` and `preserve_thinking=true`, while
 *   OpenCodex replays prior assistant thinking as `reasoning_content` on later turns.
 */
export function applyQwenVllmRequestCompat(
  body: Record<string, unknown>,
  provider: OcxProviderConfig,
  hasTools: boolean,
): QwenVllmRequestCompatResult {
  const config = compatConfig(provider);
  if (!config) return { enabled: false, thinkingDisabled: false };

  const agentThinking = config.disableThinkingOnToolTurns === false;

  if (hasTools && config.stripStopOnToolTurns !== false) {
    delete body.stop;
    delete body.stop_token_ids;
  }

  let thinkingDisabled = false;
  if (agentThinking) {
    const existing = isRecord(body.chat_template_kwargs) ? body.chat_template_kwargs : {};
    body.chat_template_kwargs = {
      ...existing,
      enable_thinking: true,
      preserve_thinking: true,
    };
    clearConflictingReasoningControls(body);
    registerReasoningReplayModel(provider, body);
  } else if (hasTools) {
    const existing = isRecord(body.chat_template_kwargs) ? body.chat_template_kwargs : {};
    body.chat_template_kwargs = { ...existing, enable_thinking: false };
    clearConflictingReasoningControls(body);
    thinkingDisabled = true;
  }

  if (hasTools && config.forceSingleToolCall !== false) {
    body.parallel_tool_calls = false;
  }

  return { enabled: true, thinkingDisabled };
}

/**
 * Validate and normalize a completed function-call argument buffer.
 *
 * Empty calls become `{}`. Non-empty values must be JSON objects; arrays, primitives,
 * and truncated JSON fail closed so Codex never executes a fabricated empty call.
 */
export function normalizeQwenVllmToolArguments(
  raw: string,
  provider: OcxProviderConfig,
): QwenVllmToolArgumentsResult {
  const config = compatConfig(provider);
  if (!config || config.validateToolArguments === false) {
    return { ok: true, arguments: raw };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, arguments: "{}" };

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) return { ok: false };
    return { ok: true, arguments: JSON.stringify(parsed) };
  } catch {
    return { ok: false };
  }
}

export function qwenVllmCompatEnabled(provider: OcxProviderConfig): boolean {
  return compatConfig(provider) !== undefined;
}
