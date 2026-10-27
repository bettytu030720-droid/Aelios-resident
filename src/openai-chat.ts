// A small part of the OpenAI chat completions format, for the resident's hands on GitHub Actions (public/hands.mjs):
// they call the model through the resident, which runs it with its own settings and keys (resident.ts, handsModel).
// Only what the hands send: text messages, function tools, tool calls and their results; one step per call.
import { jsonSchema, tool, type JSONSchema7, type ModelMessage, type ToolSet } from "ai";

type Call = { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
type Message = { role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown };
type FunctionTool = { type?: unknown; function?: { name?: unknown; description?: unknown; parameters?: unknown } };

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MESSAGES_MAX = 400;
const TOOLS_MAX = 32;

/** Text of an OpenAI content field: a string, or parts of which the text ones count. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
    .join("");
}

function inputOf(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * The request as AI SDK instructions (its system messages), messages and tools without execute (so a call comes
 * back to the hands), or why not.
 */
export function fromOpenAI(body: unknown): { instructions: string; messages: ModelMessage[]; tools: ToolSet } | { error: string } {
  const value = (body ?? {}) as { messages?: unknown; tools?: unknown };
  if (!Array.isArray(value.messages) || !value.messages.length) return { error: "messages must be a non-empty array" };
  if (value.messages.length > MESSAGES_MAX) return { error: `at most ${MESSAGES_MAX} messages` };
  const tools: ToolSet = {};
  for (const item of (Array.isArray(value.tools) ? value.tools : []).slice(0, TOOLS_MAX) as FunctionTool[]) {
    const name = item?.function?.name;
    if (item?.type !== "function" || typeof name !== "string" || !TOOL_NAME.test(name)) return { error: "tools must be functions with plain names" };
    const parameters = item.function?.parameters && typeof item.function.parameters === "object" ? (item.function.parameters as JSONSchema7) : { type: "object" as const };
    tools[name] = tool({ description: typeof item.function?.description === "string" ? item.function.description : "", inputSchema: jsonSchema(parameters) });
  }
  // A tool result names only its call: the name comes from the assistant message that made it.
  const names = new Map<string, string>();
  const instructions: string[] = [];
  const messages: ModelMessage[] = [];
  for (const message of value.messages as Message[]) {
    const role = message?.role;
    if (role === "system" || role === "developer") {
      instructions.push(textOf(message.content));
    } else if (role === "user") {
      messages.push({ role: "user", content: textOf(message.content) });
    } else if (role === "assistant") {
      const text = textOf(message.content);
      const calls = (Array.isArray(message.tool_calls) ? message.tool_calls : []) as Call[];
      const parts: Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string> = text ? [{ type: "text", text }] : [];
      for (const call of calls) {
        const id = typeof call?.id === "string" ? call.id : "";
        const name = typeof call?.function?.name === "string" ? call.function.name : "";
        if (!id || !name) return { error: "a tool call needs an id and a name" };
        names.set(id, name);
        parts.push({ type: "tool-call", toolCallId: id, toolName: name, input: inputOf(call.function?.arguments) });
      }
      messages.push({ role: "assistant", content: parts.length ? parts : "" });
    } else if (role === "tool") {
      const id = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
      const name = names.get(id);
      if (!name) return { error: "a tool result must answer an earlier tool call" };
      const part = { type: "tool-result" as const, toolCallId: id, toolName: name, output: { type: "text" as const, value: textOf(message.content) } };
      // Results of one step's calls go in one tool message, as the providers expect.
      const last = messages.at(-1);
      if (last?.role === "tool") last.content.push(part);
      else messages.push({ role: "tool", content: [part] });
    } else {
      return { error: "unknown message role" };
    }
  }
  if (!messages.length) return { error: "messages must hold more than system messages" };
  return { instructions: instructions.join("\n\n"), messages, tools };
}

type Result = {
  text: string;
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>;
  finishReason: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
};

/** One step's answer, shaped as an OpenAI chat completion. */
export function toOpenAI(result: Result, model: string): Record<string, unknown> {
  const tool_calls = result.toolCalls.map((call) => ({
    id: call.toolCallId,
    type: "function",
    function: { name: call.toolName, arguments: JSON.stringify(call.input ?? {}) }
  }));
  const finish = tool_calls.length ? "tool_calls" : result.finishReason === "length" ? "length" : "stop";
  return {
    id: `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: result.text || null, ...(tool_calls.length ? { tool_calls } : {}) }, finish_reason: finish }],
    usage: {
      prompt_tokens: result.usage?.inputTokens ?? 0,
      completion_tokens: result.usage?.outputTokens ?? 0,
      total_tokens: result.usage?.totalTokens ?? (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0)
    }
  };
}
