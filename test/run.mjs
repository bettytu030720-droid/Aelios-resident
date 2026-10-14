// Drives the local Worker (wrangler dev on :8787, wrangler.test.jsonc) with fake Telegram
// updates and checks what reached the mocked Telegram API and Aelios (mock-server.mjs on :9999).
// Usage: node test/run.mjs [phase]
//   main     (default) everything that needs one fresh Worker
//   checkin  needs a schedule (start wrangler with --var CHECKIN_SCHEDULE:"every 1 minute")
//   auto     needs LETTER_AFTER_TOKENS small (start wrangler with --var LETTER_AFTER_TOKENS:400)
//   crash-1  sends a slow reply; kill workerd once the first bubble is out, restart, then run crash-2
//   crash-2  checks what she got after the restart
//   migrate  needs the old model variable (start wrangler with --var MODEL:fake)
import assert from "node:assert/strict";

const WORKER = "http://127.0.0.1:8787";
const MOCK = "http://127.0.0.1:9999";
const SECRET = "test-secret";
const phase = process.argv[2] ?? "main";

let nextId = { main: 100, checkin: 200, auto: 300, "crash-1": 500, "crash-2": 600, migrate: 700 }[phase] ?? 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = async () => (await fetch(`${MOCK}/__log`)).json();
// MarkdownV2 escapes punctuation with a backslash; tests compare the plain text.
const plain = (text) => text.replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, "$1");
const sent = async () =>
  (await log()).filter((e) => e.kind === "tg.sendMessage").map((e) => plain(e.body.text ?? ""));

async function post(text, { username = "her_test", messageId = nextId++, secret = SECRET, chatType = "private", chatId = 42 } = {}) {
  const update = {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      text,
      from: { id: chatId, is_bot: false, username, first_name: "Her" },
      chat: { id: chatId, type: chatType, username, first_name: "Her" }
    }
  };
  const response = await fetch(`${WORKER}/messengers/telegram/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(update)
  });
  return { status: response.status, update };
}

async function resend(update) {
  return fetch(`${WORKER}/messengers/telegram/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
    body: JSON.stringify(update)
  });
}

