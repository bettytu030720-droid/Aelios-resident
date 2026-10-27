// Unit tests for sticker packs, drawn stickers and still stickers for WeCom (src/stickers.ts, src/gif.ts, src/png.ts).
// Usage: node test/stickers.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync, inflateSync, crc32 } from "node:zlib";
import { build } from "esbuild";
import { GIF, PNG, WEBM, zip } from "./zip.mjs";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-stickers-"));
const load = async (entry) => {
  const out = join(dir, entry.replace(/\W/g, "_") + ".mjs");
  await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
  return import(pathToFileURL(join(process.cwd(), out)).href);
};
const m = await load("src/stickers.ts");
const gif = await load("src/gif.ts");
const png = await load("src/png.ts");
rmSync(dir, { recursive: true, force: true });

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

/** Decodes one GIF frame's LZW data back to indices, to check the writer. */
function unlzw(data, minCodeSize, count) {
  const clear = 1 << minCodeSize;
  let bits = minCodeSize + 1;
  let table = [];
  const reset = () => {
    table = Array.from({ length: clear + 2 }, (_, i) => [i]);
    bits = minCodeSize + 1;
  };
  reset();
  const out = [];
  let previous = null;
  let at = 0;
  const read = () => {
    let code = 0;
    for (let i = 0; i < bits; i += 1, at += 1) code |= ((data[at >> 3] >> (at & 7)) & 1) << i;
    return code;
  };
  while (out.length < count) {
    const code = read();
    if (code === clear) {
      reset();
      previous = null;
      continue;
    }
    if (code === clear + 1) break;
    let entry;
    if (code < table.length) entry = table[code];
    else if (previous) entry = [...previous, previous[0]];
    else throw new Error(`bad code ${code}`);
    out.push(...entry);
    if (previous) table.push([...previous, entry[0]]);
    previous = entry;
    if (table.length === 1 << bits && bits < 12) bits += 1;
  }
  return out;
}

/** The frames of a GIF the writer made: size, palette size, delays, transparency and pixels. */
function readGif(bytes) {
  const b = Buffer.from(bytes);
  assert.equal(b.subarray(0, 6).toString(), "GIF89a");
  const width = b.readUInt16LE(6);
  const height = b.readUInt16LE(8);
  const colors = 2 << (b[10] & 7);
  let at = 13 + 3 * colors;
  const frames = [];
  let gce = null;
  while (b[at] !== 0x3b) {
    if (b[at] === 0x21) {
      if (b[at + 1] === 0xf9) gce = { transparent: Boolean(b[at + 3] & 1), delay: b.readUInt16LE(at + 4) * 10 };
      at += 2;
      while (b[at]) at += b[at] + 1;
      at += 1;
    } else if (b[at] === 0x2c) {
      const min = b[at + 10];
      at += 11;
      const chunks = [];
      while (b[at]) {
        chunks.push(b.subarray(at + 1, at + 1 + b[at]));
        at += b[at] + 1;
      }
      at += 1;
      frames.push({ ...gce, pixels: unlzw(Buffer.concat(chunks), min, width * height) });
    } else throw new Error(`unexpected block ${b[at]}`);
  }
  return { width, height, colors, frames };
}

