# Claude Code + GLM-5.3 tool calling

This build exposes an Anthropic-compatible `/v1/messages` adapter while retaining the existing reverse-engineered ChatGLM web backend and GLM-5.3 request metadata.

## Tool-calling adapter

The adapter:

- Preserves the incoming Claude system instructions.
- Converts Anthropic `tools` into a compact authoritative tool manifest.
- Places the tool contract before the large Claude system prompt because the ChatGLM backend receives a text conversation rather than a native system role.
- Uses a canonical `<<<TOOL_CALL>>>...<<<END_TOOL_CALL>>>` format.
- Parses several fallback formats: canonical blocks, `[tool_call]`, XML `<tool_call>`, `<invoke>`, `<function>`, fenced JSON, and common function/tool-call JSON.
- Converts parsed calls to Anthropic `tool_use` blocks.
- Converts Claude `tool_result` blocks back into the GLM conversation.
- Supports multiple tool calls in one response.
- Buffers GLM streaming output so a tool call is emitted atomically as an Anthropic `tool_use` block.
- Keeps `/v1/messages/count_tokens` available for Claude Code.

This remains a compatibility layer: the private ChatGLM web endpoint is not being given a native Anthropic `tools` field. Tool execution itself remains on the Claude Code side; the adapter only translates the model's textual tool-call representation into Anthropic `tool_use`.

## Deploy

```bash
npm install
npm run build
```

Then restart the existing container/service. Caddy does not need to be changed.

If Caddy and the API are separate Docker networks, make sure the API container is attached to the same network as Caddy (for the setup described in the deployment notes, `newapi_default`).
