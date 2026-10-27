// Photos she sends on Telegram or WeCom, as pictures the model can see. Think lists a messenger message's
// attachments only as a line of text (id, type, size), so the resident downloads the pictures itself
// and puts them into her message.

import { toMessengerUserMessage, type MessengerAttachment, type MessengerContext, type MessengerMessage } from "@cloudflare/think/messengers";
import type { UIMessage } from "ai";
import { sniff } from "./stickers";

/** Larger files are not downloaded: Telegram lets a bot download up to 20 MB. */
export const PICTURE_MAX_BYTES = 20 * 1024 * 1024;
/** What goes to the model at most: 3.75 MB, which is 5 MB in base64, the most Claude takes for one picture. */
export const PICTURE_SEND_BYTES = 3.75 * 1024 * 1024;
/**
 * The longest side a picture goes at. Claude scales anything bigger down to about this itself, so a phone's
 * full-size photo only makes every request that carries it heavier (and may be refused for its size).
 */
export const PICTURE_MAX_EDGE = 1568;

/** Downloads one file she sent, by its id on that door (Telegram file id, WeCom MediaId). */
export type Download = (fileId: string) => Promise<ArrayBuffer | Uint8Array>;
/** Makes a picture smaller, or null when it is small enough already or cannot be read. */
export type Shrink = (bytes: Uint8Array) => Promise<Uint8Array | null>;

function isPicture(attachment: MessengerAttachment): boolean {
  return Boolean(attachment.mediaType?.startsWith("image/") && attachment.fetchMetadata?.fileId) && (attachment.size ?? 0) <= PICTURE_MAX_BYTES;
}

const streamOf = (bytes: Uint8Array) => new Response(bytes).body!;

/**
 * Shrinking with Cloudflare Images (the IMAGES binding): a picture longer than PICTURE_MAX_EDGE on a side, or
 * heavier than PICTURE_SEND_BYTES, is scaled down to fit, as JPEG (a photo) or WebP (anything else, which keeps a
 * see-through background). Null without the binding: pictures then go as they are, up to PICTURE_SEND_BYTES.
 */
export function shrinkWith(images: ImagesBinding | undefined): Shrink | null {
  if (!images) return null;
  return async (bytes) => {
    const info = await images.info(streamOf(bytes));
    if (!("width" in info) || !info.width || !info.height) return null;
    if (Math.max(info.width, info.height) <= PICTURE_MAX_EDGE && bytes.length <= PICTURE_SEND_BYTES) return null;
    const format = info.format === "image/jpeg" ? "image/jpeg" : "image/webp";
    const result = await images
      .input(streamOf(bytes))
      .transform({ width: PICTURE_MAX_EDGE, height: PICTURE_MAX_EDGE, fit: "scale-down" })
      .output({ format, quality: 85 });
    const smaller = new Uint8Array(await new Response(result.image()).arrayBuffer());
    return smaller.length ? smaller : null;
  };
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/**
 * Her message with the pictures she sent in it, after her words. What did not come down (too large, a
 * failed download, not a picture) stays listed as text, as Think lists it.
 */
export async function withPictures(message: UIMessage, context: MessengerContext, download: Download, shrink: Shrink | null = null): Promise<UIMessage> {
  const sent = [...(context.skipped ?? []), ...(context.message ? [context.message] : [])];
  const pictures: UIMessage["parts"] = [];
  const shown = new Set<MessengerAttachment>();
  for (const attachment of sent.flatMap((entry) => entry.attachments).filter(isPicture)) {
    try {
      const data = await download(attachment.fetchMetadata!.fileId);
      let bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (!bytes.length || bytes.length > PICTURE_MAX_BYTES) continue;
      if (shrink) {
        // A picture Images cannot read goes as it came; the model says what it makes of it.
        const smaller = await shrink(bytes).catch((error) => (console.error("pictures: could not shrink", { error: String(error) }), null));
        if (smaller) bytes = smaller;
      }
      if (bytes.length > PICTURE_SEND_BYTES) continue;
      // What the picture is, not what the message said: WeCom says JPEG for a PNG too, and Claude checks.
      const found = sniff(bytes);
      const mediaType = found?.startsWith("image/") ? found : attachment.mediaType!;
      pictures.push({ type: "file", mediaType, url: `data:${mediaType};base64,${base64(bytes)}` });
      shown.add(attachment);
    } catch (error) {
      console.error("tg: could not download a picture", { error: String(error) });
    }
  }
  if (!pictures.length) return message;
  const rest = (entry: MessengerMessage): MessengerMessage => ({ ...entry, attachments: entry.attachments.filter((a) => !shown.has(a)) });
  const listed = toMessengerUserMessage({ ...context, message: context.message && rest(context.message), skipped: context.skipped?.map(rest) });
  return { ...message, parts: [...listed.parts, ...pictures] };
}
