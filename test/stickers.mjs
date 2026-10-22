// Unit tests for sticker packs and drawn stickers (src/stickers.ts, src/gif.ts). Usage: node test/stickers.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
