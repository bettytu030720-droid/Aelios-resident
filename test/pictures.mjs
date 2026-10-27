// Unit tests for the size of the photos she sends (src/pictures.ts): shrunk with Cloudflare Images when it is there,
// and never sent heavier than Claude takes.
// Usage: node test/pictures.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-pictures-"));
const out = join(dir, "pictures.mjs");
await build({
  stdin: { contents: 'export * from "./src/pictures.ts";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: out,
  logLevel: "error",
  // Think's messenger helpers import Workers-only modules that Node does not have; nothing here calls them.
  plugins: [{
    name: "workers-modules",
    setup(build) {
      build.onResolve({ filter: /^cloudflare:/ }, (args) => ({ path: args.path, namespace: "workers-stub" }));
      build.onLoad({ filter: /.*/, namespace: "workers-stub" }, () => ({
        contents: "export class RpcTarget {} export class DurableObject {} export class WorkerEntrypoint {} export class EmailMessage {} export const exports = {}; export const env = {}; export default {};",
        loader: "js"
      }));
    }
  }]
});
const { PICTURE_MAX_EDGE, PICTURE_SEND_BYTES, shrinkWith, withPictures } = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const test = async (name, run) => {
  await run();
  passed += 1;
  console.log(`ok - ${name}`);
};

const JPEG = (size) => Object.assign(new Uint8Array(size), { 0: 0xff, 1: 0xd8, 2: 0xff });
const SMALL_WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0]);

/** A stand-in for env.IMAGES: says the picture is width × height, and records what it was asked to do. */
function fakeImages({ width, height, format = "image/jpeg", out = JPEG(1000), fail = false }) {
  const calls = [];
  return {
    calls,
    async info() {
      if (fail) throw Object.assign(new Error("not an image"), { code: 9412 });
      return { format, fileSize: 1, width, height };
    },
    input() {
      const steps = [];
      const handle = {
        transform(transform) {
          steps.push(transform);
          return handle;
        },
        async output(options) {
          calls.push({ steps, options });
          return { contentType: () => options.format, image: () => new Response(out).body, response: () => new Response(out) };
        }
      };
      return handle;
    }
  };
}

await test("a phone's full-size photo is scaled down to the longest side Claude reads, as JPEG", async () => {
  const images = fakeImages({ width: 4032, height: 3024 });
  const smaller = await shrinkWith(images)(JPEG(3_000_000));
  assert.equal(smaller.length, 1000);
  assert.deepEqual(images.calls, [{ steps: [{ width: PICTURE_MAX_EDGE, height: PICTURE_MAX_EDGE, fit: "scale-down" }], options: { format: "image/jpeg", quality: 85 } }]);
});

await test("a PNG or anything not JPEG comes out as WebP, which keeps a see-through background", async () => {
  const images = fakeImages({ width: 3000, height: 2000, format: "image/png", out: SMALL_WEBP });
  await shrinkWith(images)(JPEG(10));
  assert.equal(images.calls[0].options.format, "image/webp");
});

await test("a picture already small enough is left alone", async () => {
  const images = fakeImages({ width: 1280, height: 960 });
  assert.equal(await shrinkWith(images)(JPEG(200_000)), null);
  assert.equal(images.calls.length, 0);
});

await test("small sides but too heavy is still shrunk", async () => {
  const images = fakeImages({ width: 1500, height: 1500 });
  assert.equal((await shrinkWith(images)(JPEG(PICTURE_SEND_BYTES + 1))).length, 1000);
});

await test("without the binding nothing is shrunk", async () => {
  assert.equal(shrinkWith(undefined), null);
});

const context = (attachments) => ({ thread: { id: "t", isDirectMessage: true }, message: { id: "x", text: "看图", author: { userId: "1", userName: "her" }, attachments } });
const attachment = (fileId, size = 100) => ({ type: "image", mediaType: "image/jpeg", size, fetchMetadata: { fileId } });
const her = { id: "m1", role: "user", parts: [{ type: "text", text: "看图" }] };
const pictures = (message) => message.parts.filter((part) => part.type === "file");

await test("the shrunk picture is what goes into her message", async () => {
  const images = fakeImages({ width: 4000, height: 3000, out: JPEG(1234) });
  const message = await withPictures(her, context([attachment("big")]), async () => JPEG(3_000_000), shrinkWith(images));
  const [picture] = pictures(message);
  assert.equal(picture.mediaType, "image/jpeg");
  assert.equal(Buffer.from(picture.url.split(",")[1], "base64").length, 1234);
});

await test("a picture Images cannot read goes as it came", async () => {
  const images = fakeImages({ width: 1, height: 1, fail: true });
  const message = await withPictures(her, context([attachment("odd")]), async () => JPEG(5000), shrinkWith(images));
  assert.equal(Buffer.from(pictures(message)[0].url.split(",")[1], "base64").length, 5000);
});

await test("heavier than Claude takes, and not shrunk, it stays a line of text", async () => {
  const message = await withPictures(her, context([attachment("huge", 4_000_000)]), async () => JPEG(4_000_000), null);
  assert.equal(pictures(message).length, 0);
  assert.equal(message, her, "nothing came down, so her message is as it was");
});

console.log(`${passed} passed`);
