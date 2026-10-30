// Stickers sent with a mark in the reply (src/sticker-marks.ts), without a Worker. Usage: node test/sticker-marks.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-sticker-marks-"));
const out = join(dir, "sticker-marks.mjs");
await build({ entryPoints: ["src/sticker-marks.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const { SENT_STICKER, stickerMarks, withoutStickerMarks } = await import(pathToFileURL(join(process.cwd(), out)).href);
rmSync(dir, { recursive: true, force: true });

assert.deepEqual(stickerMarks("抱抱你 [sticker: test/wave]"), { text: "抱抱你", stickers: ["test/wave"] });
assert.deepEqual(stickerMarks("[Sticker:  mine/heart ]"), { text: "", stickers: ["mine/heart"] }, "the whole reply; either case, spaces");
assert.deepEqual(stickerMarks("嗨～\n\n[sticker: test/wave]\n\n再说一句。"), { text: "嗨～\n\n再说一句。", stickers: ["test/wave"] }, "a paragraph that was only a mark leaves no gap");
assert.deepEqual(stickerMarks("一 [sticker: a/b] 二 [sticker: c/d]").stickers, ["a/b", "c/d"], "every mark, in order (the caller sends one)");
assert.deepEqual(stickerMarks("[sticker: ] 空的"), { text: "空的", stickers: [] });
const plain = "  不动的话 \n\n\n\n```\ncode  \n```  ";
assert.equal(stickerMarks(plain).text, plain, "words without a mark are left exactly as they are");
assert.equal(stickerMarks("[sticker 🤗 A hug.]").text, "[sticker 🤗 A hug.]", "her sticker, as the model reads it, is not a mark");
console.log("PASS marks: taken out wherever they are, every one named in order, no gap left, words without one untouched, hers not one");

assert.equal(withoutStickerMarks("抱抱你 [sticker: tes"), "抱抱你", "one still being written");
assert.equal(withoutStickerMarks("抱抱你 [sticker: test/wave] 晚安"), "抱抱你  晚安");
assert.equal(withoutStickerMarks("晚安"), "晚安");
assert.equal("a [sticker: x/y] b [sticker: z/w]".replace(SENT_STICKER, ""), "a  b ", "the global one with replace");
assert.equal("again [sticker: x/y]".replace(SENT_STICKER, ""), "again ", "and again: replace starts over each time");
console.log("PASS while a reply comes in: a half-written mark is not shown");
