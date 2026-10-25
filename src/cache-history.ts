// Read-time reductions belong to a cache window, not to the age of a message on each new turn.
// The caller persists cutoff once per window. Appending messages must never move that boundary.
import { createHash } from "node:crypto";
import type { ModelMessage, ToolResultPart } from "ai";

const KEEP_RECENT = 8;
const TOOL_CHARS = 500;
const MEDIA_NOTE = "[Earlier media omitted from this cache window; the original remains in chat history.]";

/** Keep the recent messages in full, and keep EVERY new message in full until the window closes. */
export function historyCutoff(messages: readonly ModelMessage[]): number {
  let cutoff = Math.max(0, messages.length - KEEP_RECENT);
  // Do not switch fidelity halfway through an exchange or a tool call/result chain.
  while (cutoff > 0 && messages[cutoff].role !== "user") cutoff -= 1;
  return cutoff;
}

/** Detect a non-append change (branch, deletion, hydration sliding) before reusing an array coordinate.
 * Only a digest is persisted. Hash one message at a time; do not duplicate the whole hydrated history.
 */
export function historyAnchor(messages: readonly ModelMessage[], cutoff: number): string {
  const hash = createHash("sha256");
  for (let i = 0; i < cutoff; i += 1) {
    hash.update(JSON.stringify(messages[i], (_key, value: unknown) => {
      if (value instanceof Uint8Array) return { bytes: value.byteLength, sha256: createHash("sha256").update(value).digest("hex") };
      if (value instanceof ArrayBuffer) return { bytes: value.byteLength, sha256: createHash("sha256").update(new Uint8Array(value)).digest("hex") };
      return value;
    }));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function shortened(text: string): string {
  if (text.length <= TOOL_CHARS) return text;
  const suffix = `... [truncated ${text.length} chars]`;
  return text.slice(0, TOOL_CHARS - suffix.length) + suffix;
}

/** Reduce the model-facing result only; never rewrite the stored tool result or call arguments. */
function compactOutput(output: ToolResultPart["output"]): ToolResultPart["output"] {
  switch (output.type) {
    case "text":
    case "error-text": {
      const value = shortened(output.value);
      return value === output.value ? output : { ...output, value };
    }
    case "json":
    case "error-json": {
      const text = JSON.stringify(output.value);
      if (text.length <= TOOL_CHARS) return output;
      return { type: output.type === "json" ? "text" : "error-text", value: shortened(text) };
    }
    case "content": {
      // Content results can include screenshots/files. Do not serialize their binary payload into text.
      const text = output.value.map((part) => part.type === "text" ? part.text : MEDIA_NOTE).join("\n");
      if (output.value.every((part) => part.type === "text") && text.length <= TOOL_CHARS) return output;
      return { type: "text", value: shortened(text) };
    }
    default:
      return output;
  }
}

/** A pure view: original messages, images and tool outputs remain untouched in Sessions. */
export function historyForWindow(messages: ModelMessage[], cutoff: number): ModelMessage[] {
  // The provider-executed flag lives on the CALL, not ToolResultPart. Match repeated IDs in order.
  const nativeCalls = new Map<string, boolean[]>();
  return messages.map((message, i): ModelMessage => {
    if (i >= cutoff) return message;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type !== "tool-call") continue;
        const calls = nativeCalls.get(part.toolCallId) ?? [];
        calls.push(part.providerExecuted === true);
        nativeCalls.set(part.toolCallId, calls);
      }
    }
    if (message.role === "tool") {
      return {
        ...message,
        content: message.content.map((part) => {
          if (part.type !== "tool-result" || nativeCalls.get(part.toolCallId)?.shift()) return part;
          return { ...part, output: compactOutput(part.output) };
        })
      };
    }
    if (message.role === "user" && Array.isArray(message.content)) {
      return {
        ...message,
        content: message.content.map((part) => part.type === "image" || part.type === "file" ? { type: "text" as const, text: MEDIA_NOTE } : part)
      };
    }
    return message;
  });
}
