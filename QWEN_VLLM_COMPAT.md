# Qwen-vLLM compatibility profile

This preview adds an explicit, provider-local compatibility profile to the `openai-chat` adapter.
It is intended to replace an extra request-sanitizing HTTP proxy between opencodex and a local
vLLM Qwen deployment.

## Configuration

Point the provider directly at vLLM and add `qwenVllmCompat`:

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
      "qwenVllmCompat": {}
    }
  }
}
```

An empty object enables safe defaults only on requests that contain tools:

- remove `stop` and `stop_token_ids`;
- set `chat_template_kwargs.enable_thinking=false`;
- remove conflicting reasoning controls;
- force `parallel_tool_calls=false`;
- validate completed function-call arguments as JSON objects.

All switches are independently configurable:

```json
{
  "qwenVllmCompat": {
    "enabled": true,
    "stripStopOnToolTurns": true,
    "disableThinkingOnToolTurns": true,
    "forceSingleToolCall": true,
    "validateToolArguments": true
  }
}
```

When argument validation is enabled, a completed tool call containing truncated or non-object JSON
is surfaced as `invalid_tool_arguments`; it is not emitted as a completed Codex function call and
is never silently rewritten to `{}`.
