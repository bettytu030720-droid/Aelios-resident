// A picture the model's provider will not take (a content check, a size or a format it refuses) fails the turn. It
// stays in her message, so every turn after it carries it and fails the same way, whatever she says; deleting it on
// Telegram does not reach the resident. So when a turn is refused like that, the pictures in her messages that were
// not answered yet come out, a line saying so takes their place, and she is told on her door.

import type { UIMessage } from "ai";

/** Statuses that refuse what was sent. Not 401 (the key), 402 (the bill), 404 (the model's name), 429 or 5xx. */
const REFUSING = new Set([400, 403, 413, 415, 422]);
/** A 400 is the picture's fault only when it says so; otherwise it is about something else in the request. */
const ABOUT_PICTURES = /image|picture|photo|media|vision/i;
/** When she has no unanswered picture, the pictures among this many latest messages (what the model still sees). */
const RECENT = 8;

/** What takes a refused picture's place in her message: read by the model, shown as 「[图片被退回]」 on the web page. */
export const REFUSED_NOTE = (reason: string) => `[Picture taken out unseen: the model's provider refused it (${reason}).]`;
export const REFUSED_PICTURE = /\[Picture taken out unseen: [^\]]*\]/g;

type Failure = { statusCode?: unknown; message?: unknown; responseBody?: unknown };

/** The provider's own name for the error (permission_error, invalid_request_error), from an Anthropic or OpenAI body. */
function errorType(body: unknown): string | null {
  if (typeof body !== "string") return null;
  try {
    const error = (JSON.parse(body) as { error?: { type?: unknown; code?: unknown } } | null)?.error;
    const type = error?.type ?? error?.code;
    return typeof type === "string" && /^[\w.-]{1,40}$/.test(type) ? type : null;
  } catch {
    return null;
  }
}

/**
 * Why the provider refused this turn, in a few words, when a picture may be why ("403 permission_error"); null for
 * a failure a picture cannot cause.
 */
export function refusalOf(error: unknown): string | null {
  const failure = (error && typeof error === "object" ? error : {}) as Failure;
  const status = typeof failure.statusCode === "number" ? failure.statusCode : null;
  if (status === null || !REFUSING.has(status)) return null;
  const said = [failure.message, failure.responseBody].filter((part) => typeof part === "string").join(" ");
  if (status === 400 && !ABOUT_PICTURES.test(said)) return null;
  const type = errorType(failure.responseBody);
  return type ? `${status} ${type}` : String(status);
}

const isPicture = (part: UIMessage["parts"][number]) =>
  part.type === "file" && typeof part.mediaType === "string" && part.mediaType.startsWith("image/");

/** Whether an assistant message said or did anything: a failed turn can leave one with nothing in it. */
function answered(message: UIMessage): boolean {
  return message.role === "assistant" && message.parts.some((part) =>
    (part.type === "text" && part.text.trim() !== "") || part.type.startsWith("tool-") || part.type === "dynamic-tool");
}

/**
 * Her messages to take the pictures out of, each with the pictures replaced by the note: the ones after the last
 * answer; when none of those has a picture, the latest few messages (a picture answered under another model).
 */
export function withoutRefused(messages: readonly UIMessage[], reason: string): UIMessage[] {
  const last = messages.findLastIndex(answered);
  const unanswered = messages.slice(last + 1);
  const pool = unanswered.some((message) => message.role === "user" && message.parts.some(isPicture))
    ? unanswered
    : messages.slice(-RECENT);
  const note = REFUSED_NOTE(reason);
  return pool
    .filter((message) => message.role === "user" && message.parts.some(isPicture))
    .map((message) => ({ ...message, parts: message.parts.map((part) => (isPicture(part) ? { type: "text" as const, text: note } : part)) }));
}

/** What she is told on her door. */
export function refusedNotice(reason: string): string {
  return `刚才那轮被模型那边退回了（${reason}），你发的图我没看到。图已经从聊天里拿掉，接着说就好；想让我看的话，换张图或者换个模型再发。`;
}
