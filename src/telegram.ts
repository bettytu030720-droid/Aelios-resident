// Telegram pieces the Think messenger does not do the way we want:
//   - bubbles: a blank line in the reply starts a new Telegram message, posted as soon as
//     the paragraph is finished, instead of one message edited as it streams;
//   - the Worker's own Bot API calls (slash commands, webhook setup).

const DEFAULT_API_BASE = "https://api.telegram.org";
// sendMessage allows 4096 UTF-16 code units; leave room for markdown escapes.
const MAX_BUBBLE_CHARS = 3800;
const BUBBLE_BREAK = /\n[^\S\n]*\n\s*/;

/** Cut text over the Telegram limit at a newline or space. */
function cutLong(text: string): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > MAX_BUBBLE_CHARS) {
    const window = rest.slice(0, MAX_BUBBLE_CHARS);
    const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > MAX_BUBBLE_CHARS / 2 ? cut : MAX_BUBBLE_CHARS;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Split a reply into bubbles at blank lines. */
export function splitIntoBubbles(text: string): string[] {
  return text.split(BUBBLE_BREAK).flatMap(cutLong);
}

type PostedMessage = { id: string; threadId?: string };
type StreamPart = string | { type: string; text?: string };

/** The parts of the Chat SDK Telegram adapter the bubble stream uses. */
export type BubbleAdapter = {
  postMessage(threadId: string, message: { markdown: string }): Promise<PostedMessage>;
  startTyping(threadId: string): Promise<void>;
  stream?: unknown;
};

/**
 * Replace the adapter's post-and-edit streaming with bubbles: each paragraph is
 * sent as its own message the moment the next one starts, and the typing
 * indicator comes back on while the next paragraph is being written.
 */
/**
 * What happens when a reply's text is all in. `keepLast` can drop its last bubble (the placeholder for a reply
 * with no words, when a sticker is the reply); `after` posts what goes after the words (a sticker).
 */
export type BubbleEnd = {
  keepLast?(threadId: string, text: string): boolean;
  after?(threadId: string): Promise<PostedMessage | null>;
};

export function useBubbles(adapter: BubbleAdapter, end: BubbleEnd = {}): void {
  adapter.stream = async (
    threadId: string,
    textStream: AsyncIterable<StreamPart>,
    options?: { signal?: AbortSignal }
  ): Promise<PostedMessage | null> => {
    let buffer = "";
    let last: PostedMessage | null = null;
    const post = async (text: string) => {
      for (const bubble of splitIntoBubbles(text)) last = await adapter.postMessage(threadId, { markdown: bubble });
    };
    for await (const part of textStream) {
      if (options?.signal?.aborted) break;
      buffer += typeof part === "string" ? part : part.type === "markdown_text" ? (part.text ?? "") : "";
      for (let match = BUBBLE_BREAK.exec(buffer); match; match = BUBBLE_BREAK.exec(buffer)) {
        await post(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        void adapter.startTyping(threadId).catch(() => undefined);
      }
    }
    const keep = end.keepLast?.(threadId, buffer) ?? true;
    if (keep) await post(buffer);
    if (!options?.signal?.aborted && end.after) {
      const after = await end.after(threadId).catch(() => null);
      if (after) last = after;
      // The sticker that was to be the whole reply did not go out: say so after all.
      else if (!keep) await post(buffer);
    }
    return last;
  };
}

export type TelegramConfig = { token: string; apiBase?: string };

function apiBase(config: TelegramConfig): string {
  return config.apiBase?.trim() || DEFAULT_API_BASE;
}

async function call(config: TelegramConfig, method: string, payload: Record<string, unknown> | FormData): Promise<Response> {
  const form = payload instanceof FormData;
  return fetch(`${apiBase(config)}/bot${config.token}/${method}`, {
    method: "POST",
    headers: form ? undefined : { "content-type": "application/json" },
    body: form ? payload : JSON.stringify(payload)
  });
}

type Answer<T> = { ok: boolean; result?: T; description?: string };

async function answer<T>(response: Response): Promise<Answer<T>> {
  return ((await response.json().catch(() => null)) as Answer<T> | null) ?? { ok: false, description: `HTTP ${response.status}` };
}

/** Her chat id in a private chat's thread id ("telegram:42"); null for anything else. */
export function chatIdOf(threadId: string): string | null {
  return threadId.match(/^telegram:(-?\d+)$/)?.[1] ?? null;
}

/** How a file goes to a chat: as a sticker (WebM, WebP, TGS), an animation (GIF) or a photo. */
export type MediaKind = "sticker" | "animation" | "photo";

export function mediaKindOf(type: string): MediaKind {
  if (type === "image/gif") return "animation";
  if (type === "video/webm" || type === "image/webp" || type === "application/x-tgsticker") return "sticker";
  return "photo";
}

const EXTENSIONS: Record<string, string> = {
  "image/gif": "gif",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/webm": "webm",
  "application/x-tgsticker": "tgs"
};

type SentMedia = {
  message_id: number;
  sticker?: { file_id: string };
  animation?: { file_id: string };
  document?: { file_id: string };
  photo?: { file_id: string }[];
};

/**
 * A sticker, GIF or picture to a chat: by the file id Telegram already has, or uploaded. Returns the posted
 * message and the file id to send it by next time.
 */
export async function sendMedia(
  config: TelegramConfig,
  chatId: string,
  media: { kind: MediaKind; fileId?: string; file?: { bytes: Uint8Array; type: string }; emoji?: string }
): Promise<{ messageId: number; fileId: string | null } | { error: string }> {
  const method = { sticker: "sendSticker", animation: "sendAnimation", photo: "sendPhoto" }[media.kind];
  let payload: Record<string, unknown> | FormData;
  if (media.fileId) payload = { chat_id: chatId, [media.kind]: media.fileId };
  else if (media.file) {
    payload = new FormData();
    payload.set("chat_id", chatId);
    const name = `sticker.${EXTENSIONS[media.file.type] ?? "bin"}`;
    payload.set(media.kind, new Blob([media.file.bytes], { type: media.file.type }), name);
    if (media.kind === "sticker" && media.emoji) payload.set("emoji", media.emoji);
  } else return { error: "nothing to send" };
  const sent = await answer<SentMedia>(await call(config, method, payload));
  if (!sent.ok || !sent.result) return { error: sent.description ?? `${method} failed` };
  const result = sent.result;
  const fileId = result.sticker?.file_id ?? result.animation?.file_id ?? result.document?.file_id ?? result.photo?.at(-1)?.file_id ?? null;
  return { messageId: result.message_id, fileId };
}

export type TelegramSticker = {
  file_id: string;
  emoji?: string;
  is_animated?: boolean;
  is_video?: boolean;
  thumbnail?: { file_id: string };
};

export type TelegramStickerSet = { name: string; title: string; sticker_type?: string; stickers: TelegramSticker[] };

export async function getStickerSet(config: TelegramConfig, name: string): Promise<TelegramStickerSet | { error: string }> {
  const set = await answer<TelegramStickerSet>(await call(config, "getStickerSet", { name }));
  return set.ok && set.result ? set.result : { error: set.description ?? "getStickerSet failed" };
}

/** A file the bot can see, downloaded; null when it is gone or larger than `limit`. */
export async function downloadFile(config: TelegramConfig, fileId: string, limit: number): Promise<Uint8Array | null> {
  const file = await answer<{ file_path?: string; file_size?: number }>(await call(config, "getFile", { file_id: fileId }));
  const path = file.result?.file_path;
  if (!file.ok || !path || (file.result?.file_size ?? 0) > limit) return null;
  const response = await fetch(`${apiBase(config)}/file/bot${config.token}/${path}`);
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.length && bytes.length <= limit ? bytes : null;
}

/** Plain text from the Worker itself (slash command answers); `bubbles: false` keeps blank lines in one message. */
export async function sendBubbles(
  config: TelegramConfig,
  chatId: string,
  text: string,
  { bubbles = true }: { bubbles?: boolean } = {}
): Promise<void> {
  const parts = bubbles ? splitIntoBubbles(text) : cutLong(text);
  for (const bubble of parts) {
    const response = await call(config, "sendMessage", { chat_id: chatId, text: bubble });
    if (!response.ok) console.error("tg: sendMessage failed", { status: response.status });
  }
}

export const COMMANDS = [
  { command: "status", description: "看模型、对话长度和交接信" },
  { command: "letter", description: "看最近一封交接信" },
  { command: "handoff", description: "现在就写交接信，把旧聊天收起来" }
];

/** The text on the bot's menu button that opens the web page as a Mini App. */
export const MENU_BUTTON_TEXT = "打开网页";

/**
 * Points the webhook here and lists the commands. With `miniAppUrl` (it must be https), the bot's default menu
 * button opens that page as a Mini App; without, the menu button is left alone.
 */
export async function setWebhook(
  config: TelegramConfig,
  url: string,
  secret: string,
  { miniAppUrl }: { miniAppUrl?: string } = {}
): Promise<Record<string, unknown>> {
  const webhook = await call(config, "setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message"]
  });
  const commands = await call(config, "setMyCommands", { commands: COMMANDS });
  const result: Record<string, unknown> = { setWebhook: await webhook.json(), setMyCommands: await commands.json() };
  if (miniAppUrl) {
    const menu = await call(config, "setChatMenuButton", {
      menu_button: { type: "web_app", text: MENU_BUTTON_TEXT, web_app: { url: miniAppUrl } }
    });
    result.setChatMenuButton = await menu.json().catch(() => ({ ok: false, status: menu.status }));
  }
  return result;
}

/** The parts of a Telegram update the Worker reads before handing it to the resident. */
export type TelegramUpdate = {
  update_id?: number;
  message?: {
    message_id?: number;
    text?: string;
    from?: { id?: number; is_bot?: boolean; username?: string };
    chat?: { id?: number | string; type?: string };
  };
};

/** "/status" or "/status@my_bot" → "status"; anything else → null. */
export function commandOf(text: string | undefined): string | null {
  const match = text?.trim().match(/^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i);
  return match ? match[1].toLowerCase() : null;
}

export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}

/** TG_ALLOWED: comma-separated chat ids and/or @usernames. Empty lets nobody in. */
export function isAllowed(allowed: string | undefined, chatId: string, username: string | undefined): boolean {
  const entries = (allowed ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (entries.includes(chatId)) return true;
  return Boolean(username && entries.includes(`@${username.toLowerCase()}`));
}
