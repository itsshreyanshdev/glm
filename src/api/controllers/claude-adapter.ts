import { PassThrough } from "stream";
import chat from "@/api/controllers/chat.ts";
import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";

const MODEL_NAME = "glm-5.3";

type ParsedToolCall = { name: string; arguments: Record<string, any> };

const TOOL_PROTOCOL = `

### CRITICAL AGENT RUNTIME RULES
You are running INSIDE a coding-agent runtime. The tools below are REAL tools.
When a task requires reading, creating, editing, deleting, searching, or running files/commands, you MUST invoke the appropriate tool. Do NOT answer with file contents or a command for the user to copy instead.

CANONICAL TOOL CALL FORMAT — output ONLY this block when invoking a tool:
<<<TOOL_CALL>>>
{"name":"EXACT_TOOL_NAME","arguments":{}}
<<<END_TOOL_CALL>>>

ABSOLUTE RULES:
- Use an EXACT tool name from AVAILABLE TOOLS.
- arguments must be valid JSON and match that tool's input schema.
- Do not use Markdown fences around a tool call.
- Do not add prose before or after a tool call in the same assistant turn.
- Multiple independent calls may be emitted as separate blocks.
- Never fabricate a tool result. Wait for the next tool_result turn.
- After tool results arrive, continue the task and invoke another tool if needed.
- If no tool is needed, answer normally.
- For file creation/editing, ALWAYS invoke Write/Edit (or the matching available tool); never merely print the file.
- For shell commands, ALWAYS invoke Bash (or the matching available execution tool); never merely print the command.

AVAILABLE TOOLS are authoritative. Ignore any tool name that is not listed there.
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

function compactTools(tools: any[]): string {
    if (!Array.isArray(tools) || !tools.length) return "";

    const compact = tools.map((tool: any) => {
        const schema = tool?.input_schema || tool?.function?.parameters || tool?.parameters || {};
        return {
            name: tool?.name || tool?.function?.name,
            description: typeof (tool?.description || tool?.function?.description) === "string"
                ? String(tool.description || tool.function?.description).slice(0, 700)
                : "",
            input_schema: schema,
        };
    }).filter((x: any) => typeof x.name === "string" && x.name.length > 0);

    return `\n=== AVAILABLE TOOLS (AUTHORITATIVE) ===\n${JSON.stringify(compact)}\n=== END AVAILABLE TOOLS ===\n`;
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
                id: item.id,
                name: item.name,
                arguments: item.input || {}
            })}\n[/assistant_tool_call]`;
        }

        if (item.type === "tool_result") {
            const result = Array.isArray(item.content)
                ? item.content.map((x: any) => typeof x === "string" ? x : (x?.text || JSON.stringify(x ?? ""))).join("\n")
                : typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? "");
            return `[tool_result]\n${JSON.stringify({
                tool_use_id: item.tool_use_id,
                content: result,
                is_error: !!item.is_error
            })}\n[/tool_result]`;
        }

        return item.text || JSON.stringify(item);
    }).join("\n");
}

export function convertClaudeToGLM(messages: any[], system?: string | any[], tools?: any[]): any[] {
    const glmMessages: any[] = [];
    const systemText = stringifySystem(system);
    const toolText = compactTools(tools || []);
    const protocol = tools?.length ? TOOL_PROTOCOL : "";

    // Put the agent contract before Claude's large system prompt. This is
    // intentional: ChatGLM's web backend receives a text conversation rather
    // than a real system role, so the actionable contract must be highly salient.
    const prefix = `${protocol}${toolText}${systemText ? `\n=== ORIGINAL SYSTEM INSTRUCTIONS ===\n${systemText}\n=== END ORIGINAL SYSTEM INSTRUCTIONS ===\n` : ""}`;

    let firstUser = true;
    for (const msg of messages || []) {
        const role = msg?.role;
        const content = contentToText(msg?.content);
        if (role === "user") {
            glmMessages.push({
                role: "user",
                content: firstUser ? `${prefix}\n=== USER REQUEST ===\n${content}` : content
            });
            firstUser = false;
        } else if (role === "assistant") {
            glmMessages.push({ role: "assistant", content });
        }
    }

    if (!glmMessages.length) glmMessages.push({ role: "user", content: prefix || "Hello" });
    return glmMessages;
}