await test("files are told apart by their first bytes", () => {
  assert.equal(m.sniff(GIF), "image/gif");
  assert.equal(m.sniff(PNG), "image/png");
  assert.equal(m.sniff(WEBM), "video/webm");
  assert.equal(m.sniff(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")])), "image/webp");
  assert.equal(m.sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), "image/jpeg");
  assert.equal(m.sniff(Buffer.from("<html><body>hi</body></html>")), null);
});

await test("names become short ids in any script; one emoji is kept", () => {
  assert.equal(m.slug("Hello World!"), "hello-world");
  assert.equal(m.slug("开心 的样子"), "开心-的样子");
  assert.equal(m.slug("___"), "");
  assert.equal(m.emojiOf("❤️ love"), "❤️");
  assert.equal(m.emojiOf("🇨🇳"), "🇨🇳");
  assert.equal(m.emojiOf("love"), "");
});

await test("a zip unpacks, stored or deflated, without folders, Mac forks or hidden files; GBK names read, locked zips refused", async () => {
  const bytes = zip([
    { name: "pack/", data: "" },
    { name: "pack/a.gif", data: GIF },
    { name: "pack/b.txt", data: "x".repeat(5000), deflate: true },
    { name: "__MACOSX/pack/._a.gif", data: "junk" },
    { name: "pack/.DS_Store", data: "junk" },
    { name: "pack/开心.png", data: PNG, deflate: true }
  ]);
  const files = await m.unzip(new Uint8Array(bytes));
  assert.deepEqual([...files.keys()].sort(), ["pack/a.gif", "pack/b.txt", "pack/开心.png"]);
  assert.equal(new TextDecoder().decode(files.get("pack/b.txt")), "x".repeat(5000));
  assert.deepEqual(Buffer.from(files.get("pack/开心.png")), PNG);
  const small = await m.unzip(new Uint8Array(bytes), 100);
  assert.ok(!small.has("pack/b.txt"), "a file over the limit is left out");
  await assert.rejects(() => m.unzip(new Uint8Array(Buffer.from("not a zip at all, just text"))), /不是 zip/);
  // 开心 in GBK, as a zip made on Chinese Windows names it.
  const gbk = await m.unzip(new Uint8Array(zip([{ name: "", raw: [0xbf, 0xaa, 0xd0, 0xc4, 0x2e, 0x67, 0x69, 0x66], data: GIF }])));
  assert.deepEqual([...gbk.keys()], ["开心.gif"]);
  await assert.rejects(() => m.unzip(new Uint8Array(zip([{ name: "a.gif", data: GIF, flags: 0x801 }]))), /密码/);
  // Small zipped, large unpacked: stops before it fills the memory.
  const bomb = zip(Array.from({ length: 6 }, (_, i) => ({ name: `${i}.bin`, data: Buffer.alloc(1000), deflate: true })));
  await assert.rejects(() => m.unzip(new Uint8Array(bomb), 1000, 4500), /超过/);
});

await test("a pack.json says what each sticker is for", async () => {
  const pack = {
    format: "resident-stickers/1",
    name: "Test Pack",
    author: "me",
    homepage: "javascript:alert(1)",
    stickers: [
      { id: "wave", file: "wave.gif", emoji: "👋", when: "Say hi.", telegram: "wave.webm" },
      { file: "love.png", emoji: "not one", when: "Love." },
      { file: "gone.gif", when: "Not in the zip." },
      { id: "wave", file: "wave.gif", when: "The same id again." }
    ]
  };
  const files = await m.unzip(new Uint8Array(zip([
    { name: "x/pack.json", data: JSON.stringify(pack) },
    { name: "x/wave.gif", data: GIF },
    { name: "x/wave.webm", data: WEBM },
    { name: "x/love.png", data: PNG }
  ])));
  const read = m.readPack(files, "fallback");
  assert.ok(!("error" in read), read.error);
  assert.equal(read.pack.id, "test-pack");
  assert.equal(read.pack.name, "Test Pack");
  assert.equal(read.pack.homepage, "", "only an https homepage is kept");
  assert.deepEqual(read.stickers.map((s) => [s.name, s.emoji, s.when, s.web.type, s.telegram?.type ?? null]), [
    ["wave", "👋", "Say hi.", "image/gif", "video/webm"],
    ["love", "", "Love.", "image/png", null],
    ["wave-2", "", "The same id again.", "image/gif", null]
  ]);
  assert.equal(read.skipped.length, 1);
  assert.match(read.skipped[0], /gone\.gif/);
  const wrong = m.readPack(new Map([["pack.json", new TextEncoder().encode(JSON.stringify({ format: "other/2", stickers: [] }))]]), "f");
  assert.match(wrong.error, /认不得/);
  assert.match(m.readPack(new Map([["pack.json", new TextEncoder().encode("{")]]), "f").error, /JSON/);
});

await test("without a pack.json, every picture is a sticker named for its file", async () => {
  const files = await m.unzip(new Uint8Array(zip([
    { name: "开心.gif", data: GIF },
    { name: "开心.webm", data: WEBM },
    { name: "good_night.png", data: PNG },
    { name: "notes.txt", data: "hi" }
  ])));
  const read = m.readPack(files, "我的表情");
  assert.equal(read.pack.name, "我的表情");
  assert.deepEqual(read.stickers.map((s) => [s.name, s.when, Boolean(s.telegram)]), [["开心", "开心", true], ["good-night", "good night", false]]);
  assert.match(m.readPack(new Map([["a.txt", new Uint8Array(20)]]), "x").error, /没有 GIF/);
  // A pack may not take the resident's own pack's id.
  assert.equal(m.readPack(files, "mine").pack.id, "mine-2");
});

await test("Telegram sticker pack links, and the emoji packs a bot cannot send", () => {
  assert.equal(m.telegramSetName("https://t.me/addstickers/Clawd_by_bot"), "Clawd_by_bot");
  assert.equal(m.telegramSetName(" t.me/addstickers/Abc/ "), "Abc");
  assert.equal(m.telegramSetName("tg://addstickers?set=Abc"), "Abc");
  assert.equal(m.telegramSetName("https://t.me/addstickers/a b"), null);
  assert.equal(m.telegramSetName("https://example.com/addstickers/Abc"), null);
  assert.ok(m.isEmojiPackLink("https://t.me/addemoji/Abc"));
});

await test("what the model reads for each sticker, and about what it costs", () => {
  assert.equal(m.catalogLine("clawd", { name: "love", emoji: "❤️", when: "A rush\nof love." }), "clawd/love ❤️ A rush of love.");
  assert.equal(m.catalogLine("tg", { name: "3", emoji: "", when: "" }), "tg/3");
  assert.ok(m.tokensOf(["clawd/love ❤️ A rush of love."]) < m.tokensOf(["clawd/love ❤️ 一阵爱意涌上来的时候"]));
});

await test("the GIF writer's LZW reads back exactly, through table resets", () => {
  const pixels = new Uint8Array(200 * 200);
  let seed = 7;
  for (let i = 0; i < pixels.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    pixels[i] = (seed >> 16) & 255;
  }
  const bytes = gif.encodeGif({ width: 200, height: 200, palette: Array.from({ length: 256 }, (_, i) => [i, i, i]), frames: [pixels], delays: [100], transparent: false });
  const read = readGif(bytes);
  assert.equal(read.frames.length, 1);
  assert.deepEqual(read.frames[0].pixels, [...pixels]);
  assert.deepEqual(gif.gifSize(bytes), { width: 200, height: 200 });
});

await test("a drawing becomes a transparent GIF with a white outline, and a bigger one on a light background", () => {
  const heart = ["........", ".XX..XX.", "XXXXXXXX", "XXXXXXXX", ".XXXXXX.", "..XXXX..", "...XX...", "........"];
  const drawn = m.drawSticker({ palette: { X: "#e84868", o: "#fab" }, frames: [heart, heart.map((r) => r.replace("X", "o"))], ms: [200, 9999] });
  assert.ok(!("error" in drawn), drawn.error);
  const web = readGif(drawn.web.bytes);
  // 8 cells of 16 px, and 4 px around for the outline.
  assert.equal(web.width, 136);
  assert.equal(web.frames.length, 2);
  assert.ok(web.frames.every((frame) => frame.transparent));
  assert.deepEqual(web.frames.map((frame) => frame.delay), [200, 1000]);
  const px = (frame, y, x) => frame.pixels[y * web.width + x];
  // A body pixel (row 2, column 0 → y 4 + 32 + 8, x 4 + 8), the outline just left of it, and the corner left empty.
  assert.equal(px(web.frames[0], 44, 12), 2);
  assert.equal(px(web.frames[0], 44, 3), 1);
  assert.equal(px(web.frames[0], 0, 0), 0);
  assert.equal(px(web.frames[1], 4 + 16 + 4, 4 + 16 + 4), 3, "the second frame's changed pixel uses the second colour");
  const tg = readGif(drawn.telegram.bytes);
  assert.equal(tg.width, 272);
  assert.ok(tg.frames.every((frame) => !frame.transparent));
});

await test("drawings that cannot be drawn say why", () => {
  const row = "X".repeat(8);
  const rows = Array(8).fill(row);
  assert.match(m.drawSticker({ palette: { X: "#000" }, frames: [] }).error, /1 to 8 frames/);
  assert.match(m.drawSticker({ palette: { X: "#000" }, frames: [rows.slice(0, 4)] }).error, /8 to 32/);
  assert.match(m.drawSticker({ palette: { X: "#000" }, frames: [Array(40).fill("X".repeat(40))] }).error, /8 to 32/);
  assert.match(m.drawSticker({ palette: { X: "#000" }, frames: [rows, rows.slice(0, 7).concat(["X"])].map((f, i) => (i ? f.slice(0, 7) : f)) }).error, /same 8 rows/);
  assert.match(m.drawSticker({ palette: { X: "red" }, frames: [rows] }).error, /colour like/);
  assert.match(m.drawSticker({ palette: { XY: "#000" }, frames: [rows] }).error, /one character/);
  assert.match(m.drawSticker({ palette: { X: "#000" }, frames: [rows.map(() => "XXXXZZZZ")] }).error, /Not in the palette: Z/);
  assert.ok(!("error" in m.drawSticker({ palette: { X: "#000" }, frames: [rows], outline: false })));
});

// ---- still stickers, for WeCom ----

/** A GIF built frame by frame: each frame its own rectangle, disposal, transparent index and interlacing. */
function rawGif({ width, height, palette, frames }) {
  const bytes = [];
  const word = (v) => bytes.push(v & 0xff, (v >> 8) & 0xff);
  bytes.push(..."GIF89a".split("").map((c) => c.charCodeAt(0)));
  word(width);
  word(height);
  bytes.push(0x80 | 1, 0, 0); // a global table of 4 colours
  for (let i = 0; i < 4; i += 1) bytes.push(...(palette[i] ?? [0, 0, 0]));
  for (const f of frames) {
    bytes.push(0x21, 0xf9, 4, ((f.disposal ?? 0) << 2) | (f.transparent != null ? 1 : 0), 10, 0, f.transparent ?? 0, 0);
    bytes.push(0x2c);
    word(f.left ?? 0);
    word(f.top ?? 0);
    word(f.w);
    word(f.h);
    bytes.push(f.interlace ? 0x40 : 0);
    // Interlaced data comes in the four passes' row order.
    let indices = f.indices;
    if (f.interlace) {
      const order = [];
      for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < f.h; y += step) order.push(y);
      indices = Uint8Array.from(order.flatMap((y) => [...f.indices.subarray(y * f.w, (y + 1) * f.w)]));
    }
    bytes.push(2);
    const data = gif.lzw(indices, 2);
    for (let at = 0; at < data.length; at += 255) {
      const block = data.subarray(at, at + 255);
      bytes.push(block.length, ...block);
    }
    bytes.push(0);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

/** A PNG read back with node's own zlib: its size, colour type, pixels, and whether every CRC is right. */
function readPng(bytes) {
  const buf = Buffer.from(bytes);
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8;
  const chunks = [];
  while (at < buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.subarray(at + 4, at + 8).toString("latin1");
    const data = buf.subarray(at + 8, at + 8 + length);
    assert.equal(buf.readUInt32BE(at + 8 + length), crc32(buf.subarray(at + 4, at + 8 + length)), `${type} CRC`);
    chunks.push({ type, data });
    at += 12 + length;
  }
  assert.deepEqual(chunks.map((c) => c.type), ["IHDR", "IDAT", "IEND"]);
  const ihdr = chunks[0].data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const raw = inflateSync(chunks[1].data);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (width * 4 + 1)], 0, "filter none");
    rgba.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  }
  return { width, height, depth: ihdr[8], colour: ihdr[9], rgba };
}

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];

