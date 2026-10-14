// Unit tests for which turns a handoff letter folds away (src/fold.ts). Usage: node test/fold.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-fold-"));
const out = join(dir, "fold.mjs");
await build({ entryPoints: ["src/fold.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const { foldIntoLetter, keptFrom, tokensIn, tokensOf } = await import(pathToFileURL(join(process.cwd(), out)).href);
rmSync(dir, { recursive: true, force: true });

let n = 0;
const say = (role, text) => ({ id: `m${n++}`, role, parts: [{ type: "text", text }] });
/** One exchange: her message and the answer, each about `size` tokens of Chinese. */
const exchange = (size) => [say("user", "今".repeat(size)), say("assistant", "好".repeat(size))];
const chat = (exchanges, size) => Array.from({ length: exchanges }, () => exchange(size)).flat();
const quiet = console.log;

let failures = 0;
async function step(name, fn) {
  console.log = () => {};
  try {
    await fn();
    console.log = quiet;
    console.log(`ok   ${name}`);
  } catch (error) {
    console.log = quiet;
    failures += 1;
    console.log(`FAIL ${name}\n${error.stack ?? error}`);
  }
}

await step("a Chinese character counts as a token, other text as a quarter", () => {
  assert.equal(tokensIn("今天下雨了"), 5);
  assert.equal(tokensIn("good morning"), 3);
  assert.equal(tokensIn("早，good morning！"), 6, "full-width punctuation counts like a character");
  assert.equal(tokensIn("𠀀𠀁"), 2, "characters outside the basic plane count once each");
});

await step("thinking does not count, pictures, tool calls and their results do", () => {
  const plain = tokensOf({ id: "a", role: "assistant", parts: [{ type: "text", text: "好" }] });
  const thought = tokensOf({ id: "a", role: "assistant", parts: [{ type: "reasoning", text: "x".repeat(4000) }, { type: "text", text: "好" }] });
  assert.equal(thought, plain);
  const picture = tokensOf({ id: "u", role: "user", parts: [{ type: "file", mediaType: "image/jpeg", url: "data:image/jpeg;base64,AAAA" }] });
  assert.equal(picture, 4 + 1600);
  const tool = tokensOf({ id: "a", role: "assistant", parts: [{ type: "tool-web_search", input: { query: "杭州天气" }, output: "多云转阵雨" }] });
  assert.ok(tool >= 4 + 4 + 5, `tool parts counted: ${tool}`);
});

await step("the kept part is the last 6000 tokens of Chinese, not four times that", () => {
  // 40 exchanges of 100 characters each: 8000 tokens after the first messages.
  const messages = chat(40, 100);
  const cut = keptFrom(messages, 6000);
  const kept = messages.slice(cut).reduce((sum, message) => sum + tokensOf(message), 0);
  // Over by at most her one message, which the kept part starts with.
  assert.ok(kept <= 6000 + tokensOf(messages[cut]) && kept > 5500, `kept ${kept}`);
  assert.equal(messages[cut].role, "user", "the kept part starts with her message");
});

await step("a short chat has nothing older to fold, and the letter is not asked for", async () => {
  let asked = 0;
  const fold = foldIntoLetter(6000, async () => (asked++, "信"));
  assert.equal(await fold(chat(10, 100)), null);
  assert.equal(asked, 0);
});

await step("a longer chat folds everything between the first messages and the kept part", async () => {
  const messages = chat(40, 100);
  const result = await foldIntoLetter(6000, async () => "信")(messages);
  const cut = keptFrom(messages, 6000);
  assert.equal(result.fromMessageId, messages[3].id);
  assert.equal(result.toMessageId, messages[cut - 1].id);
  assert.equal(result.summary, "信");
});

await step("at least her last message and its answer stay, even when they are longer than the budget", async () => {
  const messages = chat(4, 100);
  assert.equal(keptFrom(messages, 10), messages.length - 2);
  const result = await foldIntoLetter(10, async () => "信")(messages);
  assert.equal(result.toMessageId, messages[messages.length - 3].id);
});

await step("several messages of hers in a row stay together with the answer", () => {
  const messages = [...chat(3, 100), say("user", "在吗"), say("user", "我回来了"), say("assistant", "在")];
  assert.equal(keptFrom(messages, 10), messages.length - 3);
});

await step("an earlier letter is not folded again, and alone it is nothing to fold", async () => {
  const letter = { id: "compaction_1", role: "assistant", parts: [{ type: "text", text: "上一封信" }] };
  const head = chat(2, 10).slice(0, 3);
  let asked = 0;
  const fold = foldIntoLetter(10, async () => (asked++, "信"));
  assert.equal(await fold([...head, letter, ...exchange(100)]), null);
  assert.equal(asked, 0);
  const more = [...head, letter, ...chat(3, 100)];
  const result = await fold(more);
  assert.equal(result.fromMessageId, more[4].id, "starts after the earlier letter");
});

await step("an empty letter folds nothing", async () => {
  assert.equal(await foldIntoLetter(6000, async () => " ")(chat(40, 100)), null);
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
