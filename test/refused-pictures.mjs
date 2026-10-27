// Unit tests for taking out pictures the provider refused (src/refused-pictures.ts).
// Usage: node test/refused-pictures.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-refused-"));
const out = join(dir, "refused.mjs");
await build({
  stdin: { contents: 'export * from "./src/refused-pictures.ts";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: out,
  logLevel: "error"
});
const { REFUSED_NOTE, REFUSED_PICTURE, refusalOf, refusedNotice, withoutRefused } = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

let passed = 0;
const test = (name, run) => {
  run();
  passed += 1;
  console.log(`ok - ${name}`);
};

const failure = (statusCode, error, message = error?.message ?? "failed") =>
  Object.assign(new Error(message), { statusCode, responseBody: JSON.stringify({ type: "error", error }) });
const picture = { type: "file", mediaType: "image/jpeg", url: "data:image/jpeg;base64,AAAA" };
const said = (id, text, ...extra) => ({ id, role: "user", parts: [{ type: "text", text }, ...extra] });
const reply = (id, text) => ({ id, role: "assistant", parts: [{ type: "text", text }] });

test("a 403, 413, 415 or 422 can be a picture's fault, with the provider's name for it", () => {
  assert.equal(refusalOf(failure(403, { type: "permission_error", message: "You tried to access something that you don't have permissions for." })), "403 permission_error");
  assert.equal(refusalOf(failure(413, { type: "request_too_large", message: "too large" })), "413 request_too_large");
  assert.equal(refusalOf(failure(422, { code: "unprocessable", message: "no" })), "422 unprocessable");
  assert.equal(refusalOf(Object.assign(new Error("Forbidden"), { statusCode: 415, responseBody: "<html>" })), "415");
});

test("a 400 counts only when it is about a picture", () => {
  assert.equal(refusalOf(failure(400, { type: "invalid_request_error", message: "Could not process image" })), "400 invalid_request_error");
  assert.equal(refusalOf(failure(400, { type: "invalid_request_error", message: "messages.0.content.1.image.source.base64: image exceeds 5 MB" })), "400 invalid_request_error");
  assert.equal(refusalOf(failure(400, { type: "invalid_request_error", message: "Invalid signature in thinking block" })), null);
});

test("the key, the bill, the model's name, the rate and outages are not a picture's fault", () => {
  for (const status of [401, 402, 404, 429, 500, 502, 529]) assert.equal(refusalOf(failure(status, { type: "x", message: "image" })), null, `${status}`);
  assert.equal(refusalOf(new Error("Stream error")), null);
  assert.equal(refusalOf("permission_error"), null);
  assert.equal(refusalOf(null), null);
});

test("the pictures she sent since the last answer come out, a line in their place", () => {
  const messages = [
    said("u1", "早", picture),
    reply("a1", "早呀"),
    said("u2", "看看这个", picture),
    { id: "a2", role: "assistant", parts: [{ type: "step-start" }] },
    said("u3", "我拍了发给你了", picture, picture),
    said("u4", "在吗？")
  ];
  const changed = withoutRefused(messages, "403 permission_error");
  assert.deepEqual(changed.map((m) => m.id), ["u2", "u3"], "an answered picture stays; an empty failed turn is no answer");
  const note = REFUSED_NOTE("403 permission_error");
  assert.deepEqual(changed[0].parts, [{ type: "text", text: "看看这个" }, { type: "text", text: note }]);
  assert.deepEqual(changed[1].parts.slice(1), [{ type: "text", text: note }, { type: "text", text: note }]);
  assert.equal(changed.every((m) => m.parts.every((p) => p.type !== "file")), true);
  assert.equal(note.match(REFUSED_PICTURE)?.length, 1, "the web page can find the note");
  assert.equal(messages[2].parts[1], picture, "the messages passed in are not changed");
});

test("with no unanswered picture, the pictures among the latest messages come out (answered under another model)", () => {
  const old = Array.from({ length: 6 }, (_, i) => [said(`o${i}`, "旧的", picture), reply(`r${i}`, "嗯")]).flat();
  const messages = [...old, said("u1", "看看", picture), reply("a1", "看到了"), said("u2", "换了模型再说一句")];
  assert.deepEqual(withoutRefused(messages, "403").map((m) => m.id), ["o4", "o5", "u1"]);
});

test("nothing to take out when no picture is left", () => {
  assert.deepEqual(withoutRefused([said("u1", "早"), reply("a1", "早呀"), said("u2", "在吗")], "403"), []);
  const done = withoutRefused([said("u1", "看", picture)], "403");
  assert.deepEqual(withoutRefused(done, "403"), [], "a second report of the same failure changes nothing");
});

test("she is told what happened and what to do", () => {
  const notice = refusedNotice("403 permission_error");
  assert.match(notice, /403 permission_error/);
  assert.match(notice, /拿掉/);
});

console.log(`${passed} passed`);