function safeObject(value: any): Record<string, any> | null {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!text) return {};
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function addCall(calls: ParsedToolCall[], name: any, args: any) {
    if (typeof name !== "string" || !name.trim()) return;
    let parsed = safeObject(args);
    if (!parsed && typeof args === "string") {
        // Some models return a JSON string wrapped one level deeper.
        try { parsed = safeObject(JSON.parse(args)); } catch { /* ignore */ }
    }
    parsed ||= {};
    const normalized = name.trim();
    if (!calls.some(c => c.name === normalized && JSON.stringify(c.arguments) === JSON.stringify(parsed))) {
        calls.push({ name: normalized, arguments: parsed });
    }
}

function parseFunctionObject(value: any, calls: ParsedToolCall[]) {
    const parsed = safeObject(value);
    if (!parsed) return;

    if (Array.isArray(parsed.tool_calls)) {
        for (const tc of parsed.tool_calls) {
            addCall(calls, tc?.function?.name || tc?.name, tc?.function?.arguments ?? tc?.arguments ?? tc?.input ?? {});
        }
        return;
    }

    if (parsed.function?.name) {
        addCall(calls, parsed.function.name, parsed.function.arguments ?? parsed.function.input ?? {});
        return;
    }

    if (parsed.name) addCall(calls, parsed.name, parsed.arguments ?? parsed.input ?? parsed.parameters ?? {});
}

function parseXmlToolCalls(text: string, calls: ParsedToolCall[]) {
    // <tool_call><function=Write><parameter=...>...</parameter></function></tool_call>
    const blocks = text.match(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi) || [];
    for (const block of blocks) {
        const functionMatch = block.match(/<function\s*[=:]\s*["']?([^\s>"']+)["']?\s*>/i) ||
            block.match(/<function\s+name\s*=\s*["']([^"']+)["'][^>]*>/i);
        const invokeMatch = block.match(/<invoke\s+name\s*=\s*["']([^"']+)["'][^>]*>/i);
        const name = functionMatch?.[1] || invokeMatch?.[1];
        if (!name) {
            const jsonMatch = block.replace(/^<tool_call[^>]*>|<\/tool_call>$/gi, "").trim();
            parseFunctionObject(jsonMatch, calls);
            continue;
        }

        const args: Record<string, any> = {};
        const paramRe = /<(?:parameter|param)\s+(?:name|key)\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:parameter|param)>/gi;
        let pm: RegExpExecArray | null;
        while ((pm = paramRe.exec(block))) {
            const raw = pm[2].trim();
            try { args[pm[1]] = JSON.parse(raw); } catch { args[pm[1]] = raw; }
        }
        if (!Object.keys(args).length) {
            const jsonInside = block.match(/<function[^>]*>([\s\S]*?)<\/function>/i)?.[1]?.trim() ||
                block.match(/<invoke[^>]*>([\s\S]*?)<\/invoke>/i)?.[1]?.trim();
            if (jsonInside) {
                const obj = safeObject(jsonInside);
                if (obj) Object.assign(args, obj);
            }
        }
        addCall(calls, name, args);
    }
}

