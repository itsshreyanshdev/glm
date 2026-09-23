import { PassThrough } from "stream";
import _ from "lodash";
import chat from "@/api/controllers/chat.ts";
import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";

const MODEL_NAME = "glm-5.3";

/**
 * ChatGLM's private web endpoint does not expose the Anthropic tool protocol.
 * This adapter therefore implements a compatibility layer for Claude Code:
 *   Claude tools -> explicit prompt protocol -> GLM-5.3 -> tool call parser
 *   -> Anthropic tool_use -> Claude Code executes the tool -> tool_result -> GLM
 *
 * The protocol is intentionally strict and short. Claude Code's real system
 * prompt is also preserved and passed through verbatim before this adapter
 * instruction.
 */
const TOOL_PROTOCOL = `

=== AGENT TOOL CALLING PROTOCOL ===
You are the model inside an agent runtime. Tools listed below are real tools
provided by the runtime. You MUST use them when the user's task requires them.
Do not pretend to execute a tool and do not describe a command instead of using
the tool.

WHEN A TOOL IS REQUIRED:
Output a tool call and NOTHING ELSE in that assistant turn, using exactly:
[tool_call]
{"name":"EXACT_TOOL_NAME","arguments":{}}
[/tool_call]

Rules:
1. EXACT_TOOL_NAME must exactly match one of the available tool names.
2. arguments MUST be valid JSON and match the tool input schema.
3. Do not put the tool call in Markdown fences.
4. Do not add prose before or after a tool call.
5. Multiple independent tool calls may be emitted as separate [tool_call] blocks.
6. Never invent a tool result. Wait for the next user message containing [tool_result].
7. When tool results are supplied, use them and continue the task normally.
8. If no tool is required, answer normally.
9. For file creation/editing, actually call the appropriate tool instead of merely
   printing the file contents.

=== END AGENT TOOL CALLING PROTOCOL ===
`;

function stringifySystem(system?: string | any[]): string {
    if (!system) return "";
    if (Array.isArray(system)) {
        return system
            .filter((item: any) => item?.type === "text")
            .map((item: any) => item.text || "")
            .join("\n");
    }
    return typeof system === "string" ? system : "";
}

function normalizeTools(tools: any[]): string {
    if (!Array.isArray(tools) || tools.length === 0) return "";
    // Keep the exact Claude input_schema. Do not rewrite it into a simplified
    // shape because Claude Code tools such as Edit/Write have nested schemas.
    return `\n\n=== AVAILABLE TOOLS (AUTHORITATIVE) ===\n${JSON.stringify(tools, null, 2)}\n=== END AVAILABLE TOOLS ===\n`;
}

function contentToText(content: any): string {
    if (content === undefined || content === null) return "";
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return String(content);

    return content.map((item: any) => {
        if (!item || typeof item !== "object") return String(item ?? "");
        if (item.type === "text") return item.text || "";

        if (item.type === "tool_use") {
            return `[assistant_tool_call]\n${JSON.stringify({
                name: item.name,
                arguments: item.input || {}
            })}\n[/assistant_tool_call]`;
        }

        if (item.type === "tool_result") {
            const result = Array.isArray(item.content)
                ? item.content.map((x: any) => {
                    if (typeof x === "string") return x;
                    return x?.text || JSON.stringify(x ?? "");
                }).join("\n")
                : (typeof item.content === "string"
                    ? item.content
                    : JSON.stringify(item.content ?? ""));

            return `[tool_result]\n${JSON.stringify({
                tool_use_id: item.tool_use_id,
                content: result,
                is_error: !!item.is_error
            })}\n[/tool_result]`;
        }

        return item.text || JSON.stringify(item);
    }).join("\n");
}

/** Convert Anthropic/Claude messages to the legacy GLM text conversation. */
export function convertClaudeToGLM(
    messages: any[],
    system?: string | any[],
    tools?: any[]
): any[] {
    const glmMessages: any[] = [];
    const systemText = stringifySystem(system);
    const toolText = normalizeTools(tools || []);
    const protocol = tools?.length ? TOOL_PROTOCOL : "";

    const prefix = `${systemText}${toolText}${protocol}${systemText || toolText || protocol ? "\n\n" : ""}`;
    let firstUser = true;

    for (const msg of messages || []) {
        const role = msg?.role;
        const content = contentToText(msg?.content);

        if (role === "user") {
            glmMessages.push({
                role: "user",
                content: firstUser && prefix ? prefix + content : content
            });
            firstUser = false;
        } else if (role === "assistant") {
            glmMessages.push({ role: "assistant", content });
        }
    }

    // The upstream accepts a GPT-like role array. Ensure a user turn exists.
    if (!glmMessages.length) {
        glmMessages.push({ role: "user", content: prefix || "Hello" });
    }

    return glmMessages;
}

