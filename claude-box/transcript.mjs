// The parts of the Claude box that touch no SDK: the transcript a turn resumes from, what a turn wrote, and the
// reply as one Messages API stream. Kept apart so the resident's tests can load them without Claude Code.

import { randomUUID } from "node:crypto";

// Entries that make up the conversation Claude Code sends; bookkeeping lines (costs, queue, titles) are left out.
const CHAIN = new Set(["user", "assistant", "attachment"]);

// The MCP server the resident's tools come through: Claude Code names them mcp__resident__<tool>.
export const TOOL_SERVER = "resident";
const TOOL_PREFIX = `mcp__${TOOL_SERVER}__`;
// Claude Code's limit on a tool's whole name, prefix included.
const TOOL_NAME_MAX = 64;

/** The resident's tools (Messages API definitions) as the turn's MCP server lists them; ones it cannot name are left out. */
export function toolsFor(tools) {
  const out = [];
  const seen = new Set();
  for (const tool of tools) {
    const name = tool?.name;
    if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name) || TOOL_PREFIX.length + name.length > TOOL_NAME_MAX || seen.has(name)) continue;
    seen.add(name);
    const schema = tool.input_schema && typeof tool.input_schema === "object" ? tool.input_schema : { type: "object", properties: {} };
    out.push({ name, ...(typeof tool.description === "string" ? { description: tool.description } : {}), inputSchema: schema });
  }
  return out;
}

