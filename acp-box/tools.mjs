// The resident's tools as the box's MCP server offers them to Kiro: the list, a result for a call, and the server's
// JSON-RPC (Streamable HTTP as plain JSON). Same shape as claude-box/transcript.mjs; each box is installed on its own,
// so the few lines are kept in both.

// The name of the MCP server: a helper shows its tools under it (Kiro: `@resident/<tool>`).
export const TOOL_SERVER = "resident";

// Kiro shows a tool as `@resident/<name>`; the names are kept short and plain.
const TOOL_NAME_MAX = 48;

/** The resident's tools (Messages API definitions) as the server lists them; ones it cannot name are left out. */
export function toolsFor(tools) {
  const out = [];
  const seen = new Set();
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = tool?.name;
    if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name) || name.length > TOOL_NAME_MAX || seen.has(name)) continue;
    seen.add(name);
    const schema = tool.input_schema && typeof tool.input_schema === "object" ? tool.input_schema : { type: "object", properties: {} };
    out.push({ name, ...(typeof tool.description === "string" ? { description: tool.description } : {}), inputSchema: schema });
  }
  return out;
}

/** The resident's result for a call (a Messages API tool_result block), as the server answers the call with it. */
export function callResult(block) {
  const content = [];
  for (const part of typeof block?.content === "string" ? [{ type: "text", text: block.content }] : Array.isArray(block?.content) ? block.content : []) {
    if (part?.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
    else if (part?.type === "image" && part.source?.type === "base64") content.push({ type: "image", data: part.source.data, mimeType: part.source.media_type });
    else if (part && typeof part === "object") content.push({ type: "text", text: JSON.stringify(part) });
  }
  return { content: content.length ? content : [{ type: "text", text: "" }], ...(block?.is_error ? { isError: true } : {}) };
}

/** One JSON-RPC message of Kiro's to a run's server: the answer, or null for a notification. `run` has `tools` and `call`. */
export async function mcp(run, message, signal) {
  if (!message || typeof message !== "object" || message.id === undefined || message.id === null) return null;
  const answer = (result) => ({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      return answer({
        protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: TOOL_SERVER, version: "1" }
      });
    case "ping":
      return answer({});
    case "tools/list":
      return answer({ tools: run.tools });
    case "tools/call":
      return answer(await run.call(message.params, signal));
    default:
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${String(message.method)}` } };
  }
}