type ParsedToolCall = {
    name: string;
    arguments: Record<string, any>;
};

function safeJsonObject(value: any): Record<string, any> | null {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value !== "string") return null;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function addCall(calls: ParsedToolCall[], name: any, args: any) {
    if (typeof name !== "string" || !name.trim()) return;
    const parsedArgs = safeJsonObject(args) || {};
    if (!calls.some(c => c.name === name && JSON.stringify(c.arguments) === JSON.stringify(parsedArgs))) {
        calls.push({ name: name.trim(), arguments: parsedArgs });
    }
}

/**
 * Accept the strict protocol plus several common variants GLM may emit:
 * - [tool_call] JSON [/tool_call]
 * - <tool_call>JSON</tool_call>
 * - JSON objects containing tool_calls/function calls
 * - fenced JSON containing one of the above
 */
function parseToolCalls(text: string): ParsedToolCall[] {
    const calls: ParsedToolCall[] = [];
    if (!text) return calls;

    const patterns = [
        /\[tool_call\]\s*([\s\S]*?)\s*\[\/tool_call\]/gi,
        /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi,
        /\[assistant_tool_call\]\s*([\s\S]*?)\s*\[\/assistant_tool_call\]/gi
    ];

    for (const re of patterns) {
        let match: RegExpExecArray | null;
        while ((match = re.exec(text))) {
            const raw = match[1].trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
            const parsed = safeJsonObject(raw);
            if (!parsed) {
                logger.warn(`Malformed GLM tool call: ${raw.slice(0, 500)}`);
                continue;
            }

            if (Array.isArray(parsed.tool_calls)) {
                for (const tc of parsed.tool_calls) {
                    addCall(calls, tc?.function?.name || tc?.name, tc?.function?.arguments || tc?.arguments || {});
                }
            } else if (parsed.function?.name) {
                addCall(calls, parsed.function.name, parsed.function.arguments || {});
            } else {
                addCall(calls, parsed.name, parsed.arguments || parsed.input || {});
            }
        }
    }

    // Some reasoning models emit a raw JSON function-call object without the
    // marker. Only accept it when it unmistakably looks like a function call.
    const fenced = /```json\s*([\s\S]*?)```/gi;
    let fm: RegExpExecArray | null;
    while ((fm = fenced.exec(text))) {
        const parsed = safeJsonObject(fm[1].trim());
        if (!parsed) continue;
        if (parsed.tool_calls || parsed.function || parsed.name) {
            if (Array.isArray(parsed.tool_calls)) {
                for (const tc of parsed.tool_calls) addCall(calls, tc?.function?.name || tc?.name, tc?.function?.arguments || tc?.arguments || {});
            } else if (parsed.function?.name) {
                addCall(calls, parsed.function.name, parsed.function.arguments || {});
            } else {
                addCall(calls, parsed.name, parsed.arguments || parsed.input || {});
            }
        }
    }

    return calls;
}

function removeToolCallBlocks(text: string): string {
    return text
        .replace(/\[tool_call\][\s\S]*?\[\/tool_call\]/gi, "")
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
        .replace(/\[assistant_tool_call\][\s\S]*?\[\/assistant_tool_call\]/gi, "")
        .replace(/\[CLAUDE_CODE_TOOL_PROTOCOL\][\s\S]*?\[END_CLAUDE_CODE_TOOL_PROTOCOL\]/gi, "")
        .trim();
}

function buildClaudeResponse(glmResponse: any): any {
    const choice = glmResponse?.choices?.[0] || {};
    const rawText = typeof choice?.message?.content === "string"
        ? choice.message.content
        : contentToText(choice?.message?.content);
    const toolCalls = parseToolCalls(rawText);
    const content: any[] = [];
    const text = removeToolCallBlocks(rawText);

    if (text) content.push({ type: "text", text });
    for (const call of toolCalls) {
        content.push({
            type: "tool_use",
            id: `toolu_${util.uuid().replace(/-/g, "")}`,
            name: call.name,
            input: call.arguments
        });
    }

    return {
        id: glmResponse?.id || `msg_${util.uuid().replace(/-/g, "")}`,
        type: "message",
        role: "assistant",
        content,
        model: MODEL_NAME,
        stop_reason: toolCalls.length ? "tool_use" : (choice.finish_reason === "length" ? "max_tokens" : "end_turn"),
        stop_sequence: null,
        usage: {
            input_tokens: glmResponse?.usage?.prompt_tokens || 0,
            output_tokens: glmResponse?.usage?.completion_tokens || 0
        }
    };
}

