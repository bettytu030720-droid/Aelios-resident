// A small GIF89a writer for the stickers the resident draws itself (make_sticker in stickers.ts): indexed
// frames, one palette, looping, with a transparent colour or without one.

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
