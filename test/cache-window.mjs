// Unit tests for the prompt cache's window and the boot packet's text (src/cache-window.ts, src/aelios.ts).
// Usage: node test/cache-window.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-cache-window-"));
const load = async (entry, external = []) => {
  const out = join(dir, entry.replace(/\W/g, "_") + ".mjs");
  await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error", external });
  return import(pathToFileURL(join(process.cwd(), out)).href);
};
const w = await load("src/cache-window.ts");
const a = await load("src/aelios.ts", ["ai", "zod"]);
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

const MIN = 60 * 1000;

await test("the cache lasts an hour, or five minutes with CACHE_TTL=5m", () => {
  assert.equal(w.cacheTtlMs(undefined), 60 * MIN);
  assert.equal(w.cacheTtlMs("1h"), 60 * MIN);
  assert.equal(w.cacheTtlMs(" 5m "), 5 * MIN);
  assert.equal(w.cacheTtlMs("whatever"), 60 * MIN);
});

await test("a new window opens only when the cache has run out, a letter has folded the chat, or there is none yet", () => {
  const now = 1_000_000_000;
  const hour = 60 * MIN;
  const warm = { usedAt: now - 44 * MIN, openedAt: now - 6 * hour, folded: false };
  // 23:40 after a 17:40 start: six hours on, but used 44 minutes ago, so still the same window.
  assert.equal(w.opensWindow(warm, now, hour), false);
  assert.equal(w.opensWindow({ ...warm, usedAt: now - 61 * MIN }, now, hour), true);
  assert.equal(w.opensWindow({ ...warm, usedAt: now - 6 * MIN }, now, 5 * MIN), true);
  assert.equal(w.opensWindow({ ...warm, folded: true }, now, hour), true);
  assert.equal(w.opensWindow({ usedAt: null, openedAt: null, folded: false }, now, hour), true);
  assert.equal(w.opensWindow({ ...warm, openedAt: null }, now, hour), true);
});

await test("the letter's turn: the marker on the last message before the prompt that was not a tool's, or none when the cache ran out", () => {
  const cache = { type: "ephemeral", ttl: "1h" };
  const chat = [
    { role: "user", content: "早" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "t", toolName: "web_search", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "t", toolName: "web_search", output: { type: "text", value: "x" } }] },
    { role: "user", content: [{ type: "text", text: "再来一句" }], providerOptions: { other: { kept: true } } },
    { role: "assistant", content: "好" },
    { role: "user", content: "(Not from them: time to write a handoff letter" }
  ];
  const marked = w.markedForLetter(chat, cache);
  assert.deepEqual(marked[3].providerOptions, { other: { kept: true }, anthropic: { cacheControl: cache } });
  assert.deepEqual(marked.filter((m, i) => i !== 3), chat.filter((m, i) => i !== 3), "nothing else changes");
  assert.equal(chat[3].providerOptions.anthropic, undefined, "the turn's own messages are left as they were");
  assert.equal(w.markedForLetter(chat, null), chat);
  assert.equal(w.markedForLetter([chat[5]], cache).length, 1);
  assert.deepEqual(w.markedForLetter([chat[5]], cache), [chat[5]], "nothing before the prompt: no marker");
});

await test("the boot packet is the latest diary under its date, without precious notes or the glossary", () => {
  const data = {
    daily_log: { date: "2026-10-21", title: "闲聊日", summary: "聊了周末去哪儿玩。" },
    precious: [{ content: "说好了要一起去看海。" }],
    glossary: [{ term: "小橘", definition: "楼下那只猫" }]
  };
  assert.equal(a.bootText(data), "2026-10-21 的日记：聊了周末去哪儿玩。");
  assert.equal(a.bootText({ daily_log: { summary: "没写日期。" } }), "昨天：没写日期。");
  assert.equal(a.bootText({ precious: data.precious, glossary: data.glossary }), "");
  assert.equal(a.bootText({ daily_log: null }), "");
  assert.equal(a.bootText(undefined), "");
  const long = a.bootText({ daily_log: { date: "2026-10-21", summary: "长".repeat(5000) } });
  assert.equal(long.length, 3001);
  assert.ok(long.endsWith("…"));
});
