// Drives the local Worker (wrangler dev on :8787, wrangler.test.jsonc) with fake Telegram
// updates and checks what reached the mocked Telegram API and Aelios (mock-server.mjs on :9999).
// Usage: node test/run.mjs [phase]
//   main     (default) everything that needs one fresh Worker
//   checkin  needs a schedule (start wrangler with --var CHECKIN_SCHEDULE:"every 1 minute")
//   idle     needs a short quiet time (start wrangler with --var LETTER_IDLE_MINUTES:0.05)
//   crash-1  sends a slow reply; kill workerd once the first bubble is out, restart, then run crash-2
//   crash-2  checks what she got after the restart
//   migrate  needs the old model variable (start wrangler with --var MODEL:fake)
//   custom   your own provider, without Aelios (start wrangler with --var AELIOS_URL:)
//   mcp      other MCP servers: open, with a key, with a sign-in, and connected from the chat
//   mcp-2    run after mcp and restart.sh: the connections come back
//   stickers sticker packs: imported from a zip and from Telegram, sent, drawn, shown on the web page
import assert from "node:assert/strict";
import http from "node:http";
import { GIF, PNG, WEBM, WEBP, zip } from "./zip.mjs";

const WORKER = "http://127.0.0.1:8787";
const MOCK = "http://127.0.0.1:9999";
const SECRET = "test-secret";
const phase = process.argv[2] ?? "main";

let nextId = { main: 100, checkin: 200, idle: 300, "crash-1": 500, "crash-2": 600, migrate: 700, mcp: 800, "mcp-2": 1000, stickers: 1100 }[phase] ?? 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = async () => (await fetch(`${MOCK}/__log`)).json();
// MarkdownV2 escapes punctuation with a backslash; tests compare the plain text.
const plain = (text) => text.replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, "$1");
const sent = async () =>
  (await log()).filter((e) => e.kind === "tg.sendMessage").map((e) => plain(e.body.text ?? ""));