await test("the GIF reader draws frames as a browser would: rectangles, kept or cleared, put back, interlaced", () => {
  const W = 4;
  const H = 8;
  const fill = (w, h, index) => new Uint8Array(w * h).fill(index);
  // Frame 1: the left half red, kept. Frame 2: one blue pixel on the right, put back after (disposal 3).
  // Frame 3: the right half blue (more of the picture now), then cleared (disposal 2). Frame 4: nothing new.
  const bytes = rawGif({
    width: W,
    height: H,
    palette: [[0, 0, 0], RED, BLUE],
    frames: [
      { w: 2, h: H, indices: fill(2, H, 1), disposal: 1, transparent: 0 },
      { left: 3, top: 0, w: 1, h: 1, indices: fill(1, 1, 2), disposal: 3, transparent: 0 },
      { left: 2, top: 0, w: 2, h: H, indices: fill(2, H, 2), disposal: 2, transparent: 0, interlace: true },
      { left: 0, top: 0, w: 1, h: 1, indices: fill(1, 1, 0), transparent: 0 }
    ]
  });
  const frame = gif.fullestGifFrame(bytes);
  assert.deepEqual([frame.width, frame.height], [W, H]);
  const at = (x, y) => [...frame.rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
  // The fullest is frame 3: the red half kept from frame 1, the blue half of its own.
  assert.deepEqual(at(0, 0), [...RED, 255]);
  assert.deepEqual(at(3, 7), [...BLUE, 255]);
  assert.deepEqual(at(2, 5), [...BLUE, 255], "interlaced rows in their places");
  // Without frame 3, the fullest is frame 2, the red half and one blue pixel.
  const two = gif.fullestGifFrame(
    rawGif({ width: W, height: H, palette: [[0, 0, 0], RED, BLUE], frames: [
      { w: 2, h: H, indices: fill(2, H, 1), disposal: 1, transparent: 0 },
      { left: 3, top: 0, w: 1, h: 1, indices: fill(1, 1, 2), disposal: 3, transparent: 0 },
      { left: 0, top: 0, w: 1, h: 1, indices: fill(1, 1, 0), transparent: 0 }
    ] })
  );
  assert.deepEqual([...two.rgba.subarray(12, 16)], [...BLUE, 255]);
  assert.deepEqual([...two.rgba.subarray(8, 12)], [0, 0, 0, 0], "see-through stays see-through");
  assert.equal(gif.fullestGifFrame(Uint8Array.from([1, 2, 3])), null);
  assert.equal(gif.fullestGifFrame(bytes.subarray(0, 13)), null, "no frames");
});

await test("a drawn sticker's GIF reads back as drawn, and the fuller frame is the one kept", () => {
  const small = ["........", "........", "...XX...", "...XX...", "........", "........", "........", "........"];
  const big = ["........", ".XXXXXX.", ".XXXXXX.", ".XXXXXX.", ".XXXXXX.", ".XXXXXX.", ".XXXXXX.", "........"];
  const drawn = m.drawSticker({ palette: { X: "#e84868" }, frames: [small, big, small] });
  const frame = gif.fullestGifFrame(drawn.web.bytes);
  assert.deepEqual([frame.width, frame.height], [136, 136]);
  const at = (x, y) => [...frame.rgba.subarray((y * 136 + x) * 4, (y * 136 + x) * 4 + 4)];
  // A cell of the big frame (row 1, column 1 → 4 + 16 + 8), its white outline, and the empty corner.
  assert.deepEqual(at(28, 28), [0xe8, 0x48, 0x68, 255]);
  assert.deepEqual(at(19, 28), [255, 255, 255, 255]);
  assert.deepEqual(at(0, 0), [0, 0, 0, 0]);
});

await test("the PNG writer: RGBA that node's zlib reads back pixel for pixel, every CRC right", async () => {
  const rgba = Uint8Array.from({ length: 3 * 2 * 4 }, (_, i) => (i * 37) & 0xff);
  const back = readPng(await png.encodePng(3, 2, rgba));
  assert.deepEqual([back.width, back.height, back.depth, back.colour], [3, 2, 8, 6]);
  assert.deepEqual([...back.rgba], [...rgba]);
});

await test("a sticker for WeCom: a GIF made a still PNG, enlarged, see-through kept; a big PNG and a JPEG as they are; WebP and WebM not here", async () => {
  const drawn = m.drawSticker({ palette: { X: "#3a7" }, frames: [Array(8).fill("..XXXX..")] });
  const still = await m.stillSticker(drawn.web);
  assert.equal(still.type, "image/png");
  const back = readPng(still.bytes);
  assert.deepEqual([back.width, back.height], [272, 272], "136 px doubled");
  const at = (x, y) => [...back.rgba.subarray((y * 272 + x) * 4, (y * 272 + x) * 4 + 4)];
  assert.deepEqual(at(0, 0), [0, 0, 0, 0], "the corner still see-through");
  // Doubled pixel for pixel: (44, 28) in the GIF, inside column 2, is (88..89, 56..57) here.
  for (const [x, y] of [[88, 56], [89, 56], [88, 57], [89, 57]]) assert.deepEqual(at(x, y), [0x33, 0xaa, 0x77, 255]);
  const wide = readPng((await m.stillSticker({ bytes: rawGif({ width: 300, height: 10, palette: [[0, 0, 0], RED], frames: [{ w: 300, h: 10, indices: new Uint8Array(3000).fill(1) }] }), type: "image/gif" })).bytes);
  assert.deepEqual([wide.width, wide.height], [300, 10], "big enough already: not enlarged");
  const pngFile = { bytes: makePng({ width: 300, height: 2, colour: 6, depth: 8, rows: [new Uint8Array(1200), new Uint8Array(1200)] }), type: "image/png" };
  assert.equal(await m.stillSticker(pngFile), pngFile, "a big PNG as it is");
  const jpeg = { bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]), type: "image/jpeg" };
  assert.equal(await m.stillSticker(jpeg), jpeg);
  assert.equal(await m.stillSticker({ bytes: new Uint8Array(WEBM), type: "video/webm" }), null);
  assert.equal(await m.stillSticker({ bytes: new Uint8Array(12), type: "image/webp" }), null);
  const broken = { bytes: Uint8Array.from([...Buffer.from("GIF89a"), 1, 0, 1, 0, 0, 0, 0]), type: "image/gif" };
  assert.equal(await m.stillSticker(broken), broken, "a GIF it cannot read goes as it is");
  const tiny = readPng((await m.stillSticker({ bytes: new Uint8Array(GIF), type: "image/gif" })).bytes);
  assert.deepEqual([tiny.width, tiny.height], [4, 4], "1 px enlarged at most 4 times");
  assert.ok(tiny.rgba.every((v, i) => i % 4 !== 3 || v === 0), "the test GIF's one pixel is see-through");
});

