// Sticker packs: what one is, how one is read from a zip, and the stickers the resident draws itself.
//
// A pack is a zip of pictures. With a pack.json next to them it says what each one is for:
//   { "format": "resident-stickers/1", "name": "Clawd", "description": "…", "author": "…", "license": "…",
//     "homepage": "https://…", "stickers": [ { "id": "love", "file": "love.gif", "emoji": "❤️",
//       "when": "A rush of love: …", "telegram": "love.webm" } ] }
// Without one, every picture is a sticker and its file name says when to use it (开心.gif).
// "file" is what the web page shows (GIF, PNG, WebP or JPEG). "telegram" is optional: a Telegram sticker
// (WebM video, WebP or TGS) sent as a real sticker, so its transparent background stays transparent; without
// it a GIF goes to Telegram as an animation, a still picture as a photo.

import { encodeGif, fullestGifFrame, type Rgb } from "./gif";
import { encodePng } from "./png";

export const PACK_FORMAT = "resident-stickers/1";
export const MAX_PACKS = 20;
export const MAX_STICKERS_PER_PACK = 120;
// Stickers listed to the model, all packs together: each line rides along on every turn.
export const MAX_LISTED = 200;
export const MAX_LISTED_TOKENS = 6000;
export const MAX_ZIP_BYTES = 16 * 1024 * 1024;
export const MAX_WEB_BYTES = 1024 * 1024;
// All the files of one zip once unpacked: a small zip can unpack into far more than a Worker's memory.
export const MAX_UNPACKED_BYTES = 40 * 1024 * 1024;
// Telegram's own limits for a sticker file.
const TELEGRAM_LIMITS: Record<string, number> = { "video/webm": 256 * 1024, "image/webp": 512 * 1024, "application/x-tgsticker": 64 * 1024 };
const WHEN_MAX = 160;
// The pack the resident's own drawings go into.
export const OWN_PACK = "mine";
export const MAX_OWN = 60;

export type StickerFile = { bytes: Uint8Array; type: string };

export type PackInfo = { id: string; name: string; description: string; author: string; license: string; homepage: string };

export type NewSticker = { name: string; emoji: string; when: string; web: StickerFile; telegram?: StickerFile };

/** What a file is, from its first bytes; null for anything a sticker cannot be. */
export function sniff(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length < 12) return null;
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "application/x-tgsticker";
  return null;
}

export const WEB_TYPES = ["image/gif", "image/png", "image/webp", "image/jpeg"];

/** A short id from any name: letters and digits of any script, the rest dashes. */
export function slug(text: string, max = 32): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

const str = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** One emoji, or "" (Telegram wants one for a sticker it has not seen yet). */
export function emojiOf(value: unknown): string {
  const text = str(value, 32);
  const first = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)][0]?.segment ?? "";
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(first) ? first : "";
}

// ---- zip ----

function u16(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8);
}
function u32(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder().decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    // Zips made on Chinese Windows name their files in GBK.
    try {
      return new TextDecoder("gbk").decode(bytes);
    } catch {
      return String.fromCharCode(...bytes);
    }
  }
}

