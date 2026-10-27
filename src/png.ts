// A small PNG writer (8-bit RGBA) and reader (any colour type and depth, not interlaced), for the still stickers
// sent to WeCom.

let crcTable: Uint32Array | null = null;

function crc32(parts: Uint8Array[]): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const part of parts) for (const byte of part) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  const name = Uint8Array.from(type, (c) => c.charCodeAt(0));
  out.set(name, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32([name, data]));
  return out;
}

/** A PNG of width × height RGBA pixels (4 bytes each, row by row). */
export async function encodePng(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  // Each row starts with its filter: 0, none.
  for (let y = 0; y < height; y += 1) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  // "deflate" here is zlib's format, which is what IDAT holds.
  const packed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", packed), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// A sticker is at most 1 MB, but a PNG can still ask for a canvas far bigger than that.
const MAX_PIXELS = 1024 * 1024;

async function inflate(parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob(parts).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * A PNG's pixels as 8-bit RGBA: grey, RGB, palette, grey with alpha or RGBA, at any bit depth, with tRNS. Null for
 * what this does not read (an interlaced or broken PNG, or one too big).
 */
export async function decodePng(bytes: Uint8Array): Promise<{ width: number; height: number; rgba: Uint8Array } | null> {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33 || signature.some((byte, i) => bytes[i] !== byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = view.getUint32(at);
    if (at + 12 + length > bytes.length) return null;
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR" && length >= 13) {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      [depth, colour] = [data[8], data[9]];
      interlace = data[12];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colour];
  if (!channels || !width || !height || width * height > MAX_PIXELS || interlace || !idat.length) return null;
  if (![1, 2, 4, 8, 16].includes(depth) || (colour === 3 && (!palette || depth > 8)) || ((colour === 2 || colour === 4 || colour === 6) && depth < 8)) return null;
  const bits = channels * depth;
  const stride = Math.ceil((width * bits) / 8);
  const bpp = Math.max(1, bits >> 3);
  let raw: Uint8Array;
  try {
    raw = await inflate(idat);
  } catch {
    return null;
  }
  if (raw.length < (stride + 1) * height) return null;
  // Undo each row's filter, in place, against the row above (already undone).
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1) + 1;
    const up = row - stride - 1;
    const filter = raw[row - 1];
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? raw[row + i - bpp] : 0;
      const b = y ? raw[up + i] : 0;
      const c = y && i >= bpp ? raw[up + i - bpp] : 0;
      const add = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : 0;
      raw[row + i] = (raw[row + i] + add) & 0xff;
    }
  }
  const max = (1 << depth) - 1;
  const sample = (row: number, s: number) =>
    depth === 8 ? raw[row + s] : depth === 16 ? (raw[row + 2 * s] << 8) | raw[row + 2 * s + 1] : (raw[row + ((s * depth) >> 3)] >> (8 - depth - ((s * depth) & 7))) & max;
  const eight = (value: number) => (depth === 16 ? value >> 8 : depth < 8 ? Math.round((value * 255) / max) : value);
  // tRNS for grey and RGB names one colour, at the image's own depth, that is see-through.
  const key = trns && (colour === 0 || colour === 2) ? Array.from({ length: colour ? 3 : 1 }, (_, i) => (trns[2 * i] << 8) | trns[2 * i + 1]) : null;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1) + 1;
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      const s = x * channels;
      if (colour === 3) {
        const index = sample(row, x);
        rgba.set(palette!.subarray(3 * index, 3 * index + 3), p);
        rgba[p + 3] = trns && index < trns.length ? trns[index] : 255;
        continue;
      }
      const values = Array.from({ length: channels }, (_, i) => sample(row, s + i));
      const [r, g, b] = colour === 0 || colour === 4 ? [values[0], values[0], values[0]] : values;
      rgba[p] = eight(r);
      rgba[p + 1] = eight(g);
      rgba[p + 2] = eight(b);
      rgba[p + 3] = colour === 4 ? eight(values[1]) : colour === 6 ? eight(values[3]) : key && key.every((k, i) => k === values[i]) ? 0 : 255;
    }
  }
  return { width, height, rgba };
}