/** A PNG built by hand: unfiltered rows, each sent through the filter given for it (0 to 4). */
function makePng({ width, height, colour, depth, rows, filters = [], plte, trns, interlace = 0 }) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour];
  const bpp = Math.max(1, (channels * depth) >> 3);
  const paethOf = (a, b, c) => {
    const p = a + b - c;
    const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  const raw = [];
  rows.forEach((row, y) => {
    const f = filters[y % filters.length] ?? 0;
    const up = y ? rows[y - 1] : new Uint8Array(row.length);
    raw.push(f);
    for (let i = 0; i < row.length; i += 1) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = up[i];
      const c = i >= bpp ? up[i - bpp] : 0;
      const predict = [0, a, b, (a + b) >> 1, paethOf(a, b, c)][f];
      raw.push((row[i] - predict) & 0xff);
    }
  });
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), Buffer.from(data)]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([depth, colour, 0, 0, interlace], 8);
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(plte ? [chunk("PLTE", plte)] : []),
    ...(trns ? [chunk("tRNS", trns)] : []),
    chunk("IDAT", deflateSync(Buffer.from(raw))),
    chunk("IEND", [])
  ]));
}

await test("the PNG reader: every filter, a 4-bit palette with tRNS, 16-bit grey with a see-through grey, grey with alpha; interlaced and broken refused", async () => {
  // RGBA, 3 × 5, rows through filters 0 to 4.
  const rgba = Array.from({ length: 5 }, (_, y) => Uint8Array.from({ length: 12 }, (_, i) => (y * 53 + i * 29) & 0xff));
  const back = await png.decodePng(makePng({ width: 3, height: 5, colour: 6, depth: 8, rows: rgba, filters: [0, 1, 2, 3, 4] }));
  assert.deepEqual([...back.rgba], rgba.flatMap((row) => [...row]));
  // Palette, 4 bits a pixel: indices 0..4 in a row of 5, index 1 see-through, index 2 half.
  const plte = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150];
  const packed = Uint8Array.from([0x01, 0x23, 0x40]);
  const palette = await png.decodePng(makePng({ width: 5, height: 1, colour: 3, depth: 4, rows: [packed], plte, trns: [255, 0, 128] }));
  assert.deepEqual([...palette.rgba], [10, 20, 30, 255, 40, 50, 60, 0, 70, 80, 90, 128, 100, 110, 120, 255, 130, 140, 150, 255]);
  // Grey, 16 bits: 0x1234 shows as 0x12; tRNS names 0xabcd see-through.
  const grey = await png.decodePng(makePng({ width: 2, height: 1, colour: 0, depth: 16, rows: [Uint8Array.from([0x12, 0x34, 0xab, 0xcd])], trns: [0xab, 0xcd] }));
  assert.deepEqual([...grey.rgba], [0x12, 0x12, 0x12, 255, 0xab, 0xab, 0xab, 0]);
  const greyAlpha = await png.decodePng(makePng({ width: 1, height: 1, colour: 4, depth: 8, rows: [Uint8Array.from([200, 77])] }));
  assert.deepEqual([...greyAlpha.rgba], [200, 200, 200, 77]);
  // 1-bit grey: 0 black, 1 white.
  const bw = await png.decodePng(makePng({ width: 3, height: 1, colour: 0, depth: 1, rows: [Uint8Array.from([0b10100000])] }));
  assert.deepEqual([...bw.rgba], [255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  assert.equal(await png.decodePng(makePng({ width: 1, height: 1, colour: 6, depth: 8, rows: [new Uint8Array(4)], interlace: 1 })), null);
  assert.equal(await png.decodePng(new Uint8Array(PNG).subarray(0, 40)), null, "cut short");
  assert.equal(await png.decodePng(Uint8Array.from(GIF)), null);
});

await test("on WeCom, a see-through background is filled with the chat colour, half see-through edges blended; none leaves it", async () => {
  assert.deepEqual(m.hexColour("#EDEDED"), [237, 237, 237]);
  assert.equal(m.hexColour("none"), null);
  assert.equal(m.hexColour("red"), null);
  const grey = m.hexColour(m.DEFAULT_WECOM_STICKER_BACKGROUND);
  // A drawn sticker (a GIF): its empty corner becomes the grey, every pixel solid.
  const drawn = m.drawSticker({ palette: { X: "#3a7" }, frames: [Array(8).fill("..XXXX..")] });
  const filled = readPng((await m.stillSticker(drawn.web, grey)).bytes);
  assert.deepEqual([...filled.rgba.subarray(0, 4)], [237, 237, 237, 255]);
  assert.ok(filled.rgba.every((v, i) => i % 4 !== 3 || v === 255), "nothing see-through left");
  assert.deepEqual([...filled.rgba.subarray((56 * 272 + 88) * 4, (56 * 272 + 88) * 4 + 4)], [0x33, 0xaa, 0x77, 255], "the drawing itself unchanged");
  // A PNG sticker, 300 px wide so it is not enlarged: a half see-through pixel is blended with the grey.
  const row = new Uint8Array(300 * 4);
  row.set([255, 0, 0, 255, 0, 0, 255, 128, 0, 0, 0, 0]);
  const file = { bytes: makePng({ width: 300, height: 1, colour: 6, depth: 8, rows: [row] }), type: "image/png" };
  const blended = readPng((await m.stillSticker(file, grey)).bytes);
  assert.deepEqual([...blended.rgba.subarray(0, 12)], [255, 0, 0, 255, 118, 118, 246, 255, 237, 237, 237, 255]);
  // Without a colour the PNG goes as it came; so does one with nothing see-through.
  assert.equal(await m.stillSticker(file, null), file);
  const solid = { bytes: makePng({ width: 300, height: 1, colour: 2, depth: 8, rows: [new Uint8Array(900).fill(9)] }), type: "image/png" };
  assert.equal(await m.stillSticker(solid, grey), solid);
  // A small PNG is enlarged, and filled.
  const small = readPng((await m.stillSticker({ bytes: makePng({ width: 2, height: 2, colour: 6, depth: 8, rows: [new Uint8Array(8), new Uint8Array(8).fill(255)] }), type: "image/png" }, grey)).bytes);
  assert.deepEqual([small.width, small.height], [8, 8]);
  assert.deepEqual([...small.rgba.subarray(0, 4)], [237, 237, 237, 255]);
  assert.deepEqual([...small.rgba.subarray(small.rgba.length - 4)], [255, 255, 255, 255]);
});
