// Photos she sends on Telegram or WeCom, as pictures the model can see. Think lists a messenger message's
// attachments only as a line of text (id, type, size), so the resident downloads the pictures itself
// and puts them into her message.

import { toMessengerUserMessage, type MessengerAttachment, type MessengerContext, type MessengerMessage } from "@cloudflare/think/messengers";
import type { UIMessage } from "ai";
import { sniff } from "./stickers";

/** Larger pictures stay a line of text: Claude takes images up to 5 MB. */
export const PICTURE_MAX_BYTES = 5 * 1024 * 1024;

/** Downloads one file she sent, by its id on that door (Telegram file id, WeCom MediaId). */
export type Download = (fileId: string) => Promise<ArrayBuffer | Uint8Array>;

function isPicture(attachment: MessengerAttachment): boolean {
  return Boolean(attachment.mediaType?.startsWith("image/") && attachment.fetchMetadata?.fileId) && (attachment.size ?? 0) <= PICTURE_MAX_BYTES;
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
export async function withPictures(message: UIMessage, context: MessengerContext, download: Download): Promise<UIMessage> {
  const sent = [...(context.skipped ?? []), ...(context.message ? [context.message] : [])];
  const pictures: UIMessage["parts"] = [];
  const shown = new Set<MessengerAttachment>();
  for (const attachment of sent.flatMap((entry) => entry.attachments).filter(isPicture)) {
    try {
      const data = await download(attachment.fetchMetadata!.fileId);
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (!bytes.length || bytes.length > PICTURE_MAX_BYTES) continue;
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