async function inflate(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error("too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * The files in a zip, by path. Folders, Mac resource forks and hidden files are left out, and so is any file
 * larger than `perFile` once unpacked; all of them together stop at `total`.
 */
export async function unzip(bytes: Uint8Array, perFile = MAX_WEB_BYTES, total = MAX_UNPACKED_BYTES): Promise<Map<string, Uint8Array>> {
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (u32(bytes, at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("不是 zip 压缩包");
  const entries = u16(bytes, end + 10);
  let at = u32(bytes, end + 16);
  const files = new Map<string, Uint8Array>();
  let unpacked = 0;
  const keep = (name: string, data: Uint8Array) => {
    unpacked += data.length;
    if (unpacked > total) throw new Error(`压缩包解开后超过 ${Math.round(total / 1024 / 1024)} MB`);
    files.set(name, data);
  };
  for (let i = 0; i < entries; i += 1) {
    if (u32(bytes, at) !== 0x02014b50) throw new Error("压缩包坏了");
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    const packed = u32(bytes, at + 20);
    const size = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const local = u32(bytes, at + 42);
    const name = decodeName(bytes.subarray(at + 46, at + 46 + nameLength), Boolean(flags & 0x800)).replace(/\\/g, "/");
    at += 46 + nameLength + extraLength + commentLength;
    const base = name.split("/").pop() ?? "";
    if (name.endsWith("/") || name.startsWith("__MACOSX/") || base.startsWith(".") || !base) continue;
    if (flags & 1) throw new Error("压缩包加了密码，解不开");
    if (packed === 0xffffffff || size === 0xffffffff) throw new Error("压缩包太大了");
    if (size > perFile) continue;
    if (u32(bytes, local) !== 0x04034b50) throw new Error("压缩包坏了");
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    const data = bytes.subarray(start, start + packed);
    if (method === 0) keep(name, data.slice());
    else if (method === 8) {
      const inflated = await inflate(data, perFile).catch(() => null);
      if (inflated) keep(name, inflated);
    }
  }
  return files;
}

// ---- packs ----

function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut + 1);
}
function stemOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** A Telegram file within Telegram's size limit for its kind, else undefined (and why, in `skipped`). */
function telegramFile(bytes: Uint8Array | undefined, label: string, skipped: string[]): StickerFile | undefined {
  if (!bytes) return undefined;
  const type = sniff(bytes);
  if (!type || !(type in TELEGRAM_LIMITS)) {
    skipped.push(`${label}：Telegram 那份不是 WebM、WebP 或 TGS，只发图`);
    return undefined;
  }
  if (bytes.length > TELEGRAM_LIMITS[type]) {
    skipped.push(`${label}：Telegram 那份超过 ${Math.round(TELEGRAM_LIMITS[type] / 1024)} KB，只发图`);
    return undefined;
  }
  return { bytes, type };
}

/** Unique names within a pack, in order. */
function uniqueNames<T extends { name: string }>(stickers: T[]): T[] {
  const taken = new Set<string>();
  return stickers.map((sticker, index) => {
    let name = sticker.name || `s${index + 1}`;
    for (let n = 2; taken.has(name); n += 1) name = `${sticker.name || `s${index + 1}`}-${n}`;
    taken.add(name);
    return { ...sticker, name };
  });
}

/**
 * A pack from the files of a zip: as its pack.json says, or else every picture in it. `fallback` names a pack
 * that does not name itself (the zip's file name). Anything left out is said in `skipped`.
 */
export function readPack(files: Map<string, Uint8Array>, fallback: string): { pack: PackInfo; stickers: NewSticker[]; skipped: string[] } | { error: string } {
  const skipped: string[] = [];
  const manifestPath = [...files.keys()].filter((path) => (path.split("/").pop() ?? "") === "pack.json").sort((a, b) => a.length - b.length)[0];
  let stickers: NewSticker[] = [];
  let pack: PackInfo;
  if (manifestPath) {
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(new TextDecoder().decode(files.get(manifestPath)!));
    } catch {
      return { error: "pack.json 不是合法的 JSON" };
    }
    if (typeof manifest.format === "string" && !manifest.format.startsWith("resident-stickers/")) {
      return { error: `pack.json 的 format 是 ${manifest.format}，认不得（要 ${PACK_FORMAT}）` };
    }
    if (!Array.isArray(manifest.stickers)) return { error: "pack.json 里没有 stickers 列表" };
    const dir = dirOf(manifestPath);
    const name = str(manifest.name, 60) || fallback;
    pack = {
      id: slug(str(manifest.id, 60) || name, 24),
      name,
      description: str(manifest.description, 300),
      author: str(manifest.author, 120),
      license: str(manifest.license, 200),
      homepage: /^https:\/\//.test(str(manifest.homepage, 300)) ? str(manifest.homepage, 300) : ""
    };
    for (const [index, raw] of (manifest.stickers as unknown[]).entries()) {
      const item = (raw ?? {}) as Record<string, unknown>;
      const file = str(item.file, 200);
      const label = file || `第 ${index + 1} 张`;
      const bytes = file ? files.get(dir + file) : undefined;
      const type = bytes ? sniff(bytes) : null;
      if (!bytes || !type || !WEB_TYPES.includes(type)) {
        skipped.push(`${label}：${bytes ? "不是 GIF、PNG、WebP 或 JPEG" : "压缩包里没有这个文件（或者超过 1 MB）"}`);
        continue;
      }
      const tg = str(item.telegram, 200);
      stickers.push({
        name: slug(str(item.id, 60) || stemOf(file)),
        emoji: emojiOf(item.emoji),
        when: str(item.when, WHEN_MAX),
        web: { bytes, type },
        telegram: tg ? telegramFile(files.get(dir + tg), label, skipped) : undefined
      });
    }
  } else {
    pack = { id: slug(fallback, 24), name: fallback.slice(0, 60), description: "", author: "", license: "", homepage: "" };
    const paths = [...files.keys()].sort((a, b) => a.localeCompare(b, "zh"));
    // A WebM next to a picture of the same name is that picture for Telegram.
    const videos = new Map<string, string>();
    for (const path of paths) if (sniff(files.get(path)!) === "video/webm") videos.set(dirOf(path) + stemOf(path), path);
    for (const path of paths) {
      const bytes = files.get(path)!;
      const type = sniff(bytes);
      if (!type || !WEB_TYPES.includes(type)) continue;
      const stem = stemOf(path);
      const twin = videos.get(dirOf(path) + stem);
      stickers.push({
        name: slug(stem),
        emoji: "",
        when: stem.replace(/[_-]+/g, " ").trim().slice(0, WHEN_MAX),
        web: { bytes, type },
        telegram: twin ? telegramFile(files.get(twin), stem, skipped) : undefined
      });
    }
  }
  if (!pack.id || pack.id === OWN_PACK) pack.id = pack.id === OWN_PACK ? "mine-2" : "pack";
  if (stickers.length > MAX_STICKERS_PER_PACK) {
    skipped.push(`一个包最多 ${MAX_STICKERS_PER_PACK} 张，后面 ${stickers.length - MAX_STICKERS_PER_PACK} 张没导`);
    stickers = stickers.slice(0, MAX_STICKERS_PER_PACK);
  }
  if (!stickers.length) return { error: skipped[0] ? `一张也没导进来：${skipped[0]}` : "压缩包里没有 GIF、PNG、WebP 或 JPEG" };
  return { pack, stickers: uniqueNames(stickers), skipped };
}

/** The set name in a Telegram sticker pack link (t.me/addstickers/NAME, tg://addstickers?set=NAME); null otherwise. */
export function telegramSetName(link: string): string | null {
  const text = link.trim();
  const match =
    text.match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/addstickers\/([A-Za-z0-9_]{1,64})\/?$/i) ??
    text.match(/^tg:\/\/addstickers\?set=([A-Za-z0-9_]{1,64})$/i);
  return match ? match[1] : null;
}