/** Wait until the bot has sent `count` more messages than `before`. */
async function waitForSends(before, count, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    const all = await sent();
    if (all.length >= before + count) return all.slice(before);
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out: wanted ${count} new sends, have ${all.length - before}: ${JSON.stringify(all.slice(before))}`);
    }
    await sleep(200);
  }
}

async function step(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

if (phase === "main") {
  await fetch(`${MOCK}/__reset`);

  await step("wrong secret is rejected", async () => {
    const { status } = await post("hi", { secret: "nope" });
    assert.equal(status, 401);
  });

  await step("strangers and group chats get no answer", async () => {
    const before = (await sent()).length;
    assert.equal((await post("hi", { username: "stranger", chatId: 7 })).status, 200);
    assert.equal((await post("hi", { chatType: "group" })).status, 200);
    await sleep(2500);
    assert.equal((await sent()).length, before);
  });

  let first;
  await step("a message gets two bubbles, with the time stamp the model saw", async () => {
    const before = (await sent()).length;
    const { status, update } = await post("你好");
    first = update;
    assert.equal(status, 200);
    const out = await waitForSends(before, 2);
    assert.match(out[0], /^收到：\[\d\d-\d\d 周. \d\d:\d\d\] 你好$/);
    assert.equal(out[1], "这是第二个气泡。");
  });

  await step("typing indicator was sent", async () => {
    const typing = (await log()).filter((e) => e.kind === "tg.sendChatAction");
    assert.ok(typing.length >= 1);
  });

  await step("Telegram resending the same update does not answer twice", async () => {
    const before = (await sent()).length;
    await resend(first);
    await sleep(3000);
    assert.equal((await sent()).length, before);
  });

  await step("the Aelios boot packet is in the system prompt", async () => {
    const before = (await sent()).length;
    await post("开机包");
    assert.deepEqual(await waitForSends(before, 1), ["开机包在。"]);
    const boot = (await log()).filter((e) => e.kind === "aelios.boot");
    assert.ok(boot.length >= 1);
    assert.equal(boot[0].auth, "Bearer test-key");
    assert.match(boot[0].query, /namespace=test-space/);
  });

  await step("memory_recall reaches Aelios and the answer uses it", async () => {
    const before = (await sent()).length;
    await post("帮我查记忆");
    const out = await waitForSends(before, 1);
    assert.match(out[0], /^我查到了：1\. 她的生日在春天/);
    const recall = (await log()).filter((e) => e.kind === "aelios.recall").at(-1);
    assert.equal(recall.body.namespace, "test-space");
    assert.equal(recall.auth, "Bearer test-key");
  });

  await step("web_fetch reads a page through the web-fetch Worker, and refuses local addresses", async () => {
    let before = (await sent()).length;
    await post("帮我读新闻");
    const out = (await waitForSends(before, 2)).join("\n");
    assert.match(out, /^我查到了：/);
    assert.ok(out.includes("测试新闻") && out.includes("今天的测试新闻：一切正常。"), out);
    const call = (await log()).filter((e) => e.kind === "webfetch").at(-1);
    assert.equal(call.auth, "Bearer test-fetch-key");
    assert.equal(call.body.url, "https://example.com/news");
    assert.equal(call.body.query, "今天发生了什么");
    before = (await sent()).length;
    await post("帮我读本机");
    const [refused] = await waitForSends(before, 1);
    assert.match(refused, /^我查到了：Cannot read this URL/);
    assert.equal((await log()).filter((e) => e.kind === "webfetch").length, 1, "the local address never left the resident");
  });

  await step("a memory comes up by itself before the reply, once, and stays on its message", async () => {
    let before = (await sent()).length;
    await post("生日那天想浮现一下");
    assert.deepEqual(await waitForSends(before, 1), ["这条：有，之前带着的：0"]);
    const asked = (await log()).filter((e) => e.kind === "aelios.recall" && e.body.query === "生日那天想浮现一下");
    assert.equal(asked.length, 1, "searched with her words, time stamp left out");
    assert.equal(asked[0].body.namespace, "test-space");
    // The same memory does not come up again, and the earlier one is still where it was.
    before = (await sent()).length;
    await post("还是生日，再浮现");
    assert.deepEqual(await waitForSends(before, 1), ["这条：无，之前带着的：1"]);
    const recorded = (await log()).filter((e) => e.kind === "aelios.ingest").flatMap((e) => e.body.messages);
    assert.ok(recorded.some((m) => m.content.includes("生日那天想浮现一下")));
    assert.ok(!recorded.some((m) => m.content.includes("想起的旧事")), "what came up is not recorded as hers");
    const page = await (await fetch(`${WORKER}/web/messages`, { headers: { "x-web-key": "test-web-key" } })).json();
    assert.ok(page.data.some((l) => l.text === "生日那天想浮现一下"), JSON.stringify(page.data));
    assert.ok(!page.data.some((l) => l.text.includes("想起的旧事")), "what came up stays out of the page");
  });

  await step("each exchange is recorded in Aelios", async () => {
    const ingests = (await log()).filter((e) => e.kind === "aelios.ingest" && e.body.source === "aelios-resident");
    assert.ok(ingests.length >= 3);
    const one = ingests[0].body;
    assert.equal(one.conversation_id, "test-space:aelios-resident");
    assert.deepEqual(one.messages.map((m) => m.role), ["user", "assistant"]);
    assert.match(one.messages[0].content, /你好$/);
  });

  await step("three quick messages are answered once, together", async () => {
    const before = (await sent()).length;
    await post("一");
    await post("二");
    await post("三");
    const out = await waitForSends(before, 2);
    await sleep(3000);
    const all = (await sent()).slice(before);
    assert.equal(all.length, 2, JSON.stringify(all));
    assert.match(out[0], /^收到：\[[^\]]+\] 一\n二\n三$/);
  });

  await step("/status answers without a model turn", async () => {
    const before = (await sent()).length;
    await post("/status");
    const [out] = await waitForSends(before, 1);
    assert.match(out, /^模型：fake\n/);
    assert.match(out, /\n对话：\d+ 条/);
    assert.match(out, /交接信：0 封/);
    assert.match(out, /人设：还没填/);
    assert.match(out, /\n上一次调用模型：输入 \d+ token，其中缓存读 \d+/);
    assert.match(out, /主动找你：关/);
  });

  await step("/letter before any letter", async () => {
    const before = (await sent()).length;
    await post("/letter");
    assert.deepEqual(await waitForSends(before, 1), ["还没写过交接信。"]);
  });

  await step("/handoff writes a letter, and the conversation carries it", async () => {
    let before = (await sent()).length;
    await post("/handoff");
    const [out] = await waitForSends(before, 1, 30000);
    assert.match(out, /^交接信写好了，旧的聊天收起来了：\n\n亲爱的下一个我/);
    before = (await sent()).length;
    await post("交接信在吗");
    assert.deepEqual(await waitForSends(before, 1), ["交接信在。"]);
    const letterIngest = (await log()).filter((e) => e.kind === "aelios.ingest" && e.body.source === "aelios-resident:letter");
    assert.equal(letterIngest.length, 1);
    assert.match(letterIngest[0].body.messages[0].content, /^（交接信）亲爱的下一个我/);
  });

  await step("/letter shows the latest letter", async () => {
    const before = (await sent()).length;
    await post("/letter");
    const [out] = await waitForSends(before, 1);
    assert.match(out, /写的：\n\n亲爱的下一个我/);
  });

  const web = (path, key, body) =>
    fetch(`${WORKER}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "x-web-key": key, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });

  await step("the web door is shut without WEB_KEY", async () => {
    assert.equal((await fetch(`${WORKER}/web/messages`)).status, 401);
    assert.equal((await web("/web/messages", "wrong")).status, 401);
    assert.equal((await web("/web/check", "test-web-key")).status, 200);
  });

  await step("the web door sees the Telegram conversation, letter included", async () => {
    const response = await web("/web/messages", "test-web-key");
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.ok(data.some((l) => l.kind === "letter" && l.text.includes("亲爱的下一个我")), JSON.stringify(data));
    const asked = data.find((l) => l.role === "user" && l.text === "交接信在吗");
    assert.ok(asked, JSON.stringify(data));
    assert.equal(asked.via, "telegram");
    assert.equal(typeof asked.at, "number");
    assert.ok(data.some((l) => l.role === "assistant" && l.text === "交接信在。" && l.via === "telegram"));
  });

  await step("a message typed on the web is answered there, not on Telegram", async () => {
    const before = (await sent()).length;
    const response = await web("/web/say", "test-web-key", { text: "网页上说一句" });
    assert.deepEqual(await response.json(), { status: "completed" });
    const { data } = await (await web("/web/messages", "test-web-key")).json();
    const said = data.findLast((l) => l.role === "user");
    assert.equal(said.text, "网页上说一句");
    assert.equal(said.via, "web");
    assert.equal(typeof said.at, "number");
    const reply = data.at(-1);
    assert.equal(typeof reply.at, "number");
    assert.match(reply.text, /^收到：\[[^\]]+\] 网页上说一句/);
    await sleep(1500);
    assert.equal((await sent()).length, before);
  });

  await step("the heart keeps a line in Aelios' precious memories", async () => {
    const response = await web("/web/pin", "test-web-key", { text: "这是第二个气泡。" });
    assert.deepEqual(await response.json(), { ok: true });
    const precious = (await log()).filter((e) => e.kind === "aelios.precious").at(-1);
    assert.equal(precious.body.content, "这是第二个气泡。");
    assert.equal(precious.body.namespace, "test-space");
  });

  await step("every turn asks for prompt caching (Claude's Messages API reads it)", async () => {
    const before = (await sent()).length;
    await post("缓存在吗");
    assert.deepEqual(await waitForSends(before, 1), ["缓存标记在。"]);
  });

  await step("the model is picked on the web, after one trial call, and remembered as recent", async () => {
    let model = await (await web("/web/model", "test-web-key")).json();
    assert.equal(model.model, "");
    assert.equal(model.fallback, "fake");
    assert.deepEqual(model.recent, []);
    assert.equal(typeof model.lastUsage.input, "number");
    assert.equal((await web("/web/model", "wrong", { text: "fake" })).status, 401);
    let response = await web("/web/model", "test-web-key", { text: "gpt" });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /^这个模型用不了：/);
    // No AI binding in the local test, so a real model fails its trial call and is not saved.
    response = await web("/web/model", "test-web-key", { text: "anthropic/claude-opus-5.5" });
    assert.equal(response.status, 400);
    model = await (await web("/web/model", "test-web-key")).json();
    assert.equal(model.model, "");
    response = await web("/web/model", "test-web-key", { text: " fake " });
    assert.equal(response.status, 200);
    model = await response.json();
    assert.equal(model.model, "fake");
    assert.equal(typeof model.at, "number");
    // Only models that passed their trial call are offered again in the picker.
    assert.deepEqual(model.recent, ["fake"]);
    const before = (await sent()).length;
    await post("/status");
    const [out] = await waitForSends(before, 1);
    assert.match(out, /^模型：fake\n/);
  });

  let fallback;
  await step("with no persona written yet, the default line is the persona", async () => {
    const persona = await (await web("/web/persona", "test-web-key")).json();
    assert.equal(persona.text, "");
    assert.equal(persona.at, null);
    assert.deepEqual(persona.versions, []);
    fallback = persona.fallback;
    assert.ok(fallback);
    const before = (await sent()).length;
    await post("你是谁");
    assert.deepEqual(await waitForSends(before, 1), [fallback]);
  });

  await step("a persona saved on the web applies from the next message", async () => {
    assert.equal((await web("/web/persona", "wrong", { text: "x" })).status, 401);
    assert.equal((await web("/web/persona", "test-web-key", { text: "长".repeat(30001) })).status, 400);
    const response = await web("/web/persona", "test-web-key", { text: "  你是测试用的住户，说话很温柔。\n第二行。  " });
    const saved = await response.json();
    assert.equal(response.status, 200);
    assert.equal(saved.text, "你是测试用的住户，说话很温柔。\n第二行。");
    assert.equal(typeof saved.at, "number");
    const before = (await sent()).length;
    await post("你是谁");
    assert.deepEqual(await waitForSends(before, 1), ["你是测试用的住户，说话很温柔。"]);
    const [status] = await (async () => {
      const mark = (await sent()).length;
      await post("/status");
      return waitForSends(mark, 1);
    })();
    assert.match(status, /人设：网页上填的，20 字/);
  });

  await step("earlier personas can be brought back, and saving empty goes back to the default", async () => {
    await web("/web/persona", "test-web-key", { text: "第二版人设。" });
    const persona = await (await web("/web/persona", "test-web-key", { text: "" })).json();
    assert.equal(persona.text, "");
    assert.deepEqual(persona.versions.map((v) => v.text), ["第二版人设。", "你是测试用的住户，说话很温柔。\n第二行。"]);
    const before = (await sent()).length;
    await post("你是谁");
    assert.deepEqual(await waitForSends(before, 1), [fallback]);
  });
}

