// Unit tests for what a web search leaves in Aelios (src/web/learn.ts). Usage: node test/learn.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { MockLanguageModelV4 } from "ai/test";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-learn-"));
const out = join(dir, "learn.mjs");
await build({ entryPoints: ["src/web/learn.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error", external: ["ai"] });
const { asMemory, learnFromSearch, learnPrompt, parseFacts, searched, MAX_FACTS } = await import(pathToFileURL(join(process.cwd(), out)).href);
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

const response = { query: "抹茶和煎茶的区别", results: [{ title: "抹茶 - 维基百科", url: "https://zh.wikipedia.org/wiki/抹茶", description: "抹茶是用碾茶磨成的粉。" }] };

await test("a search is read as its query and the results as the model saw them", () => {
  const one = searched({ query: "抹茶和煎茶的区别" }, response);
  assert.equal(one.query, "抹茶和煎茶的区别");
  assert.match(one.results, /zh\.wikipedia\.org/);
  assert.match(one.results, /碾茶/);
  assert.equal(searched({}, "plain text").results, "plain text");
});

await test("the prompt carries the question, every search and the answer, the results cut to size", () => {
  const prompt = learnPrompt("[10-15 11:00 周三] 抹茶和煎茶有啥区别", [{ query: "a", results: "x".repeat(20000) }, { query: "b", results: "more" }], "答复");
  assert.match(prompt, /抹茶和煎茶有啥区别/);
  assert.match(prompt, /Search: a/);
  assert.match(prompt, /答复$/);
  assert.ok(prompt.length < 13000, String(prompt.length));
});

await test("facts are read from the JSON, keys cleaned, repeats and extras dropped", () => {
  const facts = parseFacts(`好的：{"facts":[
    {"key":"Matcha vs Sencha!","content":"抹茶是碾茶磨成的粉，煎茶是蒸青后揉捻的叶茶。(zh.wikipedia.org)"},
    {"key":"matcha-vs-sencha","content":"重复"},
    {"key":"","content":"没有 key"},
    {"key":"b","content":"二"},{"key":"c","content":"三"},{"key":"d","content":"四"}]}`);
  assert.equal(facts.length, MAX_FACTS);
  assert.deepEqual(facts[0], { key: "matcha-vs-sencha", content: "抹茶是碾茶磨成的粉，煎茶是蒸青后揉捻的叶茶。(zh.wikipedia.org)" });
  assert.deepEqual(parseFacts('{"facts":[]}'), []);
  assert.deepEqual(parseFacts("不是 JSON"), []);
  assert.equal(asMemory({ key: "k", content: "一句话" }, "2026-10-15"), "（2026-10-15 搜网）一句话");
});

await test("each fact is saved with remember as world knowledge under a stable key; a failed one does not stop the rest", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.authorization, ...body.params });
    if (body.params.arguments.fact_key === "world:broken") return new Response("no", { status: 500 });
    return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{}" }] } });
  };
  try {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: '{"facts":[{"key":"broken","content":"坏的"},{"key":"matcha","content":"抹茶是碾茶磨成的粉。(zh.wikipedia.org)"}]}' }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 10 }, outputTokens: { total: 10 } },
        warnings: []
      })
    });
    const saved = await learnFromSearch({
      model,
      memory: { url: "https://aelios.example", key: "k", namespace: "default", identity: "" },
      asked: "抹茶是什么",
      searches: [searched({ query: "抹茶" }, response)],
      reply: "抹茶是碾茶磨的粉。",
      day: "2026-10-15"
    });
    assert.equal(saved, 1);
    assert.equal(calls.length, 2);
    const ok = calls[1];
    assert.equal(ok.url, "https://aelios.example/mcp");
    assert.equal(ok.auth, "Bearer k");
    assert.equal(ok.name, "remember");
    assert.deepEqual(ok.arguments, {
      content: "（2026-10-15 搜网）抹茶是碾茶磨成的粉。(zh.wikipedia.org)",
      fact_key: "world:matcha",
      type: "world_fact",
      tags: ["搜网"],
      importance: 0.4,
      namespace: "default"
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