export function isEmojiPackLink(link: string): boolean {
  return /(?:t\.me|telegram\.me)\/addemoji\//i.test(link);
}

/** One sticker as the model sees it: `pack/name emoji when`. */
export function catalogLine(pack: string, sticker: { name: string; emoji: string; when: string }): string {
  return [`${pack}/${sticker.name}`, sticker.emoji, sticker.when.replace(/\s+/g, " ")].filter(Boolean).join(" ");
}

/** About how many tokens lines cost: CJK about one a character, the rest about four characters a token. */
export function tokensOf(lines: readonly string[]): number {
  const text = lines.join("\n");
  const wide = (text.match(/[　-鿿가-힯＀-￯]/g) ?? []).length;
  return Math.ceil(wide + (text.length - wide) / 4);
}

// ---- drawing ----

export type Drawing = {
  palette: Record<string, string>;
  frames: string[][];
  ms?: number | number[];
  outline?: boolean;
};

const BACKGROUND: Rgb = [244, 244, 248];
const WHITE: Rgb = [255, 255, 255];
const PEN = [-2, -1, 0, 1, 2].flatMap((dy) => [-2, -1, 0, 1, 2].filter((dx) => dy * dy + dx * dx <= 5).map((dx) => [dy, dx]));

function hex(value: string): Rgb | null {
  const match = value.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return null;
  const digits = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16)) as Rgb;
}

/**
 * A pixel drawing as two GIFs: one with a transparent background for the web page, and one on a light
 * background, twice the size, for Telegram (which turns GIFs into videos and would lose the transparency).
 * Each character is a pixel: '.' or a space is transparent, anything else a colour from the palette.
 */
