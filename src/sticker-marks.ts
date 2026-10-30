// A sticker it sends is a mark in its reply, [sticker: pack/name], not a tool call, so a sticker costs no second
// call to the model. The list it picks from is in the system prompt (stickerRules, stickers.ts). The mark is taken
// out of its words wherever they go (Telegram, WeCom, the web page, a group, a voice message, a push), and the
// sticker goes right after the paragraph it was in. One per reply: a mark after the first sticker that went out is
// only taken out.

/** A mark of a sticker in a reply. Global: use it with replace, not test. */
export const SENT_STICKER = /\[sticker:\s*([^\]\n]*?)\s*\]/gi;
// A mark still being written, at the end of a reply that is coming in.
const OPEN_MARK = /\[sticker:[^\]\n]*$/i;

/** The words without their marks, and the stickers the marks named (pack/name), in order. */
export function stickerMarks(text: string): { text: string; stickers: string[] } {
  if (!/\[sticker:/i.test(text)) return { text, stickers: [] };
  const stickers: string[] = [];
  const words = text.replace(SENT_STICKER, (_, handle: string) => {
    if (handle) stickers.push(handle);
    return "";
  });
  return { text: tidy(words), stickers };
}

/** The words of a reply as they show, while it is coming in too: without its marks, a half-written one included. */
export function withoutStickerMarks(text: string): string {
  return /\[sticker:/i.test(text) ? tidy(text.replace(SENT_STICKER, "").replace(OPEN_MARK, "")) : text;
}

/** No spaces left at a line's end or blank lines piled up where a mark was. */
function tidy(text: string): string {
  return text.replace(/[^\S\n]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}