/** A message the box never saw, as a transcript entry. */
function written({ role, content }, model, timestamp) {
  const uuid = randomUUID();
  const base = { isSidechain: false, type: role, uuid, timestamp, userType: "external" };
  if (role === "user") return { ...base, message: { role: "user", content } };
  return {
    ...base,
    message: {
      id: `msg_resident_${uuid.replace(/-/g, "")}`,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  };
}

/** The transcript Claude Code resumes from: one chain, oldest first, in this turn's session and working directory. */
export function transcript(history, { sessionId, model, cwd, now = Date.now() }) {
  const out = [];
  let at = now - 60_000;
  for (const item of history) {
    if (Array.isArray(item?.entries)) {
      for (const entry of item.entries) {
        if (entry && typeof entry === "object" && CHAIN.has(entry.type)) out.push({ ...entry });
      }
    } else if ((item?.role === "user" || item?.role === "assistant") && Array.isArray(item.content)) {
      // Never before the entries it follows: Claude Code reads the chain, but keep the times in order anyway.
      const last = out.at(-1)?.timestamp;
      const time = typeof last === "string" && Date.parse(last) >= at ? last : new Date(at).toISOString();
      out.push(written(item, model, time));
      at += 1;
    }
  }
  let parent = null;
  for (const entry of out) {
    if (typeof entry.uuid !== "string") entry.uuid = randomUUID();
    entry.parentUuid = parent;
    entry.sessionId = sessionId;
    entry.cwd = cwd;
    parent = entry.uuid;
  }
  return out;
}

const TOLD_MAX = 4000;

function clip(text) {
  return text.length > TOLD_MAX ? `${text.slice(0, TOLD_MAX)}…` : text;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block?.type === "text" ? String(block.text ?? "") : block?.type === "image" ? "[图片]" : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Calls the transcript never answers, and results no running turn is waiting for (the box restarted, or waited too
 * long), as lines of text, the way the resident writes the tool calls of a turn the box never saw. Claude Code would
 * otherwise call such a call interrupted. The same calls are told the same way on every later turn.
 */
export function settle(entries, prompt) {
  const answered = new Set();
  for (const entry of entries) {
    if (entry.type !== "user" || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content) if (block?.type === "tool_result") answered.add(block.tool_use_id);
  }
  const open = (block) => block?.type === "tool_use" && !answered.has(block.id);
  const settled = entries.map((entry) => {
    const content = entry.type === "assistant" ? entry.message?.content : null;
    if (!Array.isArray(content) || !content.some(open)) return entry;
    const told = content.map((block) =>
      open(block) ? { type: "text", text: clip(`[用了工具 ${String(block.name ?? "").replace(TOOL_PREFIX, "")}：${JSON.stringify(block.input ?? {})}]`) } : block
    );
    return { ...entry, message: { ...entry.message, content: told } };
  });
  const told = prompt.map((block) =>
    block?.type === "tool_result" ? { type: "text", text: clip(`[工具的结果${block.is_error ? "（出错）" : ""}]\n${textOf(block.content)}`) } : block
  );
  return { entries: settled, prompt: told };
}

/** The resident's result for a call (a Messages API tool_result block), as the MCP server answers the call with it. */
export function callResult(block) {
  const content = [];
  for (const part of typeof block?.content === "string" ? [{ type: "text", text: block.content }] : Array.isArray(block?.content) ? block.content : []) {
    if (part?.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
    else if (part?.type === "image" && part.source?.type === "base64") content.push({ type: "image", data: part.source.data, mimeType: part.source.media_type });
    else if (part && typeof part === "object") content.push({ type: "text", text: JSON.stringify(part) });
  }
  return { content: content.length ? content : [{ type: "text", text: "" }], ...(block?.is_error ? { isError: true } : {}) };
}

/** What Claude Code appended for this turn, split into her turn (with what it attached to it) and its reply. */
export function turnEntries(appended) {
  const chain = appended.filter((entry) => entry && CHAIN.has(entry.type) && typeof entry.uuid === "string");
  const start = chain.findIndex((entry) => entry.type === "user" && !entry.isMeta);
  const mine = start < 0 ? chain : chain.slice(start);
  const reply = mine.findIndex((entry) => entry.type === "assistant");
  if (reply < 0) return { prompt: mine, reply: [] };
  // The reply is the assistant's entries (one per block). The results of its calls are the next turn's prompt.
  let end = reply;
  while (end < mine.length && mine[end].type === "assistant") end += 1;
  return { prompt: mine.slice(0, reply), reply: mine.slice(reply, end) };
}

/**
 * The events of the reply as one Messages API stream, the resident's tools under their own names. A reply is one
 * request of Claude Code's, but should it make another before the resident has answered (a call it answered itself),
 * its blocks follow the first message's under new indices, and one message_stop ends it.
 */
export function replyStream(send) {
  let opened = false;
  let offset = 0;
  let next = 0;
  let delta = null;
  // The resident's calls in the reply: { id, name } each.
  const uses = [];
  return {
    uses,
    /** Whether the reply stopped to call a tool. */
    get calls() {
      return delta?.delta?.stop_reason === "tool_use";
    },
    event(event) {
      switch (event?.type) {
        case "message_start":
          if (!opened) send(event);
          else offset = next;
          opened = true;
          return;
        case "content_block_start":
        case "content_block_delta":
        case "content_block_stop": {
          if (!opened) return;
          const index = event.index + offset;
          next = Math.max(next, index + 1);
          const block = event.content_block;
          if (block?.type === "tool_use" && typeof block.name === "string" && block.name.startsWith(TOOL_PREFIX)) {
            const name = block.name.slice(TOOL_PREFIX.length);
            uses.push({ id: block.id, name });
            send({ ...event, index, content_block: { ...block, name } });
          } else send({ ...event, index });
          return;
        }
        case "message_delta":
          delta = delta ? { ...event, usage: { ...delta.usage, ...event.usage } } : event;
          return;
        case "message_stop":
          return;
        default:
          if (opened && event?.type) send(event);
      }
    },
    /** Closes the stream; false when nothing was ever streamed. */
    end() {
      if (!opened) return false;
      if (delta) send(delta);
      send({ type: "message_stop" });
      return true;
    }
  };
}

/**
 * The last line of a turn. A failed turn ends with its error and the reply left open: no message_stop says it
 * finished, so what streamed before reads as cut off. A turn that answered closes the reply, then sends what it wrote.
 */
export function lastLine(stream, failure, appended) {
  if (failure) return { error: failure };
  if (!stream.end()) return { error: "Claude Code answered nothing" };
  return { done: turnEntries(appended) };
}
