#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(process.argv[2] ?? process.cwd());

async function read(path) {
  return readFile(join(repoRoot, path), "utf8");
}

async function write(path, content) {
  const target = join(repoRoot, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

function replaceOnce(content, before, after, label) {
  const first = content.indexOf(before);
  if (first < 0) throw new Error(`Cannot apply ${label}: anchor not found`);
  if (content.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Cannot apply ${label}: anchor is not unique`);
  }
  return content.slice(0, first) + after + content.slice(first + before.length);
}

async function patchTypes() {
  let source = await read("src/types.ts");

  source = replaceOnce(
    source,
    `/**\n * One configured provider entry. \`authMode\` (default \`\"key\"\`) decides whether same-target 429\n * retries are allowed; OAuth/forward credentials and local runtimes are never replayed.\n */\nexport interface OcxProviderConfig {`,
    `export interface QwenVllmCompatConfig {\n  /** Master switch. The presence of the object enables the profile unless explicitly false. */\n  enabled?: boolean;\n  /** Remove stop/stop_token_ids on requests carrying tools. Default true. */\n  stripStopOnToolTurns?: boolean;\n  /** Set chat_template_kwargs.enable_thinking=false and remove conflicting reasoning controls. Default true. */\n  disableThinkingOnToolTurns?: boolean;\n  /** Force parallel_tool_calls=false on tool turns. Default true. */\n  forceSingleToolCall?: boolean;\n  /** Reject completed function calls whose arguments are not JSON objects. Default true. */\n  validateToolArguments?: boolean;\n}\n\n/**\n * One configured provider entry. \`authMode\` (default \`\"key\"\`) decides whether same-target 429\n * retries are allowed; OAuth/forward credentials and local runtimes are never replayed.\n */\nexport interface OcxProviderConfig {`,
    "provider compatibility type",
  );

  source = replaceOnce(
    source,
    `  retryOn429?: RateLimitRetryPolicy;\n  /**\n   * Model ids whose OpenAI-compatible chat endpoint accepts \`reasoning_split: true\``,
    `  retryOn429?: RateLimitRetryPolicy;\n  /**\n   * Explicit compatibility profile for Qwen chat templates served by vLLM. Config-file only.\n   * Absent means no behavior change; an empty object enables the safe defaults.\n   */\n  qwenVllmCompat?: QwenVllmCompatConfig;\n  /**\n   * Model ids whose OpenAI-compatible chat endpoint accepts \`reasoning_split: true\``,
    "provider compatibility field",
  );

  await write("src/types.ts", source);
}

async function patchOpenAIChat() {
  let source = await read("src/adapters/openai-chat.ts");

  source = replaceOnce(
    source,
    `import { openRouterProviderPayload, resolveOpenRouterRouting } from "../providers/openrouter-routing";\nimport {`,
    `import { openRouterProviderPayload, resolveOpenRouterRouting } from "../providers/openrouter-routing";\nimport {\n  applyQwenVllmRequestCompat,\n  normalizeQwenVllmToolArguments,\n} from "./qwen-vllm-compat";\nimport {`,
    "qwen-vllm imports",
  );

  source = replaceOnce(
    source,
    `function invalidChoicesEvent(usage?: OcxUsage): Extract<AdapterEvent, { type: "error" }> {\n  return {\n    type: "error",\n    message: "upstream response contained invalid choices",\n    ...(usage !== undefined ? { usage } : {}),\n  };\n}\n`,
    `function invalidChoicesEvent(usage?: OcxUsage): Extract<AdapterEvent, { type: "error" }> {\n  return {\n    type: "error",\n    message: "upstream response contained invalid choices",\n    ...(usage !== undefined ? { usage } : {}),\n  };\n}\n\nfunction invalidQwenVllmToolArgumentsEvent(\n  callId: string,\n  name: string,\n  usage?: OcxUsage,\n): Extract<AdapterEvent, { type: "error" }> {\n  debugProviderDiagnostic("openai-chat", "qwen-vllm-invalid-tool-arguments", {\n    callId: callId || null,\n    toolName: name || null,\n  });\n  return {\n    type: "error",\n    status: 502,\n    errorType: "upstream_error",\n    code: "invalid_tool_arguments",\n    message: \`upstream returned invalid JSON-object arguments for tool "\${name || "unknown"}"\`,\n    ...(usage !== undefined ? { usage } : {}),\n  };\n}\n`,
    "invalid tool-arguments error",
  );

  source = replaceOnce(
    source,
    `      if (parsed.stream) {\n        body.stream_options = { include_usage: true };\n      }\n\n      const url = \`\${provider.baseUrl}/chat/completions\`;`,
    `      if (parsed.stream) {\n        body.stream_options = { include_usage: true };\n      }\n\n      const qwenVllmCompat = applyQwenVllmRequestCompat(body, provider, tools !== undefined);\n      if (qwenVllmCompat.thinkingDisabled) {\n        reasoningLog = {\n          effectiveEffort: "none",\n          wireField: "chat_template_kwargs.enable_thinking",\n          wireValue: false,\n        };\n      }\n\n      const url = \`\${provider.baseUrl}/chat/completions\`;`,
    "request compatibility hook",
  );

  source = replaceOnce(
    source,
    `      const flushToolCalls = function* (): Generator<AdapterEvent> {\n        // Do not treat flushed tool calls as user-facing output for the finish-less EOF\n        // fallback — incomplete tool args must stay on the truncation path.\n        for (const call of closeToolCalls()) {\n          if (!call.id) call.id = \`call_\${++toolCallSeq}\`;\n          yield { type: "tool_call_start", id: call.id, name: call.name };\n          if (call.args.length > 0) yield { type: "tool_call_delta", arguments: call.args };\n          yield { type: "tool_call_end" };\n        }\n      };`,
    `      const flushToolCalls = function* (): Generator<AdapterEvent, boolean> {\n        // Validate the entire batch before emitting any call. A provider terminal signal does not\n        // make a half-written JSON buffer safe to execute.\n        const prepared: Array<{ call: PendingToolCall; arguments: string }> = [];\n        for (const call of closeToolCalls()) {\n          if (!call.id) call.id = \`call_\${++toolCallSeq}\`;\n          const normalized = normalizeQwenVllmToolArguments(call.args, provider);\n          if (!normalized.ok) {\n            yield invalidQwenVllmToolArgumentsEvent(call.id, call.name, pendingUsage);\n            return false;\n          }\n          prepared.push({ call, arguments: normalized.arguments });\n        }\n\n        // Do not treat flushed tool calls as user-facing output for the finish-less EOF\n        // fallback — incomplete tool args must stay on the truncation path.\n        for (const { call, arguments: args } of prepared) {\n          yield { type: "tool_call_start", id: call.id, name: call.name };\n          if (args.length > 0) yield { type: "tool_call_delta", arguments: args };\n          yield { type: "tool_call_end" };\n        }\n        return true;\n      };`,
    "atomic validated tool flush",
  );

  source = replaceOnce(
    source,
    `        if (payload === "[DONE]") {\n          yield* flushToolCalls();\n          const stopReason = stopReasonFor(finishReason);`,
    `        if (payload === "[DONE]") {\n          if (!(yield* flushToolCalls())) return "terminate";\n          const stopReason = stopReasonFor(finishReason);`,
    "done sentinel validation",
  );

  source = replaceOnce(
    source,
    `        if (typeof choice.finish_reason === "string" && choice.finish_reason) {\n          yield* flushToolCalls();\n        }\n        return "continue";`,
    `        if (typeof choice.finish_reason === "string" && choice.finish_reason) {\n          if (!(yield* flushToolCalls())) return "terminate";\n        }\n        return "continue";`,
    "finish-reason validation",
  );

  source = replaceOnce(
    source,
    `        yield* flushToolCalls();\n        // Graceful close that omitted [DONE] but delivered finish_reason and/or answer text.`,
    `        if (!(yield* flushToolCalls())) return;\n        // Graceful close that omitted [DONE] but delivered finish_reason and/or answer text.`,
    "EOF validation",
  );

  source = replaceOnce(
    source,
    `      const toolCalls = msg.tool_calls as { id: string; function: { name: string; arguments: string } }[] | undefined;\n      if (toolCalls) {\n        for (const tc of toolCalls) {\n          events.push({ type: "tool_call_start", id: tc.id, name: tc.function.name });\n          events.push({ type: "tool_call_delta", arguments: tc.function.arguments });\n          events.push({ type: "tool_call_end" });\n        }\n      }`,
    `      const toolCalls = msg.tool_calls as { id: string; function: { name: string; arguments: string } }[] | undefined;\n      if (toolCalls) {\n        const prepared: Array<{ id: string; name: string; arguments: string }> = [];\n        for (const tc of toolCalls) {\n          const normalized = normalizeQwenVllmToolArguments(tc.function.arguments, provider);\n          if (!normalized.ok) {\n            return [invalidQwenVllmToolArgumentsEvent(tc.id, tc.function.name, usage)];\n          }\n          prepared.push({ id: tc.id, name: tc.function.name, arguments: normalized.arguments });\n        }\n        for (const tc of prepared) {\n          events.push({ type: "tool_call_start", id: tc.id, name: tc.name });\n          if (tc.arguments.length > 0) events.push({ type: "tool_call_delta", arguments: tc.arguments });\n          events.push({ type: "tool_call_end" });\n        }\n      }`,
    "non-stream tool validation",
  );

  await write("src/adapters/openai-chat.ts", source);
}

await patchTypes();
await patchOpenAIChat();
console.log(`Applied Qwen-vLLM compatibility preview to ${repoRoot}`);