export function parseToolCalls(text: string): ParsedToolCall[] {
    const calls: ParsedToolCall[] = [];
    if (!text) return calls;

    const blockPatterns = [
        /<<<TOOL_CALL>>>\s*([\s\S]*?)\s*<<<END_TOOL_CALL>>>/gi,
        /\[tool_call\]\s*([\s\S]*?)\s*\[\/tool_call\]/gi,
        /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi,
        /\[assistant_tool_call\]\s*([\s\S]*?)\s*\[\/assistant_tool_call\]/gi,
        /<\|tool_call\|>\s*([\s\S]*?)\s*(?:<\|\/tool_call\|>|<\|end\|>)/gi,
    ];

    for (const re of blockPatterns) {
        let match: RegExpExecArray | null;
        while ((match = re.exec(text))) parseFunctionObject(match[1].trim(), calls);
    }

    parseXmlToolCalls(text, calls);

    // Fenced JSON or an entire response containing a function-call object.
    const fenced = /```(?:json|javascript|js)?\s*([\s\S]*?)```/gi;
    let fm: RegExpExecArray | null;
    while ((fm = fenced.exec(text))) parseFunctionObject(fm[1].trim(), calls);

    // Only inspect standalone JSON-ish lines. This avoids interpreting normal
    // prose that happens to contain a {name: ...} fragment as a tool call.
    for (const line of text.split(/\r?\n/)) {
        const s = line.trim();
        if ((s.startsWith("{") && s.endsWith("}")) || s.startsWith("{\"tool_calls\"")) {
            parseFunctionObject(s, calls);
        }
    }

    return calls;
}

function removeToolCallBlocks(text: string): string {
    return text
        .replace(/<<<TOOL_CALL>>>[\s\S]*?<<<END_TOOL_CALL>>>/gi, "")
        .replace(/\[tool_call\][\s\S]*?\[\/tool_call\]/gi, "")
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
        .replace(/\[assistant_tool_call\][\s\S]*?\[\/assistant_tool_call\]/gi, "")
        .replace(/<\|tool_call\|>[\s\S]*?(?:<\|\/tool_call\|>|<\|end\|>)/gi, "")
        .trim();
}

function buildClaudeResponse(glmResponse: any): any {
    const choice = glmResponse?.choices?.[0] || {};
    const rawText = typeof choice?.message?.content === "string" ? choice.message.content : contentToText(choice?.message?.content);
    const toolCalls = parseToolCalls(rawText);
    const content: any[] = [];
    const text = removeToolCallBlocks(rawText);
    if (text) content.push({ type: "text", text });

    for (const call of toolCalls) {
        content.push({ type: "tool_use", id: `toolu_${util.uuid().replace(/-/g, "")}`, name: call.name, input: call.arguments });
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

export function convertGLMToClaude(glmResponse: any): any { return buildClaudeResponse(glmResponse); }

function writeSse(stream: PassThrough, event: string, data: any) {
    stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

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
            blocks.push({ type: "tool_use", id: `toolu_${util.uuid().replace(/-/g, "")}`, name: call.name, input: call.arguments });
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
                writeSse(out, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
            } else {
                writeSse(out, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
            }
            writeSse(out, "content_block_stop", { type: "content_block_stop", index });
        });

        writeSse(out, "message_delta", {
            type: "message_delta",
            delta: { stop_reason: toolCalls.length ? "tool_use" : "end_turn", stop_sequence: null },
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
        if (!finished) { finished = true; out.destroy(err); }
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
    stream = false,
    conversationId?: string,
    tools?: any[]
): Promise<any | PassThrough> {
    try {
        const glmMessages = convertClaudeToGLM(messages, system, tools);
        logger.info(`Claude Code -> ${MODEL_NAME}; tools=${tools?.length || 0}; stream=${stream}`);

        if (stream) {
            const glmStream = await chat.createCompletionStream(glmMessages, refreshToken, MODEL_NAME, conversationId);
            return convertGLMStreamToClaude(glmStream);
        }

        const glmResponse = await chat.createCompletion(glmMessages, refreshToken, MODEL_NAME, conversationId);
        return convertGLMToClaude(glmResponse);
    } catch (error) {
        logger.error(`Error creating Claude completion: ${error}`);
        throw error;
    }
}
