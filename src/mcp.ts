// A small MCP client: one tools/call over Streamable HTTP, for servers that answer without a session
// (Aelios' /mcp does). The resident wraps the few tools it uses with its own short descriptions,
// instead of loading every tool of a server, long descriptions and all, into each turn.

type McpContent = { type: string; text?: string };
type McpMessage = {
  result?: { content?: McpContent[]; isError?: boolean };
  error?: { code?: number; message?: string };
};

function parse(text: string): McpMessage | null {
  try {
    return JSON.parse(text) as McpMessage;
  } catch {
    return null;
  }
}

/** Call one tool and return its text. Throws when the server, the call or the tool fails. */
export async function callMcpTool(
  endpoint: string,
  key: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal
  });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const raw = await response.text();
  // A server may answer with an SSE stream instead of plain JSON: the answer is the event with a result or an error.
  const message = (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ? (raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => parse(line.slice(5).trim()))
        .find((event) => event && (event.result || event.error)) ?? null)
    : parse(raw);
  if (!message) throw new Error(`${name}: no answer in the response`);
  if (message.error) throw new Error(`${name}: ${message.error.message ?? "MCP error"}`);
  const text = (message.result?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  if (message.result?.isError) throw new Error(text || `${name} failed`);
  return text;
}
