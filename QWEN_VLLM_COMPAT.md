# Qwen-vLLM compatibility profile

This branch adds an explicit, provider-local compatibility profile to the `openai-chat` adapter.
It is intended to replace an extra request-sanitizing HTTP proxy between opencodex and a local
vLLM Qwen deployment.

## Recommended Qwen3.6 agent configuration

Point the provider directly at vLLM and enable agent thinking mode explicitly:

```json
{
  "providers": {
    "qwen-local": {
      "adapter": "openai-chat",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "authMode": "local",
      "defaultModel": "Qwen3.6-27B",
      "models": ["Qwen3.6-27B"],
      "liveModels": false,
      "parallelToolCalls": false,
      "preserveReasoningContentModels": ["Qwen3.6-27B"],
      "qwenVllmCompat": {
        "disableThinkingOnToolTurns": false
      }
    }
  }
}
```

The explicit `preserveReasoningContentModels` entry is recommended even though the compatibility
layer automatically registers the actually-routed model after its first request. The explicit list
also makes a resumed session correct on the very first request after an opencodex process restart.

With `disableThinkingOnToolTurns: false`, the adapter uses Qwen's chat-template controls on every
request:

```json
{
  "chat_template_kwargs": {
    "enable_thinking": true,
    "preserve_thinking": true
  }
}
```

Prior assistant thinking is replayed as `reasoning_content`, which lets the Qwen3.6 chat template
preserve that reasoning across multi-turn tool use. Conflicting OpenAI/vendor reasoning fields are
removed so the request has one authoritative thinking control.

Tool-bearing requests additionally:

- remove `stop` and `stop_token_ids` by default;
- force `parallel_tool_calls=false` by default;
- validate completed function-call arguments as JSON objects.

When argument validation is enabled, a completed tool call containing truncated or non-object JSON
is surfaced as `invalid_tool_arguments`; it is not emitted as a completed Codex function call and
is never silently rewritten to `{}`.

## vLLM launch recommendation

Use Qwen's reasoning and tool parsers and keep matching server defaults as defense in depth:

```bash
vllm serve Qwen/Qwen3.6-27B \
  --port 8000 \
  --reasoning-parser qwen3 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder \
  --default-chat-template-kwargs \
  '{"enable_thinking":true,"preserve_thinking":true}'
```

Request-level `chat_template_kwargs` emitted by this profile remain authoritative, so an accidental
server default cannot silently put agent tool turns back into the old non-thinking mode.

## Legacy compatibility mode

An empty object keeps the original preview behavior for backward compatibility:

```json
{
  "qwenVllmCompat": {}
}
```

In that mode, requests carrying tools disable thinking with
`chat_template_kwargs.enable_thinking=false`. Plain text turns are otherwise unchanged.

All existing switches remain independently configurable:

```json
{
  "qwenVllmCompat": {
    "enabled": true,
    "stripStopOnToolTurns": true,
    "disableThinkingOnToolTurns": false,
    "forceSingleToolCall": true,
    "validateToolArguments": true
  }
}
```
