// A small GIF89a writer for the stickers the resident draws itself (make_sticker in stickers.ts): indexed
// frames, one palette, looping, with a transparent colour or without one. And a reader that finds an animated
// sticker's fullest frame, for chats that show no animation (WeCom).

export type Rgb = [number, number, number];

/** Palette index 0 is transparent when `transparent` is set. Every frame is width × height indices. */
export type GifImage = {
  width: number;
  height: number;
  palette: Rgb[];
  frames: Uint8Array[];
  /** How long each frame shows, in milliseconds (GIF keeps hundredths). */
  delays: number[];
  transparent: boolean;
};

function bitsFor(colors: number): number {
  let bits = 1;
  while (1 << bits < colors) bits += 1;
  return bits;
}

/** GIF's variable-width LZW, as in the original compress(1) encoder GIF encoders descend from. */
export function lzw(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out: number[] = [];
  let bits = minCodeSize + 1;
  let maxCode = (1 << bits) - 1;
  let free = clear + 2;
  let resetBits = false;
  let buffer = 0;
  let count = 0;
  const table = new Map<number, number>();
  const output = (code: number) => {
    buffer |= code << count;
    count += bits;
    while (count >= 8) {
      out.push(buffer & 0xff);
      buffer >>>= 8;
      count -= 8;
    }
    if (resetBits) {
      bits = minCodeSize + 1;
      maxCode = (1 << bits) - 1;
      resetBits = false;
    } else if (free > maxCode && bits < 12) {
      bits += 1;
      maxCode = bits === 12 ? 4096 : (1 << bits) - 1;
    }
  };
  output(clear);
  let prefix = indices[0] ?? 0;
  for (let i = 1; i < indices.length; i += 1) {
    const next = indices[i];
    const key = (next << 12) | prefix;
    const known = table.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    output(prefix);
    prefix = next;
    if (free < 4096) {
      table.set(key, free);
      free += 1;
    } else {
      table.clear();
      free = clear + 2;
      resetBits = true;
      output(clear);
    }
  }
  output(prefix);
  output(end);
  if (count > 0) out.push(buffer & 0xff);
  return Uint8Array.from(out);
}

export function encodeGif(image: GifImage): Uint8Array {
  const { width, height, frames, delays } = image;
  const bits = Math.max(2, bitsFor(image.palette.length));
  const size = 1 << bits;
  const bytes: number[] = [];
  const push = (...values: number[]) => bytes.push(...values);
  const word = (value: number) => push(value & 0xff, (value >> 8) & 0xff);
  for (const char of "GIF89a") push(char.charCodeAt(0));
  word(width);
  word(height);
  // A global colour table of 2^bits entries.
  push(0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0);
  for (let i = 0; i < size; i += 1) push(...(image.palette[i] ?? [0, 0, 0]));
  // Loop forever.
  push(0x21, 0xff, 0x0b, ..."NETSCAPE2.0".split("").map((c) => c.charCodeAt(0)), 0x03, 0x01, 0, 0, 0);
  frames.forEach((frame, index) => {
    const delay = Math.max(2, Math.round((delays[index] ?? delays.at(-1) ?? 100) / 10));
    // Each frame replaces the one before it (disposal 2: back to the background, here transparent).
    push(0x21, 0xf9, 0x04, (2 << 2) | (image.transparent ? 1 : 0));
    word(delay);
    push(0, 0);
    push(0x2c);
    word(0);
    word(0);
    word(width);
    word(height);
    push(0);
    push(bits);
    const data = lzw(frame, bits);
    for (let at = 0; at < data.length; at += 255) {
      const block = data.subarray(at, at + 255);
      push(block.length, ...block);
    }
    push(0);
  });
  push(0x3b);
  return Uint8Array.from(bytes);
}

/** Width and height from a GIF's header; null when it is not one. */
export function gifSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 10 || String.fromCharCode(...bytes.subarray(0, 4)) !== "GIF8") return null;
  return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
}

// Bounds for reading a GIF someone else made: a sticker is at most 1 MB, but its frames could still ask for more
// work than one reply should take. A bigger one is not read (and goes to WeCom as it is).
const MAX_PIXELS = 640 * 640;
const MAX_FRAMES = 200;

/** GIF's LZW, undone: `pixels` palette indices (fewer when the data ends early). */
export function unlzw(data: Uint8Array, minCodeSize: number, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels);
  if (minCodeSize < 2 || minCodeSize > 8) return out;
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  for (let i = 0; i < clear; i += 1) suffix[i] = i;
  let size = minCodeSize + 1;
  let mask = (1 << size) - 1;
  let next = clear + 2;
  let old = -1;
  let first = 0;
  let buffer = 0;
  let bits = 0;
  let at = 0;
  let n = 0;
  while (n < pixels) {
    while (bits < size) {
      if (at >= data.length) return out;
      buffer |= data[at++] << bits;
      bits += 8;
    }
    const code = buffer & mask;
    buffer >>>= size;
    bits -= size;
    if (code === clear) {
      size = minCodeSize + 1;
      mask = (1 << size) - 1;
      next = clear + 2;
      old = -1;
      continue;
    }
    if (code === end) break;
    if (old === -1) {
      if (code >= clear) break;
      out[n++] = code;
      old = first = code;
      continue;
    }
    if (code > next) break;
    let top = 0;
    let c = code;
    // A code not in the table yet is the last string plus its own first index.
    if (code === next) {
      stack[top++] = first;
      c = old;
    }
    while (c >= clear) {
      stack[top++] = suffix[c];
      c = prefix[c];
    }
    stack[top++] = c;
    first = c;
    while (top && n < pixels) out[n++] = stack[--top];
    if (next < 4096) {
      prefix[next] = old;
      suffix[next] = first;
      next += 1;
      if (next > mask && size < 12) {
        size += 1;
        mask = (1 << size) - 1;
      }
    }
    old = code;
  }
  return out;
}