if (phase === "checkin") {
  await fetch(`${MOCK}/__reset`);
  await step("a message first, so the resident knows her chat", async () => {
    await post("你好");
    await waitForSends(0, 2);
  });
  await step("the check-in schedule starts a conversation on its own", async () => {
    const before = (await sent()).length;
    const out = await waitForSends(before, 2, 75000);
    assert.deepEqual(out, ["主动来找你啦。", "记得喝水。"]);
    // Recording in Aelios runs after the bubbles are out.
    let ingest = [];
    for (let i = 0; i < 50 && !ingest.length; i += 1) {
      await sleep(100);
      ingest = (await log()).filter((e) => e.kind === "aelios.ingest" && e.body.source === "aelios-resident:checkin");
    }
    assert.equal(ingest.length, 1);
    assert.deepEqual(ingest[0].body.messages.map((m) => m.role), ["assistant"]);
  });
  await step("a check-in that answers SKIP sends nothing", async () => {
    const before = (await sent()).length;
    await sleep(70000);
    assert.deepEqual((await sent()).slice(before), []);
    const runs = (await log()).filter((e) => e.kind === "aelios.ingest" && e.body.source === "aelios-resident:checkin");
    assert.equal(runs.length, 1);
  });
}

if (phase === "auto") {
  await step("a long conversation writes its own letter and shows it", async () => {
    const before = (await sent()).length;
    for (let i = 0; i < 8; i += 1) {
      const mark = (await sent()).length;
      await post(`第 ${i} 句：${"今天也很想你。".repeat(20)}`);
      await waitForSends(mark, 2);
    }
    const start = Date.now();
    for (;;) {
      const all = (await sent()).slice(before);
      if (all.some((t) => t.startsWith("（聊天有点长了"))) break;
      if (Date.now() - start > 20000) throw new Error(`no letter notice: ${JSON.stringify(all.slice(-3))}`);
      await sleep(300);
    }
  });
}

if (phase === "migrate") {
  await fetch(`${MOCK}/__reset`);
  await step("the old MODEL variable is carried onto the web setting once", async () => {
    const model = await (await fetch(`${WORKER}/web/model`, { headers: { "x-web-key": "test-web-key" } })).json();
    assert.equal(model.model, "fake");
    assert.equal(typeof model.at, "number");
    await post("你好");
    await waitForSends(0, 2);
  });
}

if (phase === "crash-1") {
  await fetch(`${MOCK}/__reset`);
  await post("慢慢说");
  const start = Date.now();
  while (!(await sent()).length) {
    if (Date.now() - start > 20000) throw new Error("no first bubble");
    await sleep(100);
  }
  console.log("first bubble out:", JSON.stringify(await sent()));
}

if (phase === "crash-2") {
  await sleep(15000);
  console.log("after restart she got:", JSON.stringify(await sent()));
}