async function post(text, { username = "her_test", messageId = nextId++, secret = SECRET, chatType = "private", chatId = 42, photo } = {}) {
  // A photo comes in two sizes, its text as the caption.
  const picture = photo && {
    photo: ["s", ""].map((size, i) => ({ file_id: `${photo}${size}`, file_unique_id: `u-${photo}${size}`, width: 90 * (i * 8 + 1), height: 90 * (i * 8 + 1), file_size: 12 + i })),
    caption: text
  };
  const update = {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      ...(picture ?? { text }),
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

const web = (path, key, body) =>
  fetch(`${WORKER}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-web-key": key, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });

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
    assert.match(out[0], /^我查到了：/);
    assert.ok(out[0].includes("mem-birthday") && out[0].includes("她的生日在春天"), out[0]);
    const recall = (await log()).filter((e) => e.kind === "aelios.recall").at(-1);
    assert.equal(recall.body.namespace, "test-space");
    assert.equal(recall.auth, "Bearer test-key");
  });

  await step("memory_remember saves through Aelios' MCP", async () => {
    const before = (await sent()).length;
    await post("这个记一下");
    const [out] = await waitForSends(before, 1);
    assert.ok(out.includes("mem-new"), out);
    const call = (await log()).filter((e) => e.kind === "aelios.mcp").at(-1);
    assert.equal(call.auth, "Bearer test-key");
    assert.equal(call.body.method, "tools/call");
    assert.equal(call.body.params.name, "remember");
    assert.deepEqual(call.body.params.arguments, { content: "她喜欢春天", namespace: "test-space" });
  });

  // Reading real pages (redirects, the browser, compression, the cache) is covered by test/web.mjs.
  await step("web_fetch refuses local addresses", async () => {
    const before = (await sent()).length;
    await post("帮我读本机");
    const [refused] = await waitForSends(before, 1);
    assert.match(refused, /^我查到了：Cannot read this URL/);
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
    assert.ok(out.includes("（前文和上一轮一字不差）"), `the letter turn must repeat the chat's request, to be read from cache: ${out}`);
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

  await step("a photo she sends reaches the model as a picture, and the web page shows it", async () => {
    const before = (await sent()).length;
    await post("看图", { photo: "photo-1" });
    assert.deepEqual(await waitForSends(before, 1), ["看到 1 张图。"]);
    assert.ok((await log()).some((e) => e.kind === "tg.file" && e.path === "photos/photo-1.jpg"), "the largest size was downloaded");
    const { data } = await (await web("/web/messages", "test-web-key")).json();
    assert.equal(data.findLast((l) => l.role === "user").text, "看图\n[图片]");
  });

  await step("a photo that cannot be downloaded stays a line of text", async () => {
    const before = (await sent()).length;
    await post("看图", { photo: "gone" });
    assert.deepEqual(await waitForSends(before, 1), ["看到 0 张图，还有一行附件说明。"]);
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
    assert.deepEqual(await waitForSends(before, 1), ["缓存标记在，1h。"]);
  });

  await step("the model is picked on the web, after one trial call, and remembered as recent", async () => {
    let model = await (await web("/web/model", "test-web-key")).json();
    assert.equal(model.model, "");
    assert.equal(model.fallback, "fake");
    assert.deepEqual(model.recent, []);
    assert.equal(typeof model.lastUsage.input, "number");
    assert.equal((await web("/web/model", "wrong", { text: "fake" })).status, 401);
    // Aelios turns down a name without its provider, so the trial call fails and nothing is saved.
    let response = await web("/web/model", "test-web-key", { text: "gpt" });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /^这个模型用不了：.*provider prefix/);
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

  await step("with Aelios connected, the chat goes out through Aelios, which recalls and records it", async () => {
    await fetch(`${MOCK}/__reset`);
    let response = await web("/web/model", "test-web-key", { text: "anthropic/claude-test" });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    let calls = (await log()).filter((e) => e.kind === "aelios.messages");
    assert.equal(calls.length, 1, "the trial call");
    assert.equal(calls[0].purpose, "auxiliary", "the trial call is not something she said");
    assert.equal(calls[0].apiKey, "test-key");
    assert.equal(calls[0].identity, null);
    let before = (await sent()).length;
    await post("从 Aelios 过吗");
    const [first] = await waitForSends(before, 1);
    assert.match(first, /^Aelios 收到 \d+ 条，缓存标记有，旧思考块 0 个$/);
    calls = (await log()).filter((e) => e.kind === "aelios.messages");
    const turn = calls.at(-1);
    assert.equal(turn.purpose, null, "her turn is hers");
    assert.equal(turn.body.model, "anthropic/claude-test");
    assert.equal(turn.body.stream, true);
    assert.ok(turn.body.cache_control, "the cache marker rides along, for Aelios to put on her message");
    assert.match(JSON.stringify(turn.body.messages.at(-1)), /从 Aelios 过吗/);
    // The resident no longer searches or records her turns itself: Aelios does both.
    const own = (await log()).filter((e) => e.kind === "aelios.recall" || (e.kind === "aelios.ingest" && e.body.source === "aelios-resident"));
    assert.deepEqual(own, []);
    before = (await sent()).length;
    await post("再来一句");
    const [second] = await waitForSends(before, 1);
    assert.match(second, /^Aelios 收到 \d+ 条，缓存标记有，旧思考块 0 个$/, "earlier thinking stays home");
  });

  await step("the letter written through Aelios is marked as not hers", async () => {
    const before = (await sent()).length;
    await post("/handoff");
    const [out] = await waitForSends(before, 1, 30000);
    assert.match(out, /^交接信写好了/);
    const letter = (await log()).filter((e) => e.kind === "aelios.messages").at(-1);
    assert.equal(letter.purpose, "auxiliary");
    assert.match(JSON.stringify(letter.body.messages.at(-1)), /time to write a handoff letter/);
  });

  await step("a model Aelios keeps no memory for is not picked; a Workers AI id goes under workers-ai/", async () => {
    let response = await web("/web/model", "test-web-key", { text: "anthropic/plain-model" });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /不是这个身份的主模型/);
    response = await web("/web/model", "test-web-key", { text: "@cf/test/glm" });
    assert.equal(response.status, 200);
    const before = (await sent()).length;
    await post("换成聊天格式");
    const [out] = await waitForSends(before, 1);
    assert.match(out, /^Aelios（workers-ai\/@cf\/test\/glm）收到：\[[^\]]+\] 换成聊天格式$/);
    const turn = (await log()).filter((e) => e.kind === "aelios.chat").at(-1);
    assert.equal(turn.auth, "Bearer test-key");
    assert.equal(turn.purpose, null);
    assert.equal((await (await web("/web/model", "test-web-key")).json()).memoryOff, false);
  });

  await step("when Aelios keeps no memory for her turns any more, the page and /status say so", async () => {
    let response = await web("/web/model", "test-web-key", { text: "anthropic/claude-dropped" });
    assert.equal(response.status, 200);
    let before = (await sent()).length;
    await post("还记得住吗");
    await waitForSends(before, 1);
    assert.equal((await (await web("/web/model", "test-web-key")).json()).memoryOff, true);
    before = (await sent()).length;
    await post("/status");
    const [out] = await waitForSends(before, 1);
    assert.match(out, /长期记忆 Aelios：接着，但这个模型不在 Aelios 那个身份的主模型里/);
    response = await web("/web/model", "test-web-key", { text: "@cf/test/glm" });
    assert.equal((await response.json()).memoryOff, false, "only for the model it was said about");
  });

  await step("Claude's thinking is asked to be shown, and THINKING_EFFORT set on the settings page applies", async () => {
    const lastMessages = async () => (await log()).filter((e) => e.kind === "aelios.messages").at(-1);
    let response = await web("/web/model", "test-web-key", { text: "anthropic/claude-opus-5.5" });
    assert.equal(response.status, 200);
    let call = await lastMessages();
    assert.equal(call.purpose, "auxiliary");
    assert.deepEqual(call.body.thinking, { type: "adaptive", display: "summarized" }, "the trial call is shaped like the chat");
    assert.equal(call.body.output_config, undefined, "auto sends no effort");
    response = await web("/web/config", "test-web-key", { key: "THINKING_EFFORT", text: "huge" });
    assert.equal(response.status, 400);
    await web("/web/config", "test-web-key", { key: "THINKING_EFFORT", text: "high" });
    let before = (await sent()).length;
    await post("想深一点");
    await waitForSends(before, 1);
    call = await lastMessages();
    assert.equal(call.purpose, null);
    assert.equal(call.body.model, "anthropic/claude-opus-5-5");
    assert.deepEqual(call.body.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(call.body.output_config, { effort: "high" });
    await web("/web/config", "test-web-key", { key: "THINKING_EFFORT", text: "" });
    before = (await sent()).length;
    await post("回到默认");
    await waitForSends(before, 1);
    assert.equal((await lastMessages()).body.output_config, undefined);
    response = await web("/web/model", "test-web-key", { text: "@cf/test/glm" });
    assert.equal(response.status, 200);
  });

  await step("the settings page: secrets stay unread, bad values are refused, a saved value applies to the next message", async () => {
    assert.equal((await web("/web/config", "wrong")).status, 401);
    let config = await (await web("/web/config", "test-web-key")).json();
    const field = (key) => config.fields.find((f) => f.key === key);
    assert.deepEqual(field("AELIOS_API_KEY"), { key: "AELIOS_API_KEY", kind: "secret", value: "", fromWorker: "", saved: false, workerHas: true });
    assert.ok(!JSON.stringify(config).includes("test-key"), "no secret reaches the page");
    assert.equal(field("TIME_ZONE").fromWorker, "Asia/Shanghai");
    assert.ok(!config.fields.some((f) => ["TG_BOT_TOKEN", "TG_WEBHOOK_SECRET", "WEB_KEY"].includes(f.key)));
    for (const [key, text, problem] of [
      ["TIME_ZONE", "Mars/Olympus", /时区/],
      ["KEEP_RECENT_TOKENS", "abc", /大于 0/],
      ["CACHE_TTL", "2h", /只能填/],
      ["AELIOS_URL", "ftp://x", /https/],
      ["NOT_A_SETTING", "x", /没有这个设置/],
      ["CHECKIN_SCHEDULE", "whenever you like", /排不上/]
    ]) {
      const response = await web("/web/config", "test-web-key", { key, text });
      assert.equal(response.status, 400, key);
      assert.match((await response.json()).error, problem, key);
    }
    config = await (await web("/web/config", "test-web-key")).json();
    assert.equal(field("CHECKIN_SCHEDULE").value, "", "a schedule that cannot be armed is not kept");
    // The identity in Aelios: the next message goes out as it.
    config = await (await web("/web/config", "test-web-key", { key: "AELIOS_IDENTITY", text: " resident " })).json();
    assert.equal(field("AELIOS_IDENTITY").value, "resident");
    let before = (await sent()).length;
    await post("换身份");
    await waitForSends(before, 1);
    assert.equal((await log()).filter((e) => e.kind === "aelios.chat").at(-1).identity, "resident");
    // Who may talk on Telegram: someone else, then back to the Worker's own list.
    config = await (await web("/web/config", "test-web-key", { key: "TG_ALLOWED", text: "@someone_else" })).json();
    before = (await sent()).length;
    await post("现在不认我了");
    await sleep(2500);
    assert.equal((await sent()).length, before, "her chat is not in the list any more");
    config = await (await web("/web/config", "test-web-key", { key: "TG_ALLOWED", text: "" })).json();
    assert.equal(field("TG_ALLOWED").value, "");
    before = (await sent()).length;
    await post("又认我了");
    await waitForSends(before, 1);
    // A secret saved here wins over the Worker's, and is still never shown.
    config = await (await web("/web/config", "test-web-key", { key: "AELIOS_API_KEY", text: "panel-key" })).json();
    assert.equal(field("AELIOS_API_KEY").saved, true);
    assert.ok(!JSON.stringify(config).includes("panel-key"));
    before = (await sent()).length;
    await post("换钥匙");
    await waitForSends(before, 1);
    assert.equal((await log()).filter((e) => e.kind === "aelios.chat").at(-1).auth, "Bearer panel-key");
    for (const key of ["AELIOS_API_KEY", "AELIOS_IDENTITY"]) await web("/web/config", "test-web-key", { key, text: "" });
    const response = await web("/web/model", "test-web-key", { text: "fake" });
    assert.equal(response.status, 200);
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

if (phase === "idle") {
  await step("when she goes quiet, a letter is written by itself, silently, and carried on", async () => {
    for (let i = 0; i < 3; i += 1) {
      const mark = (await sent()).length;
      await post(`第 ${i} 句：今天也很想你。`);
      await waitForSends(mark, 2);
    }
    const before = (await sent()).length;
    const start = Date.now();
    let ingest = [];
    while (!ingest.length) {
      if (Date.now() - start > 20000) throw new Error("no letter after the quiet time");
      await sleep(300);
      ingest = (await log()).filter((e) => e.kind === "aelios.ingest" && e.body.source === "aelios-resident:letter");
    }
    assert.match(ingest[0].body.messages[0].content, /^（交接信）亲爱的下一个我.*（前文和上一轮一字不差）/);
    assert.deepEqual((await sent()).slice(before), [], "the idle letter sends her nothing");
    const { data: lines } = await (await fetch(`${WORKER}/web/messages`, { headers: { "x-web-key": "test-web-key" } })).json();
    assert.ok(lines.some((l) => l.kind === "letter"), JSON.stringify(lines));
    assert.ok(!lines.some((l) => l.text.includes("handoff letter")), "the letter prompt is gone again");
    const mark = (await sent()).length;
    await post("交接信在吗");
    assert.deepEqual(await waitForSends(mark, 1), ["交接信在。"]);
  });
  await step("after a letter, nothing more happens until she writes again", async () => {
    await sleep(8000);
    const letters = (await log()).filter((e) => e.kind === "aelios.ingest" && e.body.source === "aelios-resident:letter");
    assert.equal(letters.length, 2, "one letter per quiet time after she wrote");
    await sleep(8000);
    const later = (await log()).filter((e) => e.kind === "aelios.ingest" && e.body.source === "aelios-resident:letter");
    assert.equal(later.length, 2);
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

if (phase === "custom") {
  await fetch(`${MOCK}/__reset`);
  await step("a provider of your own (custom/…, OpenAI format) is tried, picked and answers with your key", async () => {
    let response = await web("/web/model", "test-web-key", { text: "custom/nous/claude-test" });
    const picked = await response.json();
    assert.equal(response.status, 200, JSON.stringify(picked));
    assert.equal(picked.model, "custom/nous/claude-test");
    const before = (await sent()).length;
    await post("自己的供应商在吗");
    const [out] = await waitForSends(before, 1);
    assert.match(out, /^自己的供应商（OpenAI 格式）收到：\[[^\]]+\] 自己的供应商在吗$/);
    const calls = (await log()).filter((e) => e.kind === "custom.chat");
    assert.equal(calls.length, 2, "the trial call and the turn");
    assert.equal(calls[1].auth, "Bearer test-custom-key");
    assert.equal(calls[1].body.model, "nous/claude-test");
    assert.equal(calls[1].body.stream, true);
  });

  await step("the format is changed on the settings page and applies from the next message", async () => {
    const config = await (await web("/web/config", "test-web-key", { key: "CUSTOM_FORMAT", text: "Anthropic" })).json();
    assert.equal(config.fields.find((f) => f.key === "CUSTOM_FORMAT").value, "anthropic");
  });

  await step("a provider of your own on the Messages API: your key, the cache marker, no thinking from earlier turns", async () => {
    await fetch(`${MOCK}/__reset`);
    const response = await web("/web/model", "test-web-key", { text: "custom/claude-test" });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    let before = (await sent()).length;
    await post("第一句");
    const [first] = await waitForSends(before, 1);
    const count = Number(first.match(/^自己的供应商（Anthropic 格式）收到 (\d+) 条，缓存标记有，旧思考块 0 个$/)?.[1]);
    assert.ok(count > 0, first);
    before = (await sent()).length;
    await post("第二句");
    assert.deepEqual(await waitForSends(before, 1), [`自己的供应商（Anthropic 格式）收到 ${count + 2} 条，缓存标记有，旧思考块 0 个`]);
    const calls = (await log()).filter((e) => e.kind === "custom.messages");
    assert.equal(calls.at(-1).apiKey, "test-custom-key");
    assert.equal(calls.at(-1).body.model, "claude-test");
    // The first answer went back without its thinking, its words kept.
    const earlier = calls.at(-1).body.messages.at(-2);
    assert.equal(earlier.role, "assistant");
    assert.ok(earlier.content.some((b) => b.type === "text"), JSON.stringify(earlier));
    // THINKING_EFFORT applies here too.
    await web("/web/config", "test-web-key", { key: "THINKING_EFFORT", text: "xhigh" });
    assert.equal((await web("/web/model", "test-web-key", { text: "custom/claude-sonnet-5-5" })).status, 200);
    before = (await sent()).length;
    await post("第三句");
    await waitForSends(before, 1);
    const turn = (await log()).filter((e) => e.kind === "custom.messages").at(-1);
    assert.deepEqual(turn.body.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(turn.body.output_config, { effort: "xhigh" });
  });
}

if (phase === "mcp") {
  await fetch(`${MOCK}/__reset`);
  const KEY = "test-web-key";
  const servers = async () => (await (await web("/web/mcp", KEY)).json()).servers;
  const say = async (text) => {
    const before = (await sent()).length;
    await post(text);
    return (await waitForSends(before, 1)).join("\n");
  };

  await step("an open server is added on the settings page and its tools are counted", async () => {
    const response = await web("/web/mcp", KEY, { name: "demo", url: `${MOCK}/ext/mcp` });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    const demo = body.servers.find((s) => s.id === "demo");
    assert.equal(demo.state, "ready", JSON.stringify(demo));
    assert.equal(demo.tools, 2);
    assert.equal(demo.hasKey, false);
    assert.ok(demo.tokens > 0 && demo.tokens < 400, `tokens ${demo.tokens}`);
    const methods = (await log()).filter((e) => e.kind === "ext.ext").map((e) => e.method);
    assert.ok(methods.includes("tools/list"), JSON.stringify(methods));
  });

  await step("the model gets its tools with the descriptions cut and every parameter kept", async () => {
    const out = await say("MCP工具有哪些");
    const echo = out.split("; ").find((t) => t.startsWith("mcp_demo_echo:"));
    assert.ok(echo, out);
    const [, length, params] = echo.split(":");
    assert.ok(Number(length) <= 310, `description ${length}`);
    assert.equal(params, "text|title");
    assert.match(out, /mcp_demo_add:/);
    assert.match(out, /connect_mcp_server:/);
    assert.match(out, /disconnect_mcp_server:/);
  });

  await step("the model calls one and reads its answer", async () => {
    const out = await say("用MCP");
    assert.match(out, /ext echo: hi/);
    const call = (await log()).find((e) => e.kind === "ext.ext" && e.method === "tools/call");
    assert.deepEqual(call.args, { text: "hi", title: "t" });
  });

  await step("a server that wants a key fails without one and is not kept, and works with it", async () => {
    let body = await (await web("/web/mcp", KEY, { name: "keyed", url: `${MOCK}/keyed/mcp` })).json();
    assert.ok(body.error, JSON.stringify(body));
    assert.ok(!(await servers()).some((s) => s.id === "keyed"));
    body = await (await web("/web/mcp", KEY, { name: "keyed", url: `${MOCK}/keyed/mcp`, key: "x-api-key: k1" })).json();
    const keyed = body.servers?.find((s) => s.id === "keyed");
    assert.equal(keyed?.state, "ready", JSON.stringify(body));
    assert.equal(keyed.hasKey, true);
    assert.ok(!JSON.stringify(body).includes("k1"), "the key is never sent back");
    // Connected again without a key: tried where it is, the key kept.
    body = await (await web("/web/mcp", KEY, { name: "keyed", url: `${MOCK}/keyed/mcp` })).json();
    assert.deepEqual(body.servers?.filter((s) => s.id === "keyed").map((s) => [s.state, s.hasKey]), [["ready", true]], JSON.stringify(body));
    body = await (await web("/web/mcp/retry", KEY, { id: "keyed" })).json();
    assert.equal(body.servers?.find((s) => s.id === "keyed")?.state, "ready", JSON.stringify(body));
  });

  await step("an unreachable server is reported and not kept", async () => {
    const body = await (await web("/web/mcp", KEY, { name: "nope", url: `${MOCK}/nope/mcp?api_key=SECRET1` })).json();
    assert.ok(body.error, JSON.stringify(body));
    assert.ok(!body.error.includes("SECRET1"), `the address's key is not repeated: ${body.error}`);
    assert.ok(!(await servers()).some((s) => s.id === "nope"));
    const bad = await (await web("/web/mcp", KEY, { url: "http://example.com/mcp" })).json();
    assert.match(bad.error, /https/);
  });

  await step("a server that wants a sign-in gives a link, and the sign-in comes back to the resident", async () => {
    const body = await (await web("/web/mcp", KEY, { name: "oauth", url: `${MOCK}/oauth/mcp` })).json();
    const pending = body.servers?.find((s) => s.id === "oauth");
    assert.equal(pending?.state, "authenticating", JSON.stringify(body));
    assert.ok(pending.authUrl?.startsWith(`${MOCK}/oauth/authorize`), pending.authUrl);
    // Asked again before signing in: the same server, still waiting, a link that still works.
    const again = await (await web("/web/mcp/retry", KEY, { id: "oauth" })).json();
    const still = again.servers?.find((s) => s.id === "oauth");
    assert.equal(still?.state, "authenticating", JSON.stringify(again));
    assert.ok(still.authUrl?.startsWith(`${MOCK}/oauth/authorize`), still.authUrl);
    const authorize = await fetch(still.authUrl, { redirect: "manual" });
    assert.equal(authorize.status, 302);
    const back = authorize.headers.get("location");
    assert.ok(back.startsWith(`${WORKER}/mcp/callback`), back);
    const page = await fetch(back, { redirect: "manual" });
    const html = await page.text();
    assert.equal(page.status, 200, html.slice(0, 300));
    assert.match(html, /接好了/);
    // Only the address reaches the resident: a WebSocket upgrade on the callback is not let through.
    const upgraded = await new Promise((resolve) => {
      const request = http.request(`${WORKER}/mcp/callback?state=x.oauth`, {
        headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" }
      });
      request.on("upgrade", (_response, socket) => (socket.destroy(), resolve(true)));
      request.on("response", (response) => (response.resume(), resolve(false)));
      request.on("error", () => resolve(false));
      request.end();
    });
    assert.equal(upgraded, false, "the callback opened a WebSocket to the resident");
    let oauth;
    for (let i = 0; i < 20; i += 1) {
      oauth = (await servers()).find((s) => s.id === "oauth");
      if (oauth?.state === "ready") break;
      await sleep(250);
    }
    assert.equal(oauth?.state, "ready", JSON.stringify(oauth));
    assert.equal(oauth.tools, 2);
    const used = (await log()).filter((e) => e.kind === "ext.oauth" && e.auth === "Bearer tok-1");
    assert.ok(used.length, "the token is used");
  });

  await step("the model connects one when she asks", async () => {
    const out = await say("接上MCP");
    assert.match(out, /Connected second/);
    assert.equal((await servers()).find((s) => s.id === "second")?.state, "ready");
  });

  await step("never because a page it read said so", async () => {
    const out = await say("读完再接MCP");
    assert.match(out, /Not done: this turn has read a web page/);
    assert.ok(!(await servers()).some((s) => s.id === "sneaky"));
  });

  await step("/status lists them", async () => {
    const out = await say("/status");
    assert.match(out, /别的 MCP：.*demo（2 个工具）/);
  });

  await step("the model disconnects one when she asks, and the page removes one", async () => {
    const out = await say("断开MCP");
    assert.match(out, /Disconnected second/);
    assert.ok(!(await servers()).some((s) => s.id === "second"));
    const body = await (await web("/web/mcp/remove", KEY, { id: "keyed" })).json();
    assert.deepEqual(body.servers.map((s) => s.id).sort(), ["demo", "oauth"]);
  });
}

if (phase === "mcp-2") {
  // After restart.sh: the servers come back on their own, the signed-in one with its token.
  await fetch(`${MOCK}/__reset`);
  await step("connections come back after a restart", async () => {
    await post("用MCP");
    const out = (await waitForSends(0, 1)).join("\n");
    assert.match(out, /ext echo: hi/);
    const list = (await (await web("/web/mcp", "test-web-key")).json()).servers;
    assert.deepEqual(list.map((s) => [s.id, s.state]).sort(), [["demo", "ready"], ["oauth", "ready"]]);
    const before = (await sent()).length;
    await post("用授权MCP");
    assert.match((await waitForSends(before, 1)).join("\n"), /我查到了：3/);
    const call = (await log()).find((e) => e.kind === "ext.oauth" && e.method === "tools/call");
    assert.equal(call?.auth, "Bearer tok-1", "the signed-in server is called with its saved token");
  });
}

if (phase === "stickers") {
  await fetch(`${MOCK}/__reset`);
  const KEY = "test-web-key";
  const packs = async () => (await (await web("/web/stickers", KEY)).json()).packs;
  const pack = async (id) => (await packs()).find((p) => p.id === id);
  const tgLog = async (kind) => (await log()).filter((e) => e.kind === `tg.${kind}`);
  const ask = async (text) => {
    const r = await web("/web/say", KEY, { text });
    assert.equal(r.status, 200);
    const lines = (await (await web("/web/messages", KEY)).json()).data;
    return lines.filter((line) => line.role === "assistant").at(-1);
  };
  const manifest = {
    format: "resident-stickers/1",
    name: "Test",
    stickers: [
      { id: "wave", file: "wave.gif", emoji: "👋", when: "Say hi.", telegram: "wave.webm" },
      { id: "love", file: "love.png", emoji: "❤️", when: "Love." }
    ]
  };

  await step("a pack is imported from a zip on the settings page", async () => {
    await post("你好");
    await waitForSends(0, 2);
    const body = zip([
      { name: "pack.json", data: JSON.stringify(manifest), deflate: true },
      { name: "wave.gif", data: GIF },
      { name: "wave.webm", data: WEBM },
      { name: "love.png", data: PNG, deflate: true }
    ]);
    const response = await fetch(`${WORKER}/web/stickers/import?name=test.zip`, { method: "POST", headers: { "x-web-key": KEY, "content-type": "application/zip" }, body });
    assert.equal(response.status, 200, await response.clone().text());
    const imported = await response.json();
    assert.equal(imported.left, 0, "every sticker is told to the model");
    const test = imported.packs.find((p) => p.id === "test");
    assert.deepEqual(test.stickers.map((s) => [s.name, s.emoji, s.when]), [["wave", "👋", "Say hi."], ["love", "❤️", "Love."]]);
    assert.ok(test.enabled && test.tokens > 0);
    const shut = await fetch(`${WORKER}/web/stickers/import?name=x.zip`, { method: "POST", headers: { "content-type": "application/zip" }, body });
    assert.equal(shut.status, 401, "not without the web key");
    const bad = await fetch(`${WORKER}/web/stickers/import?name=x.zip`, { method: "POST", headers: { "x-web-key": KEY, "content-type": "application/zip" }, body: "not a zip" });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /不是 zip/);
  });

  await step("a sticker's picture is served by its key alone", async () => {
    const wave = (await pack("test")).stickers[0];
    const picture = await fetch(`${WORKER}/stickers/${wave.key}`);
    assert.equal(picture.status, 200);
    assert.equal(picture.headers.get("content-type"), "image/gif");
    assert.deepEqual(Buffer.from(await picture.arrayBuffer()), GIF);
    assert.equal((await fetch(`${WORKER}/stickers/${"0".repeat(24)}`)).status, 404);
    assert.equal((await fetch(`${WORKER}/stickers/not-a-key`)).status, 404);
  });

  await step("a Telegram sticker pack is imported by its link, its pictures fetched from Telegram once", async () => {
    const response = await web("/web/stickers/import", KEY, { url: "https://t.me/addstickers/TestPack" });
    assert.equal(response.status, 200, await response.clone().text());
    const tg = (await response.json()).packs.find((p) => p.id === "testpack");
    assert.equal(tg.name, "Test Pack");
    assert.deepEqual(tg.stickers.map((s) => [s.name, s.emoji, s.video]), [["1", "😀", false], ["2", "🥰", true], ["3", "😴", false]]);
    const video = await fetch(`${WORKER}/stickers/${tg.stickers[1].key}`);
    assert.equal(video.headers.get("content-type"), "video/webm");
    const thumb = await fetch(`${WORKER}/stickers/${tg.stickers[2].key}`);
    assert.equal(thumb.headers.get("content-type"), "image/webp");
    const fetched = (await tgLog("getFile")).length;
    await fetch(`${WORKER}/stickers/${tg.stickers[1].key}`);
    assert.equal((await tgLog("getFile")).length, fetched, "kept after the first time");
    assert.deepEqual((await tgLog("getFile")).map((e) => e.body.file_id).sort(), ["tg-anim-thumb", "tg-video"]);
    for (const [url, error] of [
      ["https://t.me/addstickers/Nope", /找不到/],
      ["https://t.me/addemoji/Abc", /表情符号包/],
      ["hello", /认不出/],
      ["http://example.com/a.zip", /https/],
      ["https://127.0.0.1:9999/a.zip", /不能读/]
    ]) {
      const refused = await web("/web/stickers/import", KEY, { url });
      assert.equal(refused.status, 400, url);
      assert.match((await refused.json()).error, error);
    }
  });

  await step("on Telegram a sticker follows the words, uploaded the first time and sent by its id after", async () => {
    const before = (await sent()).length;
    await post("发表情");
    const out = await waitForSends(before, 1);
    assert.match(out[0], /我查到了：\{"sent":"test\/wave"\}/);
    await sleep(500);
    const all = await log();
    const sticker = all.findLastIndex((e) => e.kind === "tg.sendSticker");
    const words = all.findLastIndex((e) => e.kind === "tg.sendMessage");
    assert.ok(sticker > words && words >= 0, "the sticker comes after the words");
    const first = all[sticker].body;
    assert.equal(first.multipart, true);
    assert.equal(first.sticker.file, "sticker.webm");
    assert.equal(first.sticker.type, "video/webm");
    assert.equal(first.emoji, "👋");
    await post("发表情");
    await waitForSends(before + 1, 1);
    await sleep(500);
    const again = (await tgLog("sendSticker")).at(-1).body;
    assert.equal(again.multipart, undefined);
    assert.match(again.sticker, /^up-sendSticker-/);
  });

  await step("a sticker can be the whole reply, with no 'said nothing' line", async () => {
    const before = (await sent()).length;
    const stickers = (await tgLog("sendSticker")).length;
    await post("只发表情");
    const start = Date.now();
    while ((await tgLog("sendSticker")).length === stickers) {
      if (Date.now() - start > 20000) throw new Error("no sticker");
      await sleep(200);
    }
    await sleep(1500);
    assert.deepEqual((await sent()).slice(before), []);
  });

  await step("one sticker per reply", async () => {
    const before = (await sent()).length;
    const stickers = (await tgLog("sendSticker")).length;
    await post("发两张");
    const out = await waitForSends(before, 1);
    assert.match(out[0], /one sticker per reply/);
    await sleep(800);
    assert.equal((await tgLog("sendSticker")).length, stickers + 1);
  });

  await step("the resident draws a sticker, keeps it in its own pack and sends it (as a GIF on Telegram)", async () => {
    const before = (await sent()).length;
    await post("画一张");
    await waitForSends(before, 1);
    await sleep(800);
    const animation = (await tgLog("sendAnimation")).at(-1)?.body;
    assert.ok(animation, "sent as an animation");
    assert.equal(animation.animation.file, "sticker.gif");
    assert.equal(animation.animation.head, "GIF89a");
    const mine = await pack("mine");
    assert.equal(mine.source, "own");
    assert.deepEqual(mine.stickers.map((s) => [s.name, s.emoji, s.when]), [["heart", "❤️", "When she says she loves me."]]);
    const picture = await fetch(`${WORKER}/stickers/${mine.stickers[0].key}`);
    assert.equal(Buffer.from(await picture.arrayBuffer()).subarray(0, 6).toString(), "GIF89a");
  });

  await step("the web page shows the stickers a reply sent, and a web turn sends nothing to Telegram", async () => {
    const lines = (await (await web("/web/messages", KEY)).json()).data;
    const drawn = lines.filter((line) => line.role === "assistant" && line.stickers).at(-1);
    const mine = await pack("mine");
    assert.deepEqual(drawn.stickers, [{ url: `/stickers/${mine.stickers[0].key}`, video: false }]);
    const tgBefore = (await log()).filter((e) => e.kind.startsWith("tg.send")).length;
    const line = await ask("发表情");
    assert.equal(line.via, "web");
    assert.deepEqual(line.stickers, [{ url: `/stickers/${(await pack("test")).stickers[0].key}`, video: false }]);
    await sleep(500);
    assert.equal((await log()).filter((e) => e.kind.startsWith("tg.send")).length, tgBefore);
  });

  await step("the model is told every sticker of the packs that are on; a pack or the whole thing can be turned off", async () => {
    const tools = async () => (await ask("表情工具有哪些")).text;
    assert.equal(await tools(), "make_sticker:; send_sticker:mine/heart|test/wave|test/love|testpack/1|testpack/2|testpack/3");
    await web("/web/stickers/pack", KEY, { id: "testpack", on: false });
    assert.equal(await tools(), "make_sticker:; send_sticker:mine/heart|test/wave|test/love");
    const off = await web("/web/config", KEY, { key: "STICKERS", text: "off" });
    assert.equal(off.status, 200);
    assert.equal(await tools(), "没有");
    assert.match(await (await fetch(`${WORKER}/web/stickers`, { headers: { "x-web-key": KEY } })).text(), /"on":false/);
    await web("/web/config", KEY, { key: "STICKERS", text: "" });
    await web("/web/stickers/pack", KEY, { id: "testpack", on: true });
  });

  await step("what a sticker is for is changed on the settings page; stickers and packs are deleted there", async () => {
    const wave = (await pack("test")).stickers[0];
    const edited = await (await web("/web/stickers/edit", KEY, { key: wave.key, when: "挥手打招呼" })).json();
    assert.equal(edited.packs.find((p) => p.id === "test").stickers[0].when, "挥手打招呼");
    const badEmoji = await web("/web/stickers/edit", KEY, { key: wave.key, when: "x", emoji: "abc" });
    assert.equal(badEmoji.status, 400);
    await web("/web/stickers/delete", KEY, { key: wave.key });
    assert.deepEqual((await pack("test")).stickers.map((s) => s.name), ["love"]);
    assert.equal((await fetch(`${WORKER}/stickers/${wave.key}`)).status, 404);
    await web("/web/stickers/remove", KEY, { id: "testpack" });
    assert.equal(await pack("testpack"), undefined);
  });

  await step("/status says how the stickers are", async () => {
    const before = (await sent()).length;
    await post("/status");
    const out = (await waitForSends(before, 1)).join("\n");
    assert.match(out, /表情包：开，2 个包 2 张/);
  });

  await step("a WebP Telegram will not take as a sticker goes as a photo, and the same way after", async () => {
    const body = zip([{ name: "smile.webp", data: WEBP }]);
    const response = await fetch(`${WORKER}/web/stickers/import?name=still.zip`, { method: "POST", headers: { "x-web-key": KEY, "content-type": "application/zip" }, body });
    assert.equal(response.status, 200, await response.clone().text());
    const before = (await sent()).length;
    const photos = (await tgLog("sendPhoto")).length;
    await post("发静图");
    await waitForSends(before, 1);
    await sleep(500);
    assert.equal((await tgLog("sendSticker")).at(-1).body.sticker?.type, "image/webp", "tried as a sticker first");
    const photo = await tgLog("sendPhoto");
    assert.equal(photo.length, photos + 1);
    assert.equal(photo.at(-1).body.photo.type, "image/webp");
    const stickers = (await tgLog("sendSticker")).length;
    await post("发静图");
    await waitForSends(before + 1, 1);
    await sleep(500);
    assert.equal((await tgLog("sendSticker")).length, stickers, "not tried as a sticker again");
    assert.match((await tgLog("sendPhoto")).at(-1).body.photo, /^up-sendPhoto-/);
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
