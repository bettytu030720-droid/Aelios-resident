// Full local Worker regression for the reported post-letter alarm/cache gap.
// Start a FRESH wrangler.test.jsonc Worker with --var ALARM_MINUTE_SECONDS:0.5.
// Uses fake model/services only. Idle initially off; never send to production.
import assert from "node:assert/strict";
const BASE = "http://127.0.0.1:8787";
const HEADERS = { "x-web-key": "test-web-key", "content-type": "application/json" };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function web(path, body) {
  const response = await fetch(BASE + path, { headers: HEADERS, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  assert.equal(response.status, 200);
  return response.json();
}
async function say(text) { assert.equal((await web("/web/say", { text })).status, "completed"); }
async function until(check, timeout = 40_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await sleep(150); }
  throw new Error("timed out waiting for local alarm/activity cycle");
}
await fetch("http://127.0.0.1:9999/__reset");
for (let n = 0; n < 3; n++) await say(`交接信测试材料 ${n}：${"文".repeat(3850)}`);
await web("/web/config", { key: "ALARMS", text: "on" });
await say("等会儿提醒我喝水");
assert.ok((await web("/web/alarms")).alarms.some(item => item.note === "提醒她喝水"));
const handoff = await fetch(BASE + "/messengers/telegram/webhook", {
  method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "test-secret" },
  body: JSON.stringify({ update_id: 91001, message: {
    message_id: 91001, date: Math.floor(Date.now() / 1000), text: "/handoff",
    from: { id: 42, is_bot: false, username: "her_test", first_name: "Her" },
    chat: { id: 42, type: "private", username: "her_test" }
  } })
});
assert.equal(handoff.status, 200);
await until(async () => (await web("/web/letter")).write?.state === "written", 10_000);
console.log("PASS handoff completed before the scheduled alarm, with idle checks still disabled");
await web("/web/config", { key: "LETTER_IDLE_MINUTES", text: "0.05" });
const before = (await web("/web/messages")).data;
const usersBefore = before.filter(item => item.role === "user").length;
await until(async () => (await web("/web/messages")).data.some(item => item.role === "assistant" && item.text.includes("闹钟响了：提醒她喝水")));
// No further user/model input. With the old wrote_since_letter=false gate, no heartbeat could run here.
await until(async () => (await web("/web/alarms")).alarms.some(item => item.note === "晚点再问问她"), 12_000);
console.log("PASS completed post-letter alarm starts a fresh idle/heartbeat cycle without another user message");
const after = (await web("/web/messages")).data;
assert.equal(after.filter(item => item.role === "user").length, usersBefore);
assert.ok(!after.some(item => item.role === "user" && /Not from them:.*(?:alarm|heartbeat)/.test(item.text)));
assert.equal((await web("/web/letter")).write.state, "written");
console.log("PASS alarm/heartbeat notes are not relabelled as user messages and no second letter was generated");
