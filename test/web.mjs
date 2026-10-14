// Unit tests for web_fetch (src/web/fetch.ts), run in Node with every network call faked: redirects are
// checked hop by hop, an empty JavaScript page goes to the browser, pages are cached, long pages are
// shrunk, and a page in GBK is decoded. Usage: node test/web.mjs
// (esbuild comes with wrangler; it bundles the TypeScript for Node.)
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "resident-web-"));
const out = join(dir, "fetch.mjs");
await build({ entryPoints: ["src/web/fetch.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const { webFetchTool } = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

// --- The fake internet -----------------------------------------------------------------------------

const PUBLIC = "93.184.216.34";
const article = (title, text) => `<html><head><title>${title}</title></head><body><article><p>${text}</p></article></body></html>`;
const LONG = "今天的新闻很长。".repeat(200);
const GBK = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7]); // 你好世界
let requests = [];

const pages = {
  "https://example.com/a": () => new Response(null, { status: 302, headers: { location: "/b" } }),
  "https://example.com/b": () => html(article("第二页", "跳过来了。".repeat(120))),
  "https://example.com/to-local": () => new Response(null, { status: 301, headers: { location: "http://127.0.0.1/admin" } }),
  "https://example.com/to-evil": () => new Response(null, { status: 302, headers: { location: "https://evil.test/" } }),
  "https://example.com/loop": () => new Response(null, { status: 302, headers: { location: "https://example.com/loop" } }),
  "https://example.com/shell": () => html('<html><head><title>壳</title></head><body><div id="app"></div></body></html>'),
  "https://example.com/missing": () => new Response("nope", { status: 404 }),
  "https://example.com/photo": () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
  "https://example.com/long": () => html(article("长文", LONG)),
  "https://example.com/gbk": () => new Response(GBK, { headers: { "content-type": "text/plain; charset=gbk" } })
};

function html(body) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
    const name = new URL(url).searchParams.get("name");
    const type = new URL(url).searchParams.get("type");
    const data = name === "evil.test" ? "10.0.0.7" : PUBLIC;
    return Response.json({ Answer: type === "A" ? [{ data }] : [] });
  }
  requests.push({ url, redirect: init.redirect });
  const page = pages[url];
  if (!page) return new Response("not found", { status: 404 });
  return page();
};

function browser() {
  const calls = [];
  return {
    calls,
    async quickAction(action, options) {
      calls.push({ action, options });
      return Response.json({
        success: true,
        result: article("壳", "脚本跑完以后才有的正文。".repeat(60)),
        meta: { status: 200, title: "壳", finalUrl: options.url }
      });
    }
  };
}

function cache() {
  const pages = new Map();
  return { pages, get: (url) => pages.get(url) ?? null, put: (url, page) => pages.set(url, page) };
}

function ai(answer) {
  const calls = [];
  return {
    calls,
    async run(model, inputs, options) {
      calls.push({ model, inputs, options });
      if (answer instanceof Error) throw answer;
      return answer;
    }
  };
}