/**
 * The frame of a GIF that shows the most, as RGBA: every frame drawn over the ones before it as a browser would,
 * and the one with the most pixels that are not see-through kept (the first of them on a tie). A sticker that
 * starts empty, or builds up to its punchline, is shown at its fullest. Null when the bytes are not a GIF this can
 * read.
 */
export function fullestGifFrame(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } | null {
  const size = gifSize(bytes);
  if (!size) return null;
  const { width, height } = size;
  if (!width || !height || width * height > MAX_PIXELS) return null;
  const canvas = new Uint8Array(width * height * 4);
  let best: Uint8Array | null = null;
  let bestCount = -1;
  let at = 13;
  const packed = bytes[10];
  const table = (from: number, count: number) => bytes.subarray(from, from + 3 * count);
  let global: Uint8Array | null = null;
  if (packed & 0x80) {
    const count = 1 << ((packed & 7) + 1);
    global = table(at, count);
    at += 3 * count;
  }
  let disposal = 0;
  let transparent = -1;
  let frames = 0;
  const skipBlocks = () => {
    while (at < bytes.length && bytes[at] !== 0) at += bytes[at] + 1;
    at += 1;
  };
  while (at < bytes.length && frames < MAX_FRAMES) {
    const kind = bytes[at++];
    if (kind === 0x3b) break;
    if (kind === 0x21) {
      const label = bytes[at++];
      if (label === 0xf9 && bytes[at] >= 4) {
        const flags = bytes[at + 1];
        disposal = (flags >> 2) & 7;
        transparent = flags & 1 ? bytes[at + 4] : -1;
      }
      skipBlocks();
      continue;
    }
    if (kind !== 0x2c || at + 9 > bytes.length) return best ? { width, height, rgba: best } : null;
    const word = (i: number) => bytes[at + i] | (bytes[at + i + 1] << 8);
    const left = word(0);
    const top = word(2);
    const w = word(4);
    const h = word(6);
    const flags = bytes[at + 8];
    at += 9;
    let palette = global;
    if (flags & 0x80) {
      const count = 1 << ((flags & 7) + 1);
      palette = table(at, count);
      at += 3 * count;
    }
    const minCodeSize = bytes[at++];
    // The image data: sub-blocks of at most 255 bytes, joined.
    const parts: Uint8Array[] = [];
    let length = 0;
    while (at < bytes.length && bytes[at] !== 0) {
      const part = bytes.subarray(at + 1, at + 1 + bytes[at]);
      parts.push(part);
      length += part.length;
      at += bytes[at] + 1;
    }
    at += 1;
    if (!w || !h || w * h > MAX_PIXELS || !palette) {
      disposal = 0;
      transparent = -1;
      continue;
    }
    const data = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      data.set(part, offset);
      offset += part.length;
    }
    const indices = unlzw(data, minCodeSize, w * h);
    // Interlaced rows come in four passes: every 8th from 0, every 8th from 4, every 4th from 2, every 2nd from 1.
    const rows: number[] = [];
    if (flags & 0x40) {
      for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < h; y += step) rows.push(y);
    } else for (let y = 0; y < h; y += 1) rows.push(y);
    const before = disposal === 3 ? canvas.slice() : null;
    rows.forEach((y, row) => {
      const cy = top + y;
      if (cy >= height) return;
      for (let x = 0; x < w; x += 1) {
        const cx = left + x;
        if (cx >= width) break;
        const index = indices[row * w + x];
        if (index === transparent || 3 * index + 2 >= palette.length) continue;
        const p = (cy * width + cx) * 4;
        canvas[p] = palette[3 * index];
        canvas[p + 1] = palette[3 * index + 1];
        canvas[p + 2] = palette[3 * index + 2];
        canvas[p + 3] = 255;
      }
    });
    frames += 1;
    let count = 0;
    for (let p = 3; p < canvas.length; p += 4) if (canvas[p]) count += 1;
    if (count > bestCount) {
      bestCount = count;
      best = canvas.slice();
    }
    // What this frame leaves for the next: itself, the background (see-through) where it was, or what was there.
    if (disposal === 2) {
      for (let y = top; y < Math.min(height, top + h); y += 1) canvas.fill(0, (y * width + left) * 4, (y * width + Math.min(width, left + w)) * 4);
    } else if (before) canvas.set(before);
    disposal = 0;
    transparent = -1;
  }
  return best ? { width, height, rgba: best } : null;
}
