# Claude Code + GLM-5.3 tool calling

This build exposes an Anthropic-compatible `/v1/messages` endpoint for Claude Code while keeping the reverse-engineered ChatGLM web backend.

## What it does

- Routes Claude Code model aliases to `glm-5.3`.
- Preserves the Claude system prompt and full tool schemas.
- Converts Claude `tool_use` history and `tool_result` history into the upstream text conversation.
- Injects a strict tool protocol asking GLM-5.3 to emit machine-readable tool calls.
- Parses `[tool_call]`, XML `<tool_call>`, and common JSON/function-call variants.
- Converts parsed calls back to Anthropic `tool_use` blocks.
- Supports streaming `/v1/messages` with Anthropic SSE events.
- `/v1/messages/count_tokens` is supported for Claude Code.

## Claude Code

Set:

```bash
export ANTHROPIC_BASE_URL="https://YOUR_DOMAIN"
export ANTHROPIC_API_KEY="YOUR_API_KEY"
```

Then run Claude Code normally.

## Important

This is a protocol compatibility layer. The upstream private ChatGLM endpoint does not expose Anthropic-native tool calls, so GLM-5.3 is instructed to emit a strict textual tool-call format and the adapter translates it to Anthropic `tool_use`. Tool reliability therefore depends on GLM-5.3 following the protocol.