export function drawSticker(drawing: Drawing): { web: StickerFile; telegram: StickerFile } | { error: string } {
  const frames = Array.isArray(drawing.frames) ? drawing.frames : [];
  if (frames.length < 1 || frames.length > 8) return { error: "frames: 1 to 8 frames." };
  const rows = frames.map((frame) => (Array.isArray(frame) ? frame.map((row) => String(row).replace(/\s+$/, "")) : []));
  const height = rows[0].length;
  const width = Math.max(0, ...rows.flat().map((row) => [...row].length));
  if (height < 8 || height > 32 || width < 8 || width > 32) return { error: "Each frame is 8 to 32 rows of 8 to 32 characters." };
  if (rows.some((frame) => frame.length !== height)) return { error: `Every frame needs the same ${height} rows.` };
  const keys = Object.keys(drawing.palette ?? {});
  if (!keys.length || keys.length > 15) return { error: "palette: 1 to 15 colours." };
  const colors: Rgb[] = [];
  const index = new Map<string, number>();
  for (const key of keys) {
    const rgb = hex(String(drawing.palette[key]));
    if ([...key].length !== 1 || key === "." || key === " " || !rgb) return { error: `palette: "${key}" must be one character mapped to a colour like #DA7758.` };
    index.set(key, colors.length + 2);
    colors.push(rgb);
  }
  const unknown = new Set([...rows.flat().join("")].filter((c) => c !== "." && c !== " " && !index.has(c)));
  if (unknown.size) return { error: `Not in the palette: ${[...unknown].slice(0, 10).join(" ")}` };
  const outline = drawing.outline !== false;
  const scale = Math.max(4, Math.floor(128 / Math.max(width, height)));
  const pad = outline ? 4 : 0;
  const W = width * scale + 2 * pad;
  const H = height * scale + 2 * pad;
  const pictures = rows.map((frame) => {
    const g = new Uint8Array(W * H);
    frame.forEach((row, y) => {
      [...row].forEach((char, x) => {
        const color = index.get(char);
        if (!color) return;
        for (let dy = 0; dy < scale; dy += 1) g.fill(color, (pad + y * scale + dy) * W + pad + x * scale, (pad + y * scale + dy) * W + pad + (x + 1) * scale);
      });
    });
    if (outline) {
      const ring = new Uint8Array(W * H);
      for (let y = 0; y < H; y += 1)
        for (let x = 0; x < W; x += 1) {
          if (!g[y * W + x]) continue;
          for (const [dy, dx] of PEN) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy >= 0 && yy < H && xx >= 0 && xx < W && !g[yy * W + xx]) ring[yy * W + xx] = 1;
          }
        }
      for (let i = 0; i < ring.length; i += 1) if (ring[i]) g[i] = 1;
    }
    return g;
  });
  const ms = Array.isArray(drawing.ms) ? drawing.ms : [drawing.ms ?? 150];
  const delays = pictures.map((_, i) => Math.min(1000, Math.max(60, Number(ms[i] ?? ms.at(-1)) || 150)));
  const web = encodeGif({ width: W, height: H, palette: [[0, 0, 0], WHITE, ...colors], frames: pictures, delays, transparent: true });
  const big = pictures.map((g) => {
    const out = new Uint8Array(4 * W * H);
    for (let y = 0; y < 2 * H; y += 1) for (let x = 0; x < 2 * W; x += 1) out[y * 2 * W + x] = g[(y >> 1) * W + (x >> 1)];
    return out;
  });
  const telegram = encodeGif({ width: 2 * W, height: 2 * H, palette: [BACKGROUND, WHITE, ...colors], frames: big, delays, transparent: false });
  return { web: { bytes: web, type: "image/gif" }, telegram: { bytes: telegram, type: "image/gif" } };
}

// ---- for chats that show no animation ----

// A still sticker is enlarged (by a whole number, so pixel art stays crisp) to at least this many pixels across.
const STILL_MIN_SIDE = 240;

/**
 * A sticker as one still picture, for WeCom, which shows a GIF as its first frame and keeps only JPG and PNG: a
 * GIF becomes a PNG of its fullest frame, see-through where it was, enlarged when small. PNG and JPEG stay as
 * they are; a GIF this cannot read goes as it is. Null for anything else (WebP, WebM), which only the relay can
 * turn into a picture.
 */
export async function stillSticker(file: StickerFile): Promise<StickerFile | null> {
  if (file.type === "image/png" || file.type === "image/jpeg") return file;
  if (file.type !== "image/gif") return null;
  const frame = fullestGifFrame(file.bytes);
  if (!frame) return file;
  const { width, height, rgba } = frame;
  const times = Math.max(1, Math.min(4, Math.ceil(STILL_MIN_SIDE / Math.max(width, height))));
  if (times === 1) return { bytes: await encodePng(width, height, rgba), type: "image/png" };
  const W = width * times;
  const big = new Uint8Array(W * height * times * 4);
  const pixels = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
  const out = new Uint32Array(big.buffer);
  for (let y = 0; y < height * times; y += 1) {
    const from = Math.floor(y / times) * width;
    for (let x = 0; x < W; x += 1) out[y * W + x] = pixels[from + Math.floor(x / times)];
  }
  return { bytes: await encodePng(W, height * times, big), type: "image/png" };
}

// ---- what the model is told ----

export const SEND_STICKER_DESCRIPTION =
  "Send one of your stickers, as people do in a chat: now and then, when it fits the moment, not in every reply. " +
  "At most one per reply, and none while they are upset or talking about something serious. It shows after your " +
  "words, and can also be the whole reply. Your stickers (pack/name, emoji, when to use it):\n";

export const MAKE_STICKER_DESCRIPTION =
  "Draw a new sticker of your own as pixel art. It is kept in your own pack as mine/<name>, to send again later " +
  "with send_sticker, and is sent now (as this reply's one sticker) unless send is false. Draw one when they ask " +
  "for it or when an idea is worth keeping; drawing under a name you already used redraws it. frames: 1 to 8 " +
  "frames shown in a loop, each 8 to 32 rows of the same 8 to 32 characters, one character per pixel: '.' is " +
  'transparent, every other character a colour from palette (up to 15, like {"o": "#DA7758", "k": "#000000"}). ' +
  "A white outline is drawn around it. ms: how long each frame shows, 60 to 1000 (default 150), one number or one per frame.";
