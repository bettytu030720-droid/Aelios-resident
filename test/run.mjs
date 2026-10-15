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
import assert from "node:assert/strict";

const WORKER = "http://127.0.0.1:8787";
const MOCK = "http://127.0.0.1:9999";
const SECRET = "test-secret";
const phase = process.argv[2] ?? "main";

let nextId = { main: 100, checkin: 200, idle: 300, "crash-1": 500, "crash-2": 600, migrate: 700 }[phase] ?? 900;
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
