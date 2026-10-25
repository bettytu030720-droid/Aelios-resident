// Which turns a handoff letter folds away. Chinese characters count roughly as one token;
// other text as a quarter. The automatic trigger and the retained recent chat are separate quantities.
import type { CompactionFunction, SessionMessage } from "agents/sessions";

/** Fixed recent original chat retained after a letter. Whole exchanges may take it a little over. */
export const LETTER_KEEP_TOKENS = 8000;
export const DEFAULT_LETTER_TOKEN_THRESHOLD = 30000;

/** Ignore invalid Worker variables too, not only invalid values submitted through the settings page. */
export function letterTokenThreshold(value: string | undefined): number {
  const tokens = Number(value);
  return Number.isSafeInteger(tokens) && tokens > LETTER_KEEP_TOKENS ? tokens : DEFAULT_LETTER_TOKEN_THRESHOLD;
}
/** Role and framing of one message. */
const PER_MESSAGE = 4;
/** A picture she sent, about what Claude charges for a photo of the size Telegram sends. */
const PER_PICTURE = 1600;
/** Chinese, Japanese and Korean characters (with their punctuation and full-width forms): about a token each. */
const WIDE = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]|[\u{20000}-\u{3134f}]/gu;

/** Tokens in a piece of text: one for each wide character, one for each 4 other characters. */
export function tokensIn(text: string): number {
  let wide = 0;
  let wideLength = 0;
  for (const match of text.matchAll(WIDE)) {
    wide += 1;
    wideLength += match[0].length;
  }
  return Math.ceil(wide + (text.length - wideLength) / 4);
}

function tokensOfValue(value: unknown): number {
  if (value === undefined || value === null) return 0;
  return tokensIn(typeof value === "string" ? value : JSON.stringify(value));
}

/**
 * Tokens one message adds to a request: its text, pictures, and tool calls with their results. Thinking is left
 * out: earlier turns' thinking is not sent to Claude again (claude-run.ts).
 */
export function tokensOf(message: SessionMessage): number {
  let tokens = PER_MESSAGE;
  for (const part of message.parts as { type: string; text?: string; input?: unknown; output?: unknown }[]) {
    if (part.type === "text") tokens += tokensIn(part.text ?? "");
    else if (part.type === "file") tokens += PER_PICTURE;
    else if (part.type.startsWith("tool-") || part.type === "dynamic-tool") tokens += tokensOfValue(part.input) + tokensOfValue(part.output);
  }
  return tokens;
}

/** Current carried chat, including previous letters, images and tool results, but not system/tool definitions. */
export function chatTokens(messages: readonly SessionMessage[]): number {
  return messages.reduce((sum, message) => sum + tokensOf(message), 0);
}

export function reachesLetterThreshold(messages: readonly SessionMessage[], threshold: number): boolean {
  return chatTokens(messages) >= threshold;
}

const isLetter = (message: SessionMessage) => message.id.startsWith("compaction_");

/**
 * Where the kept part starts: the most recent keepRecentTokens, at least her last message and its answer,
 * beginning with her message so no answer is kept without what it answers.
 */
export function keptFrom(messages: SessionMessage[], keepRecentTokens = LETTER_KEEP_TOKENS): number {
  let cut = messages.length;
  let kept = 0;
  while (cut > 0) {
    // Budget whole exchanges, not individual messages: a tiny assistant reply must not pull in another
    // large user message after the budget has already been filled by the two most recent exchanges.
    let start = cut - 1;
    while (start > 0 && messages[start].role !== "user") start -= 1;
    while (start > 0 && messages[start - 1].role === "user") start -= 1;
    const next = chatTokens(messages.slice(start, cut));
    if (kept + next > keepRecentTokens && cut < messages.length) break;
    kept += next;
    cut = start;
  }
  return cut;
}

/**
 * Everything before the fixed recent-chat window goes into the letter, including the conversation's start.
 * Earlier letters are already in the model's context, but their synthetic ids cannot be compaction endpoints.
 * `short` is told when there is no original chat to fold.
 */
export function foldIntoLetter(
  write: (range: { fromMessageId: string; toMessageId: string }) => Promise<string>,
  short?: () => void
): CompactionFunction {
  return async (messages) => {
    const older = messages.slice(0, keptFrom(messages)).filter((message) => !isLetter(message));
    if (!older.length) {
      console.log("letter: nothing older than the kept part to fold yet", {
        carried: chatTokens(messages),
        keepRecentTokens: LETTER_KEEP_TOKENS
      });
      short?.();
      return null;
    }
    const range = { fromMessageId: older[0].id, toMessageId: older[older.length - 1].id };
    const letter = await write(range);
    if (!letter.trim()) return null;
    return { ...range, summary: letter };
  };
}