export function convertGLMToClaude(glmResponse: any): any {
    return buildClaudeResponse(glmResponse);
}

function writeSse(stream: PassThrough, event: string, data: any) {
    stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Buffer upstream GLM SSE so tool calls are emitted as atomic Anthropic blocks. */
export function convertGLMStreamToClaude(glmStream: any): PassThrough {
    const out = new PassThrough();
    const messageId = `msg_${util.uuid().replace(/-/g, "")}`;
    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let finished = false;
    let pending = "";

    const finish = () => {
        if (finished) return;
        finished = true;

        const toolCalls = parseToolCalls(text);
        const cleanText = removeToolCallBlocks(text);
        const blocks: any[] = [];
        if (cleanText) blocks.push({ type: "text", text: cleanText });
        for (const call of toolCalls) {
            blocks.push({
                type: "tool_use",
                id: `toolu_${util.uuid().replace(/-/g, "")}`,
                name: call.name,
                input: call.arguments
            });
        }

        writeSse(out, "message_start", {
            type: "message_start",
            message: {
                id: messageId,
                type: "message",
                role: "assistant",
                content: [],
                model: MODEL_NAME,
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: inputTokens, output_tokens: 0 }
            }
        });

        blocks.forEach((block, index) => {
            writeSse(out, "content_block_start", {
                type: "content_block_start",
                index,
                content_block: block.type === "text"
                    ? { type: "text", text: "" }
                    : { type: "tool_use", id: block.id, name: block.name, input: {} }
            });

            if (block.type === "text") {
                writeSse(out, "content_block_delta", {
                    type: "content_block_delta",
                    index,
                    delta: { type: "text_delta", text: block.text }
                });
            } else {
                writeSse(out, "content_block_delta", {
                    type: "content_block_delta",
                    index,
                    delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
                });
            }

            writeSse(out, "content_block_stop", { type: "content_block_stop", index });
        });

        writeSse(out, "message_delta", {
            type: "message_delta",
            delta: {
                stop_reason: toolCalls.length ? "tool_use" : "end_turn",
                stop_sequence: null
            },
            usage: { output_tokens: outputTokens || 1 }
        });
        writeSse(out, "message_stop", { type: "message_stop" });
        out.end();
    };

    glmStream.on("data", (chunk: Buffer) => {
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop() || "";

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const raw = trimmed.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;

            try {
                const data = JSON.parse(raw);
                const choice = data?.choices?.[0];
                const delta = choice?.delta;
                if (data?.usage) {
                    inputTokens = data.usage.prompt_tokens || inputTokens;
                    outputTokens = data.usage.completion_tokens || outputTokens;
                }
                if (typeof delta?.content === "string") text += delta.content;
                if (choice?.finish_reason) finish();
            } catch (err) {
                logger.error(`Error parsing GLM Claude stream chunk: ${err}`);
            }
        }
    });

    glmStream.on("error", (err: any) => {
        logger.error(`GLM stream error: ${err}`);
        if (!finished) {
            finished = true;
            out.destroy(err);
        }
    });

    glmStream.on("end", finish);
    glmStream.on("close", finish);
    return out;
}

export async function createClaudeCompletion(
    model: string,
    messages: any[],
    system: string | any[] | undefined,
    refreshToken: string,
    stream: boolean = false,
    conversationId?: string,
    tools?: any[]
): Promise<any | PassThrough> {
    try {
        const glmMessages = convertClaudeToGLM(messages, system, tools);
        const glmModel = "glm-5.3";

        logger.info(`Claude Code request -> ${glmModel}; tools=${tools?.length || 0}; stream=${stream}`);

        if (stream) {
            const glmStream = await chat.createCompletionStream(
                glmMessages,
                refreshToken,
                glmModel,
                conversationId
            );
            return convertGLMStreamToClaude(glmStream);
        }

        const glmResponse = await chat.createCompletion(
            glmMessages,
            refreshToken,
            glmModel,
            conversationId
        );
        return convertGLMToClaude(glmResponse);
    } catch (error) {
        logger.error(`Error creating Claude completion: ${error}`);
        throw error;
    }
}