const read = (reader, input) => webFetchTool(reader).execute(input, { toolCallId: "t", messages: [] });
let failures = 0;
async function step(name, fn) {
  requests = [];
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n${error.stack ?? error}`);
  }
}

// --- Tests -----------------------------------------------------------------------------------------

await step("a redirect is followed after its target is checked", async () => {
  const text = await read({ compressor: null }, { url: "https://example.com/a" });
  assert.match(text, /^# 第二页\nhttps:\/\/example\.com\/b\n/);
  assert.ok(text.includes("跳过来了。"));
  assert.deepEqual(requests.map((r) => r.redirect), ["manual", "manual"]);
});

await step("a redirect to a local or private address is refused before it is followed", async () => {
  const local = await read({ compressor: null, browser: browser() }, { url: "https://example.com/to-local" });
  assert.match(local, /^Could not read this page: it redirected somewhere it may not go/);
  const evil = await read({ compressor: null, browser: browser() }, { url: "https://example.com/to-evil" });
  assert.match(evil, /^Could not read this page: it redirected somewhere it may not go/);
  assert.ok(!requests.some((r) => r.url.includes("127.0.0.1") || r.url.includes("evil.test")), JSON.stringify(requests));
});

await step("endless redirects stop", async () => {
  const text = await read({ compressor: null }, { url: "https://example.com/loop" });
  assert.match(text, /redirected more than 5 times/);
  assert.equal(requests.length, 6);
});

await step("a local address is refused outright", async () => {
  const text = await read({ compressor: null }, { url: "http://localhost:8787/web/messages" });
  assert.match(text, /^Cannot read this URL/);
  assert.equal(requests.length, 0);
});

await step("an empty JavaScript page is opened in the browser, without pictures", async () => {
  const b = browser();
  const text = await read({ compressor: null, browser: b }, { url: "https://example.com/shell" });
  assert.ok(text.includes("脚本跑完以后才有的正文。"), text);
  assert.ok(text.includes("(opened in a browser)"));
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].action, "content");
  assert.deepEqual(b.calls[0].options.rejectResourceTypes, ["image", "media", "font"]);
  // Requests to private addresses written in the URL are refused inside the browser too.
  const blocked = (url) => b.calls[0].options.rejectRequestPattern.some((pattern) => new RegExp(pattern).test(url));
  for (const url of ["http://127.0.0.1/", "http://169.254.169.254/latest", "http://10.1.2.3:8080/x", "http://192.168.1.1/", "http://172.20.0.1/", "http://localhost:8787/", "http://[::1]/", "http://user@10.0.0.1/"]) {
    assert.ok(blocked(url), `the browser may not load ${url}`);
  }
  for (const url of ["https://example.com/", "https://172.217.1.1/", "https://news.10.example/", "https://www.localhost-news.com/"]) {
    assert.ok(!blocked(url), `the browser may load ${url}`);
  }
});

await step("without a browser, the empty page comes back as it is", async () => {
  const text = await read({ compressor: null }, { url: "https://example.com/shell" });
  assert.match(text, /^# 壳\n/);
  assert.ok(!text.includes("opened in a browser"));
});

await step("a missing page or a picture is not retried in the browser", async () => {
  const b = browser();
  assert.match(await read({ compressor: null, browser: b }, { url: "https://example.com/missing" }), /HTTP 404/);
  assert.match(await read({ compressor: null, browser: b }, { url: "https://example.com/photo" }), /image\/png, not a text page/);
  assert.equal(b.calls.length, 0);
});

await step("a page read once is kept: another question about it fetches nothing", async () => {
  const c = cache();
  await read({ compressor: null, cache: c }, { url: "https://example.com/b" });
  assert.equal(requests.length, 1);
  const again = await read({ compressor: null, cache: c }, { url: "https://example.com/b", query: "别的" });
  assert.ok(again.includes("跳过来了。"));
  assert.equal(requests.length, 1);
});

await step("with a query, a long page is cut down to what answers it", async () => {
  const model = ai({ response: "## 长文\n今天的新闻很长。" });
  const text = await read({ compressor: { ai: model, model: "@cf/qwen/qwen3-30b-a3b-fp8" } }, { url: "https://example.com/long", query: "今天怎么了" });
  assert.ok(text.includes("(only the parts about: 今天怎么了)"), text);
  assert.ok(text.endsWith("## 长文\n今天的新闻很长。"), text);
  assert.equal(model.calls.length, 1);
  const [system, user] = model.calls[0].inputs.messages;
  assert.ok(system.content.endsWith("/no_think"), "Qwen3 is told not to think");
  assert.ok(user.content.startsWith("Question: 今天怎么了"));
});

await step("the same question about the same page is answered from the cache", async () => {
  const c = cache();
  const model = ai({ response: "摘出来的段落" });
  const reader = { compressor: { ai: model, model: "@cf/qwen/qwen3-30b-a3b-fp8" }, cache: c };
  const first = await read(reader, { url: "https://example.com/long", query: "今天怎么了" });
  const again = await read(reader, { url: "https://example.com/long", query: "今天怎么了" });
  assert.equal(again, first);
  assert.equal(model.calls.length, 1);
  assert.equal(requests.length, 1);
  await read(reader, { url: "https://example.com/long", query: "别的问题" });
  assert.equal(model.calls.length, 2, "another question asks the model again, without refetching");
  assert.equal(requests.length, 1);
});

await step("a section that answers NOTHING_RELEVANT is dropped, a passage that mentions it is kept", async () => {
  const nothing = await read({ compressor: { ai: ai({ response: "NOTHING_RELEVANT." }), model: "m" } }, { url: "https://example.com/long", query: "猫" });
  assert.match(nothing, /Nothing on this page seems to be about: 猫/);
  const kept = await read({ compressor: { ai: ai({ response: "The flag NOTHING_RELEVANT is used by the tool." }), model: "m" } }, { url: "https://example.com/long", query: "flag" });
  assert.ok(kept.endsWith("The flag NOTHING_RELEVANT is used by the tool."), kept);
});

await step("a short page with no query is not sent to the model", async () => {
  const model = ai({ response: "x" });
  await read({ compressor: { ai: model, model: "@cf/qwen/qwen3-30b-a3b-fp8" } }, { url: "https://example.com/long" });
  assert.equal(model.calls.length, 0);
});

await step("an OpenAI-shaped answer with a think block is read, and the gateway is used", async () => {
  const model = ai({ choices: [{ message: { content: "<think>想想</think>\n摘到的内容" } }] });
  const text = await read({ compressor: { ai: model, model: "@cf/qwen/qwen3-30b-a3b-fp8", gateway: "gw" } }, { url: "https://example.com/long", query: "新闻" });
  assert.ok(text.endsWith("摘到的内容"), text);
  assert.deepEqual(model.calls[0].options.gateway, { id: "gw" });
  assert.ok(model.calls[0].options.signal instanceof AbortSignal, "the model call can be cancelled");
});

await step("when the model fails, the page comes back whole", async () => {
  const model = ai(new Error("down"));
  const text = await read({ compressor: { ai: model, model: "@cf/qwen/qwen3-30b-a3b-fp8" } }, { url: "https://example.com/long", query: "新闻" });
  assert.ok(text.includes("今天的新闻很长。今天的新闻很长。"));
  assert.ok(text.includes("could not be shortened"));
});

await step("when web_fetch gives up, the model call is stopped and the page comes back whole", async () => {
  const hanging = { calls: [], run: (model, inputs, options) => new Promise((_, reject) => {
    hanging.calls.push(options);
    options.signal.addEventListener("abort", () => reject(new Error("aborted")));
  }) };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const started = Date.now();
  const text = await webFetchTool({ compressor: { ai: hanging, model: "@cf/qwen/qwen3-30b-a3b-fp8" } }).execute(
    { url: "https://example.com/long", query: "新闻" },
    { toolCallId: "t", messages: [], abortSignal: controller.signal }
  );
  assert.ok(Date.now() - started < 3000, "it does not wait for the model's own timeout");
  assert.ok(text.includes("今天的新闻很长。"), text);
  assert.ok(hanging.calls[0].signal.aborted, "the model call was cancelled");
});

await step("a page in GBK is decoded", async () => {
  const text = await read({ compressor: null }, { url: "https://example.com/gbk" });
  assert.ok(text.endsWith("你好世界"), text);
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
