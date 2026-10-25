// Local Worker + mock-server integration. Usage: node test/letter-failures.mjs [main|restart-1|restart-2]
// restart-1 and restart-2 share the same Worker state and running mock, with the Worker restarted between them.
import assert from "node:assert/strict";
const WORKER = "http://127.0.0.1:8787", MOCK = "http://127.0.0.1:9999", KEY = "test-web-key";
const phase = process.argv[2] ?? "main";
let id = 7000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const web = (path, body) => fetch(`${WORKER}${path}`, { method: body ? "POST" : "GET", headers: { "x-web-key": KEY, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const view = async () => (await web("/web/letter")).json();
const logs = async () => (await fetch(`${MOCK}/__log`)).json();
const ingests = async () => (await logs()).filter((row) => row.kind === "aelios.ingest" && row.body.source === "aelios-resident:letter");
const letterCalls = async () => (await logs()).filter((row) => row.kind === "aelios.messages" && JSON.stringify(row.body.messages.at(-1)).includes("time to write a handoff letter"));
const sent = async () => (await logs()).filter((row) => row.kind === "tg.sendMessage").map((row) => row.body.text.replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, "$1"));
const faults = (body) => fetch(`${MOCK}/__faults`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
async function until(read, ok, ms = 20000) {
  const start = Date.now();
  for (;;) {
    const result = await read();
    if (ok(result)) return result;
    if (Date.now() - start > ms) throw new Error(`timed out: ${JSON.stringify(result).slice(0, 800)}`);
    await sleep(150);
  }
}
async function post(text) {
  const messageId = id++;
  const response = await fetch(`${WORKER}/messengers/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "test-secret" }, body: JSON.stringify({ update_id: messageId, message: { message_id: messageId, date: Math.floor(Date.now() / 1000), text, from: { id: 42, is_bot: false, username: "her_test", first_name: "Her" }, chat: { id: 42, type: "private" } } }) });
  assert.equal(response.status, 200);
}
async function ask(text) {
  const count = (await sent()).length;
  await post(text);
  return (await until(sent, (rows) => rows.length > count, 45000)).slice(count).join("\n");
}
async function fill() {
  for (let n = 0; n < 3; n++) {
    const response = await web("/web/say", { text: `交接信测试材料 ${id++}：${"文".repeat(3850)}` });
    assert.deepEqual(await response.json(), { status: "completed" });
  }
}
async function set(key, text) { assert.equal((await web("/web/config", { key, text })).status, 200); }
async function model() { assert.equal((await web("/web/model", { text: "anthropic/claude-test" })).status, 200); }
const history = async () => (await (await web("/web/messages")).json()).data;
let failures = 0;
async function step(name, run) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.stack ?? error}`); }
}

if (phase === "main") {
  await fetch(`${MOCK}/__reset`);
  await step("letter status and retry are authenticated, and short chat is empty rather than failed", async () => {
    assert.equal((await fetch(`${WORKER}/web/letter`)).status, 401);
    assert.equal((await fetch(`${WORKER}/web/letter/retry`, { method: "POST" })).status, 401);
    assert.match(await ask("/handoff"), /没什么要收起来/);
    assert.equal((await view()).write.state, "empty");
  });
  await fill();
  await model();
  const original = (await history()).map((line) => line.id);
  await step("model errors are not misreported as short chat, and original messages survive", async () => {
    await faults({ letterModel: "error" });
    const answer = await ask("/handoff");
    assert.match(answer, /交接信没写成/);
    assert.doesNotMatch(answer, /没什么要收起来|PRIVATE_UPSTREAM/);
    const state = await view();
    assert.equal(state.write.state, "failed");
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE_UPSTREAM/);
    assert.deepEqual((await history()).map((line) => line.id), original);
    assert.match(await ask("/status"), /写信状态：写信失败/);
    assert.equal((await ingests()).length, 0);
  });
  await step("an empty model letter is also a generation failure, with no compaction or ingest", async () => {
    await faults({ letterModel: "empty" });
    assert.match(await ask("/handoff"), /交接信没写成/);
    assert.equal((await view()).write.state, "failed");
    assert.deepEqual((await history()).map((line) => line.id), original);
    assert.equal((await ingests()).length, 0);
  });
  let deliveryId;
  await step("concurrent handoff commands do not start two generations; local success is separate from failed delivery", async () => {
    await faults({ letterModel: "slow", ingestFailures: 1 });
    const callsBefore = (await letterCalls()).length, sentBefore = (await sent()).length;
    await post("/handoff");
    await until(view, (state) => state.write?.state === "writing");
    await post("/handoff");
    const answers = (await until(sent, (rows) => rows.length >= sentBefore + 2, 30000)).slice(sentBefore);
    assert.ok(answers.some((text) => text.includes("正在写或恢复中")), JSON.stringify(answers));
    assert.ok(answers.some((text) => text.startsWith("交接信写好了")), JSON.stringify(answers));
    assert.equal((await letterCalls()).length, callsBefore + 1);
    const state = await until(view, (v) => v.write?.state === "written" && v.delivery.pending === 1 && v.delivery.latest?.lastError);
    deliveryId = state.delivery.latest.id;
    assert.match(state.delivery.latest.lastError, /HTTP 503/);
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE_UPSTREAM|交接信测试材料|test-key|127\.0\.0\.1/);
    assert.match(await ask("/status"), /写信状态：已写好[\s\S]*交接信同步：1 封待送达/);
  });
  await step("the persistent outbox retries after 30 seconds without another model generation", async () => {
    const callsBefore = (await letterCalls()).length;
    const state = await until(view, (v) => v.delivery.latest?.status === "sent", 45000);
    assert.equal(state.delivery.latest.id, deliveryId);
    assert.equal(state.delivery.latest.attempts, 2);
    const records = await ingests();
    assert.equal(records.length, 2);
    assert.equal(records[0].letterId, records[1].letterId);
    assert.deepEqual(records[0].body, records[1].body);
    assert.equal((await letterCalls()).length, callsBefore);
  });
  await step("changing namespace pauses old delivery, manual retry cannot send it to the new namespace, restoring config resumes", async () => {
    await faults({ letterModel: "ok", ingestFailures: 1 });
    await fill();
    assert.match(await ask("/handoff"), /^交接信写好了/);
    const pending = await until(view, (v) => v.delivery.pending === 1 && v.delivery.latest?.lastError);
    await set("AELIOS_NAMESPACE", "different-space");
    await until(view, (v) => v.delivery.blocked === 1, 45000);
    const before = (await ingests()).length, callsBefore = (await letterCalls()).length;
    assert.equal((await web("/web/letter/retry", {})).status, 200);
    await until(view, (v) => v.delivery.blocked === 1);
    assert.equal((await ingests()).length, before);
    await set("AELIOS_NAMESPACE", "");
    const done = await until(view, (v) => v.delivery.latest?.id === pending.delivery.latest.id && v.delivery.latest.status === "sent");
    assert.equal(done.delivery.blocked, 0);
    assert.ok((await ingests()).every((row) => row.body.namespace === "test-space"));
    assert.equal((await letterCalls()).length, callsBefore, "resending never rewrites the letter");
  });
}

if (phase === "restart-1") {
  await fetch(`${MOCK}/__reset`);
  await fill();
  await model();
  await faults({ ingestFailures: 1 });
  await step("a failed send leaves a durable pending letter before Worker restart", async () => {
    assert.match(await ask("/handoff"), /^交接信写好了/);
    const state = await until(view, (v) => v.delivery.pending === 1 && v.delivery.latest?.lastError);
    assert.equal(state.write.state, "written");
    assert.equal(state.delivery.latest.attempts, 1);
    assert.equal((await ingests()).length, 1);
  });
}
if (phase === "restart-2") {
  await step("restarted Worker resumes the pending delivery, keeping its original id and without generating again", async () => {
    const record = (await ingests())[0];
    assert.ok(record.letterId);
    const callsBefore = (await letterCalls()).length;
    const state = await until(view, (v) => v.delivery.latest?.status === "sent", 45000);
    assert.equal(state.delivery.latest.id, record.letterId);
    assert.equal(state.delivery.latest.attempts, 2);
    assert.equal((await ingests()).length, 2);
    assert.deepEqual((await ingests())[1].body, record.body);
    assert.equal((await letterCalls()).length, callsBefore);
  });
}
if (failures) process.exitCode = 1;
