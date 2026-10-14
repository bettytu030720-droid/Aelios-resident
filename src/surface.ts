// Recall that comes up by itself ("浮现"): before each reply, her latest message is searched in Aelios and
// the hits that have not come up lately ride along with that message, marked as something the resident remembered.
//
// The text is kept per message and put back on the same message on every later turn, so the history the
// model sees only ever grows at the end. That keeps the prompt cache hitting, and keeps Claude's thinking
// blocks valid (they are bound to everything said before them). The web page, Telegram and what goes back
// into Aelios never see it: only the model does.

import type { ModelMessage, UserModelMessage } from "ai";
import type { RecallHit } from "./aelios";

// At most this many memories come up for one message.
export const SURFACE_HITS = 4;
// A memory that came up for one of this many recent messages does not come up again.
export const SURFACE_RECENT = 20;
// Recalls kept, newest first. Older ones belong to turns already folded into a handoff letter.
export const SURFACE_KEEP = 500;
// A slow Aelios must not hold up the reply.
export const SURFACE_TIMEOUT_MS = 5000;
const HIT_MAX_CHARS = 300;

export const SURFACE_OPEN = "<recalled>";

/** The text of a user message, as the key its recall is kept under. */
export function userText(message: UserModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

export async function keyOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What rides along with her message, or "" when nothing came up. */
export function surfaceText(hits: RecallHit[]): string {
  if (!hits.length) return "";
  const clip = (text: string) => (text.length > HIT_MAX_CHARS ? `${text.slice(0, HIT_MAX_CHARS)}…` : text);
  return [SURFACE_OPEN, ...hits.map((hit) => `- ${clip(hit.content.trim())}`), "</recalled>"].join("\n");
}

/** The message with the recall after her words, as one more text part. */
export function withSurface(message: UserModelMessage, text: string): ModelMessage {
  const parts = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
  return { ...message, content: [...parts, { type: "text", text }] };
}
