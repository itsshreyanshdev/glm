# Claude Code -> reverse-engineered GLM-5.3

This build exposes an Anthropic-compatible `/v1/messages` endpoint and routes
Claude Code requests to the reverse-engineered ChatGLM web endpoint with
`selected_model: glm-5.3`, `chat_mode: deep_thinking`, and `reasoning_effort: max`.

## Tool calling

The ChatGLM web endpoint does not expose a native Anthropic `tool_use` protocol.
The adapter therefore translates Claude Code tool definitions into a strict
text tool protocol and converts GLM's `[tool_call]...[/tool_call]` output back
to Anthropic `tool_use` SSE/content blocks.

This is best-effort prompt-based tool calling: the model must follow the tool
format. It is not native provider-side function calling.

## Claude Code

Set:

    export ANTHROPIC_BASE_URL="https://YOUR-DOMAIN"
    export ANTHROPIC_API_KEY="YOUR-GLM-REFRESH-TOKEN-OR-PROXY-KEY"

Then run Claude Code normally. The proxy ignores the requested Claude model
name and routes the request to GLM-5.3.

Streaming tool responses are buffered until the GLM turn completes so a tool
call marker can be parsed atomically. Normal non-tool responses therefore
remain compatible, but tool turns are not token-streamed.
