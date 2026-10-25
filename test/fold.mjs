// Unit tests for letter triggering and the fixed recent chat window. Usage: node test/fold.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-fold-"));
const out = join(dir, "fold.mjs");
await build({ entryPoints: ["src/fold.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const { LETTER_KEEP_TOKENS, DEFAULT_LETTER_TOKEN_THRESHOLD, letterTokenThreshold, reachesLetterThreshold, chatTokens, foldIntoLetter, keptFrom, tokensIn, tokensOf } = await import(pathToFileURL(join(process.cwd(), out)).href);
rmSync(dir, { recursive: true, force: true });

let n = 0;
const say = (role, text) => ({ id: `m${n++}`, role, parts: [{ type: "text", text }] });
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
  assert.equal(tokensIn("早，good morning！"), 6);
  assert.equal(tokensIn("𠀀𠀁"), 2);
});

await step("thinking does not count, pictures, tool calls and their results do", () => {
  const plain = tokensOf(say("assistant", "好"));
  assert.equal(tokensOf({ ...say("assistant", "好"), parts: [{ type: "reasoning", text: "x".repeat(4000) }, { type: "text", text: "好" }] }), plain);
  assert.equal(tokensOf({ id: "u", role: "user", parts: [{ type: "file", mediaType: "image/jpeg", url: "data:image/jpeg;base64,AAAA" }] }), 4 + 1600);
  assert.ok(tokensOf({ id: "a", role: "assistant", parts: [{ type: "tool-web_search", input: { query: "杭州天气" }, output: "多云转阵雨" }] }) >= 4 + 4 + 5);
});

await step("the automatic threshold defaults to 30000 and must be an integer above the fixed 8000", () => {
  assert.equal(LETTER_KEEP_TOKENS, 8000);
  assert.equal(DEFAULT_LETTER_TOKEN_THRESHOLD, 30000);
  for (const invalid of [undefined, "", "8000", "10", "-1", "Infinity", "1e309", "abc", "9000.5", "9007199254740992"]) {
    assert.equal(letterTokenThreshold(invalid), 30000, String(invalid));
  }
  assert.equal(letterTokenThreshold(" 50000 "), 50000);
  assert.equal(letterTokenThreshold("8001"), 8001);
});

await step("the threshold counts current carried chat, including an older letter, and includes the exact boundary", () => {
  const messages = [say("user", "今".repeat(14996)), say("assistant", "好".repeat(14996))];
  assert.equal(chatTokens(messages), 30000);
  assert.equal(reachesLetterThreshold(messages, 30000), true);
  assert.equal(reachesLetterThreshold(messages, 30001), false);
  assert.equal(reachesLetterThreshold(messages, 50000), false);
  assert.equal(chatTokens([{ ...say("assistant", "旧信"), id: "compaction_1" }, ...messages]), 30006);
});

await step("the kept part is always about the last 8000 tokens, starting with a whole user exchange", () => {
  const messages = chat(60, 100);
  const cut = keptFrom(messages);
  const kept = chatTokens(messages.slice(cut));
  assert.ok(kept <= 8000 + tokensOf(messages[cut]) && kept > 7500, `kept ${kept}`);
  assert.equal(messages[cut].role, "user");
});

await step("short replies do not pull in a third large user message beyond the fixed window", () => {
  const messages = Array.from({ length: 5 }, () => [say("user", "文".repeat(3850)), say("assistant", "收到了")]).flat();
  assert.equal(keptFrom(messages), messages.length - 4);
  assert.ok(chatTokens(messages.slice(keptFrom(messages))) <= LETTER_KEEP_TOKENS);
});

await step("a short chat has nothing older to fold, and the letter is not asked for", async () => {
  let asked = 0, short = 0;
  const fold = foldIntoLetter(async () => (asked++, "信"), () => short++);
  assert.equal(await fold(chat(10, 100)), null);
  assert.equal(asked, 0);
  assert.equal(short, 1);
});

await step("a longer chat folds from the very first message, with no extra unbounded head kept", async () => {
  const messages = chat(60, 100);
  const result = await foldIntoLetter(async () => "信")(messages);
  const cut = keptFrom(messages);
  assert.equal(result.fromMessageId, messages[0].id);
  assert.equal(result.toMessageId, messages[cut - 1].id);
  assert.equal(result.summary, "信");
});

await step("at least the latest user exchange stays, even when that exchange exceeds 8000", async () => {
  const messages = [...chat(2, 100), ...exchange(5000)];
  assert.equal(keptFrom(messages), messages.length - 2);
  const result = await foldIntoLetter(async () => "信")(messages);
  assert.equal(result.toMessageId, messages[messages.length - 3].id);
  assert.equal(await foldIntoLetter(async () => "信")(exchange(5000)), null);
});

await step("several user messages and a multi-step tool reply stay in one exchange", () => {
  const messages = [
    ...chat(3, 3000), say("user", "在吗"), say("user", "我回来了"),
    { id: "tool-call", role: "assistant", parts: [{ type: "tool-web_search", input: {}, output: "词".repeat(9000) }] },
    say("assistant", "在")
  ];
  assert.equal(keptFrom(messages), messages.length - 4);
});

await step("an earlier letter is not used as a compaction endpoint, and alone is nothing to fold", async () => {
  const letter = { id: "compaction_1", role: "assistant", parts: [{ type: "text", text: "上一封信" }] };
  let asked = 0;
  const fold = foldIntoLetter(async () => (asked++, "信"));
  assert.equal(await fold([letter, ...exchange(5000)]), null);
  assert.equal(asked, 0);
  const more = [letter, ...chat(3, 3000)];
  const result = await fold(more);
  assert.equal(result.fromMessageId, more[1].id);
});

await step("an empty letter folds nothing", async () => {
  assert.equal(await foldIntoLetter(async () => " ")(chat(60, 100)), null);
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
