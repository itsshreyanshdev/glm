import { PassThrough } from "stream";
import _ from "lodash";
import chat from "@/api/controllers/chat.ts";
import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";

const MODEL_NAME = "glm-5.3";

/**
 * GLM-Free-API does not expose native OpenAI/Anthropic tool calling to
 * chatglm.cn.  For Claude Code we therefore use a strict text protocol:
 * the tool schema is injected into the prompt and GLM is asked to emit
 * a machine-readable marker. The adapter converts that marker back into
 * Anthropic tool_use blocks.
 */
const TOOL_PROTOCOL = `

[CLAUDE_CODE_TOOL_PROTOCOL]
You are connected to an agent runtime that provides tools.
If a tool is needed, DO NOT explain the tool call in normal prose.
Instead output exactly one or more tool calls using this format:
[tool_call]
{"name":"TOOL_NAME","arguments":{...}}
[/tool_call]

Only output a tool_call block when you actually need a tool. After the tool
result is supplied, continue the task normally. Never invent tool results.
Do not wrap the tool_call block in markdown fences.
[END_CLAUDE_CODE_TOOL_PROTOCOL]
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
    return `\n\nAVAILABLE TOOLS:\n${JSON.stringify(tools, null, 2)}\n`;
}

function contentToText(content: any): string {
    if (content === undefined || content === null) return "";
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return String(content);

    return content.map((item: any) => {
        if (!item || typeof item !== "object") return String(item ?? "");
        if (item.type === "text") return item.text || "";
        if (item.type === "tool_use") {
            return `[tool_call]\n${JSON.stringify({
                name: item.name,
                arguments: item.input || {}
            })}\n[/tool_call]`;
        }
        if (item.type === "tool_result") {
            const result = Array.isArray(item.content)
                ? item.content.map((x: any) => x?.text || "").join("\n")
                : (typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? ""));
            return `[tool_result]\n${JSON.stringify({
                tool_use_id: item.tool_use_id,
                content: result
            })}\n[/tool_result]`;
        }
        return item.text || "";
    }).join("\n");
}

/** Convert Claude messages to the legacy GLM text conversation format. */
export function convertClaudeToGLM(
    messages: any[],
    system?: string | any[],
    tools?: any[]
): any[] {
    const glmMessages: any[] = [];
    const systemText = stringifySystem(system);
    const toolText = normalizeTools(tools || []);
    const protocol = tools && tools.length ? TOOL_PROTOCOL : "";
    const prefix = `${systemText}${toolText}${protocol}${systemText || toolText || protocol ? "\n\n" : ""}`;
    let firstUser = true;

    for (const msg of messages || []) {
        let content = contentToText(msg?.content);

        if (msg?.role === "user") {
            if (firstUser && prefix) content = prefix + content;
            firstUser = false;
            glmMessages.push({ role: "user", content });
        } else if (msg?.role === "assistant") {
            glmMessages.push({ role: "assistant", content });
        }
    }

    return glmMessages;
}

type ParsedToolCall = {
    name: string;
    arguments: Record<string, any>;
};

function parseToolCalls(text: string): ParsedToolCall[] {
    const calls: ParsedToolCall[] = [];
    const re = /\[tool_call\]\s*([\s\S]*?)\s*\[\/tool_call\]/gi;
    let match: RegExpExecArray | null;

    while ((match = re.exec(text))) {
        const raw = match[1].trim();
        try {
            const parsed = JSON.parse(raw);
            if (parsed?.name && typeof parsed.name === "string") {
                calls.push({
                    name: parsed.name,
                    arguments: parsed.arguments && typeof parsed.arguments === "object"
                        ? parsed.arguments
                        : {}
                });
            }
        } catch (err) {
            logger.warn(`Ignoring malformed GLM tool call: ${raw.slice(0, 300)}`);
        }
    }
    return calls;
}

function removeToolCallBlocks(text: string): string {
    return text
        .replace(/\[tool_call\][\s\S]*?\[\/tool_call\]/gi, "")
        .replace(/\[CLAUDE_CODE_TOOL_PROTOCOL\][\s\S]*?\[END_CLAUDE_CODE_TOOL_PROTOCOL\]/gi, "")
        .trim();
}

function buildClaudeResponse(glmResponse: any): any {
    const choice = glmResponse?.choices?.[0] || {};
    const rawText = choice?.message?.content || "";
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

/**
 * Buffer the GLM stream so a tool-call marker can be parsed atomically.
 * Ordinary text remains Claude-compatible; tool calls become tool_use blocks.
 */
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

            writeSse(out, "content_block_stop", {
                type: "content_block_stop",
                index
            });
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
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (!raw || raw === "[DONE]") continue;
            try {
                const data = JSON.parse(raw);
                const choice = data?.choices?.[0];
                const delta = choice?.delta;
                if (data?.usage) {
                    inputTokens = data.usage.prompt_tokens || inputTokens;
                    outputTokens = data.usage.completion_tokens || outputTokens;
                }
                if (delta?.content) text += delta.content;
                if (choice?.finish_reason) finish();
            } catch (err) {
                logger.error(`Error parsing GLM Claude stream chunk: ${err}`);
            }
        }
    });

    glmStream.on("error", (err: any) => {
        logger.error(`GLM stream error: ${err}`);
        if (!finished) out.end();
    });

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

        // Always route Claude Code's model aliases to the reverse-engineered GLM-5.3 path.
        const glmModel = "glm-5.3";

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
