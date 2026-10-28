// The parts of the Claude box that touch no SDK: the transcript a turn resumes from, what a turn wrote, and the
// reply as one Messages API stream. Kept apart so the resident's tests can load them without Claude Code.

import { randomUUID } from "node:crypto";

// Entries that make up the conversation Claude Code sends; bookkeeping lines (costs, queue, titles) are left out.
const CHAIN = new Set(["user", "assistant", "attachment"]);

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

/** What Claude Code appended for this turn, split into her turn (with what it attached to it) and its reply. */
export function turnEntries(appended) {
  const chain = appended.filter((entry) => entry && CHAIN.has(entry.type) && typeof entry.uuid === "string");
  const start = chain.findIndex((entry) => entry.type === "user" && !entry.isMeta);
  const mine = start < 0 ? chain : chain.slice(start);
  const reply = mine.findIndex((entry) => entry.type === "assistant");
  return reply < 0 ? { prompt: mine, reply: [] } : { prompt: mine.slice(0, reply), reply: mine.slice(reply) };
}

/**
 * The events of the reply as one Messages API stream. Claude Code makes one request per turn here (no tools), but
 * should it make another, its blocks follow the first message's under new indices, and one message_stop ends it.
 */
export function replyStream(send) {
  let opened = false;
  let offset = 0;
  let next = 0;
  let delta = null;
  return {
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
          send({ ...event, index });
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
