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

/**
 * Apply compatibility adjustments that are useful for Qwen chat templates served by vLLM.
 * The profile is explicit and provider-local: no other OpenAI-compatible provider changes.
 */
export function applyQwenVllmRequestCompat(
  body: Record<string, unknown>,
  provider: OcxProviderConfig,
  hasTools: boolean,
): QwenVllmRequestCompatResult {
  const config = compatConfig(provider);
  if (!config || !hasTools) return { enabled: false, thinkingDisabled: false };

  if (config.stripStopOnToolTurns !== false) {
    delete body.stop;
    delete body.stop_token_ids;
  }

  let thinkingDisabled = false;
  if (config.disableThinkingOnToolTurns !== false) {
    const existing = isRecord(body.chat_template_kwargs) ? body.chat_template_kwargs : {};
    body.chat_template_kwargs = { ...existing, enable_thinking: false };

    // Do not send a second, conflicting reasoning control alongside the Qwen chat-template flag.
    delete body.reasoning;
    delete body.reasoning_effort;
    delete body.reasoning_split;
    delete body.thinking;
    delete body.thinking_budget;
    thinkingDisabled = true;
  }

  if (config.forceSingleToolCall !== false) {
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
