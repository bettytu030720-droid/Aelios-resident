// End-to-end local Worker regression for resident-initiated proactive web calls.
// Start a FRESH wrangler.test.jsonc Worker with:
//   --var ALARM_MINUTE_SECONDS:0.5 --var PROACTIVE_CALL_RING_SECONDS:3 --var PROACTIVE_CALL_ONLINE_SECONDS:2
// Uses fake model/services only (test/mock-server.mjs on :9999); never touches production.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const BASE = process.env.WORKER_URL || "http://127.0.0.1:8787";
const MOCK = process.env.MOCK_URL || "http://127.0.0.1:9999";
const HEADERS = { "x-web-key": "test-web-key", "content-type": "application/json" };

async function web(path, body, status = 200) {
  const response = await fetch(BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000)
  });
  assert.equal(response.status, status, `${path} -> ${response.status}`);
  return response.json();
}

async function mockLog() {
  const response = await fetch(`${MOCK}/__log`);
  assert.equal(response.status, 200);
  return response.json();
}

async function tgMessages() {
  return (await mockLog()).filter((e) => e.kind === "tg.sendMessage").map((e) => String(e.body?.text ?? ""));
}

async function voiceTtsCalls() {
  return (await mockLog()).filter((e) => e.kind === "voice" && String(e.endpoint).startsWith("v1/text-to-speech/"));
}

async function aeliosIngests() {
  return (await mockLog()).filter((e) => e.kind === "aelios.ingest");
}

async function until(fn, timeout = 25000, stepMs = 150) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(stepMs);
  }
  assert.fail("timed out waiting for expected state");
}

function currentQuietSpan(timeZone = "Asia/Singapore") {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const start = String((hour + 23) % 24).padStart(2, "0");
  const end = String((hour + 2) % 24).padStart(2, "0");
  return `${start}:00-${end}:00`;
}

function tinyWavBase64() {
  const bytes = Buffer.alloc(64);
  bytes.write("RIFF", 0);
  bytes.write("WAVE", 8);
  return bytes.toString("base64");
}

async function sendTelegramSeed(updateId, text) {
  const response = await fetch(`${BASE}/messengers/telegram/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "test-secret" },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        text,
        from: { id: 42, is_bot: false, username: "her_test", first_name: "Her" },
        chat: { id: 42, type: "private", username: "her_test" }
      }
    })
  });
  assert.equal(response.status, 200);
}

await fetch(`${MOCK}/__reset`);

// 1. Auth & input validation on call endpoints.
const unauth = await fetch(`${BASE}/web/call/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"id":"c_1"}' });
assert.equal(unauth.status, 401);
const badJson = await fetch(`${BASE}/web/call/decline`, { method: "POST", headers: HEADERS, body: "{" });
assert.equal(badJson.status, 400);
await web("/web/call/answer", {}, 400);
await web("/web/call/decline", { id: "" }, 400);
console.log("PASS call endpoints require auth and validate JSON bodies");

// Seed Telegram door thread so fallback proactive deliveries can also be observed on fake Telegram.
await sendTelegramSeed(98001, "先接通 Telegram 渠道");
await until(async () => (await tgMessages()).length >= 1);

// 2. Default off: PROACTIVE_CALL defaults to off, call_web is not offered.
await web("/web/config", { key: "VOICE_PROVIDER", text: "elevenlabs" });
await web("/web/config", { key: "VOICE_API_KEY", text: "test-voice-key" });
await web("/web/config", { key: "VOICE_ID", text: "voice-resident-1" });
await web("/web/config", { key: "VOICE_BASE_URL", text: "http://127.0.0.1:9999/voice" });
await web("/web/config", { key: "ALARMS", text: "on" });
await web("/web/say", { text: "主动来电工具在吗" });
let state = await web("/web/messages");
assert.ok(state.data.at(-1).text.includes("没有 call_web"));
assert.equal(state.incomingCall, null);
console.log("PASS PROACTIVE_CALL defaults to off and does not expose call_web");

// 3. Turn on PROACTIVE_CALL: call_web exists, but normal user turns cannot place calls.
await web("/web/config", { key: "PROACTIVE_CALL", text: "on" });
await web("/web/say", { text: "主动来电工具在吗" });
state = await web("/web/messages");
assert.ok(state.data.at(-1).text.includes("有 call_web"));
await web("/web/say", { text: "普通消息强行来电" });
state = await web("/web/messages");
assert.ok(state.data.at(-1).text.includes("Not placed: proactive calls can only be started"));
assert.equal(state.incomingCall, null);
console.log("PASS normal chat turns cannot invoke call_web");

// 4. Quiet hours honored: alarm during QUIET_HOURS never rings or creates incomingCall.
const quietSpan = currentQuietSpan("Asia/Singapore");
await web("/web/config", { key: "QUIET_HOURS", text: quietSpan });
await web("/web/say", { text: "定来电闹钟：强行打免打扰" });
await until(async () => {
  const current = await web("/web/messages");
  return current.data.some((line) => line.role === "assistant" && line.text.includes("Not placed: it is quiet hours now."));
});
assert.equal((await web("/web/messages")).incomingCall, null);
await web("/web/config", { key: "QUIET_HOURS", text: "off" });
console.log("PASS quiet hours block proactive calls even if the model attempts call_web");

// 5. Offline fallback ("网页没接到"): no recent /web/messages poll -> single fallback via proactive pipeline, no duplicate chatty text.
const tgBeforeOffline = (await tgMessages()).length;
const ingestBeforeOffline = (await aeliosIngests()).length;
await web("/web/say", { text: "定来电闹钟：离线嘴碎" });
// Do NOT poll /web/messages for > PROACTIVE_CALL_ONLINE_SECONDS (2s) so the web door counts as offline when the alarm rings.
await delay(3200);
await until(async () => (await tgMessages()).length > tgBeforeOffline, 20000);
await delay(400);
const tgAfterOffline = await tgMessages();
const offlineSent = tgAfterOffline.slice(tgBeforeOffline);
assert.equal(offlineSent.length, 1, `expected exactly 1 Telegram fallback, got ${offlineSent.length}`);
assert.ok(offlineSent[0].includes("离线嘴碎"));
assert.ok(!offlineSent[0].includes("不应该重复发出的废话"));
state = await web("/web/messages");
assert.equal(state.incomingCall, null);
const offlineLines = state.data.filter((line) => line.role === "assistant" && line.via === "checkin" && line.text.includes("刚才想给你打个电话聊聊「离线嘴碎」"));
assert.equal(offlineLines.length, 1, "fallback appears once in web history");
assert.ok(!state.data.some((line) => line.text.includes("不应该重复发出的废话")), "chatty post-tool text is suppressed");
assert.ok((await aeliosIngests()).length > ingestBeforeOffline, "fallback is ingested to Aelios memory");
console.log("PASS offline web door falls back once via existing proactive pipeline without duplicate messages");

// 6. Ring + Decline ("拒接"): web online -> incomingCall rings -> decline delivers fallback once -> late accept is 409, no second fallback after timeout.
const tgBeforeDecline = (await tgMessages()).length;
await web("/web/say", { text: "定来电闹钟：测试拒接" });
const ringingDecline = await until(async () => {
  const current = await web("/web/messages");
  return current.incomingCall;
});
assert.equal(ringingDecline.residentId, "default");
assert.equal(ringingDecline.topic, "测试拒接");
assert.equal((await tgMessages()).length, tgBeforeDecline, "ringing alone does not send a Telegram message");

const declined = await web("/web/call/decline", { id: ringingDecline.id, residentId: "default", clientId: "tab-1" });
assert.equal(declined.status, "declined");
const lateAfterDecline = await web("/web/call/answer", { id: ringingDecline.id, residentId: "default", clientId: "tab-2" }, 409);
assert.equal(lateAfterDecline.reason, "declined");
// Wait past ring timeout to verify scheduled timeout does not send a second fallback.
await delay(3600);
const tgAfterDecline = (await tgMessages()).slice(tgBeforeDecline);
assert.equal(tgAfterDecline.length, 1, "decline delivers fallback exactly once");
assert.ok(tgAfterDecline[0].includes("测试拒接"));
state = await web("/web/messages");
assert.equal(state.incomingCall, null);
assert.equal(state.data.filter((line) => line.role === "assistant" && line.via === "checkin" && line.text.includes("刚才想给你打个电话聊聊「测试拒接」")).length, 1);
console.log("PASS declining delivers single fallback, rejects late accept (409), and prevents duplicate timeout fallback");

// 7. Ring + Timeout ("超时"): web online -> incomingCall rings -> unanswered until timeout -> single fallback once, late accept is 409.
const tgBeforeTimeout = (await tgMessages()).length;
await web("/web/say", { text: "定来电闹钟：测试超时" });
const ringingTimeout = await until(async () => (await web("/web/messages")).incomingCall);
assert.equal(ringingTimeout.topic, "测试超时");
await delay(3600);
await until(async () => (await tgMessages()).length > tgBeforeTimeout, 10000);
const lateAfterTimeout = await web("/web/call/answer", { id: ringingTimeout.id, residentId: "default", clientId: "tab-1" }, 409);
assert.equal(lateAfterTimeout.reason, "expired");
await delay(500);
const tgAfterTimeout = (await tgMessages()).slice(tgBeforeTimeout);
assert.equal(tgAfterTimeout.length, 1, "timeout delivers fallback exactly once");
assert.ok(tgAfterTimeout[0].includes("测试超时"));
state = await web("/web/messages");
assert.equal(state.incomingCall, null);
assert.equal(state.data.filter((line) => line.role === "assistant" && line.via === "checkin" && line.text.includes("刚才想给你打个电话聊聊「测试超时」")).length, 1);
console.log("PASS unanswered ring times out cleanly into a single fallback and rejects late accept");

// 8. Ring + Accept ("接听") + multi-tab race + resident voice TTS + follow-up voice call turn.
const tgBeforeAccept = (await tgMessages()).length;
const ttsBeforeAccept = (await voiceTtsCalls()).length;
await web("/web/say", { text: "定来电闹钟：测试接听" });
const ringingAccept = await until(async () => (await web("/web/messages")).incomingCall);
assert.equal(ringingAccept.topic, "测试接听");
// Wrong residentId is rejected while call stays ringing.
const wrongRes = await web("/web/call/answer", { id: ringingAccept.id, residentId: "bob", clientId: "tab-bad" }, 409);
assert.equal(wrongRes.reason, "wrong_resident");
// Two tabs press Answer together. Only one receives the opening.
const answers = await Promise.all(["tab-1", "tab-2"].map(async (clientId) => {
  const response = await fetch(`${BASE}/web/call/answer`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ id: ringingAccept.id, residentId: "default", clientId }),
    signal: AbortSignal.timeout(15000)
  });
  return { status: response.status, body: await response.json() };
}));
assert.deepEqual(answers.map((result) => result.status).sort(), [200, 409]);
const answered = answers.find((result) => result.status === 200).body;
assert.equal(answered.status, "answered");
assert.equal(answered.residentId, "default");
assert.ok(answered.opening.includes("测试接听"));
assert.equal(answers.find((result) => result.status === 409).body.reason, "already_answered");
const lateDecline = await web("/web/call/decline", { id: ringingAccept.id, residentId: "default", clientId: "tab-2" }, 409);
assert.equal(lateDecline.reason, "already_answered");
// Wait for opening voice synthesis and check TTS endpoint used the resident's configured voice.
const openingLine = await until(async () => {
  const current = await web("/web/messages");
  const line = current.data.find((item) => item.id === answered.messageId);
  return line?.voice?.key ? line : null;
});
assert.ok(openingLine.text.includes("测试接听"));
const mediaRes = await fetch(`${BASE}/web/media?key=${encodeURIComponent(openingLine.voice.key)}`, { headers: { "x-web-key": "test-web-key" } });
assert.equal(mediaRes.status, 200);
const ttsAfterAccept = (await voiceTtsCalls()).slice(ttsBeforeAccept);
assert.ok(ttsAfterAccept.some((call) => call.endpoint === "v1/text-to-speech/voice-resident-1"), "opening uses resident's configured voice");
assert.equal((await tgMessages()).length, tgBeforeAccept, "answered call does not send fallback to Telegram");
// Continue talking on the same call via existing /web/say { voice, call: true } flow.
const followUp = await web("/web/say", { voice: { data: tinyWavBase64() }, call: true });
assert.equal(followUp.status, "completed");
const followUpLine = await until(async () => {
  const current = await web("/web/messages");
  const last = current.data.at(-1);
  return last && last.id !== answered.messageId && last.role === "assistant" && last.voice?.key ? last : null;
});
assert.ok(followUpLine.text.includes("网页上说的话"));
console.log("PASS answering opens main chat with resident's voice, blocks multi-tab duplicates, and continues existing call flow");

// 9. Removing a required voice setting while ringing invalidates the pending answer.
const ttsBeforeCanceled = (await voiceTtsCalls()).length;
await web("/web/say", { text: "定来电闹钟：移除声音" });
const canceledRing = await until(async () => (await web("/web/messages")).incomingCall);
await web("/web/config", { key: "VOICE_ID", text: "" });
assert.equal((await web("/web/messages")).incomingCall, null);
const canceledAnswer = await web("/web/call/answer", { id: canceledRing.id, residentId: "default", clientId: "tab-1" }, 409);
assert.equal(canceledAnswer.reason, "expired");
assert.equal((await voiceTtsCalls()).length, ttsBeforeCanceled, "a stale answer cannot start TTS");
console.log("PASS a voice setting removed while ringing invalidates a late answer");

// 10. Per-resident isolation: second resident defaults to off and its incoming calls never bleed to default.
await web("/web/residents", { id: "bob", name: "Bob" });
await web("/r/bob/web/config", { key: "VOICE_PROVIDER", text: "elevenlabs" });
await web("/r/bob/web/config", { key: "VOICE_API_KEY", text: "test-voice-key" });
await web("/r/bob/web/config", { key: "VOICE_ID", text: "voice-bob-2" });
await web("/r/bob/web/config", { key: "VOICE_BASE_URL", text: "http://127.0.0.1:9999/voice" });
await web("/r/bob/web/config", { key: "ALARMS", text: "on" });
await web("/r/bob/web/say", { text: "主动来电工具在吗" });
assert.ok((await web("/r/bob/web/messages")).data.at(-1).text.includes("没有 call_web"), "second resident defaults to PROACTIVE_CALL=off");

await web("/r/bob/web/config", { key: "PROACTIVE_CALL", text: "on" });
const ttsBeforeBob = (await voiceTtsCalls()).length;
await web("/r/bob/web/say", { text: "定来电闹钟：Bob专属来电" });
const bobRing = await until(async () => (await web("/r/bob/web/messages")).incomingCall);
assert.equal(bobRing.residentId, "bob");
assert.equal((await web("/web/messages")).incomingCall, null, "bob's incoming call never appears on default resident");
await web("/web/call/answer", { id: bobRing.id, residentId: "default", clientId: "tab-1" }, 409);
const bobAnswered = await web("/r/bob/web/call/answer", { id: bobRing.id, residentId: "bob", clientId: "tab-bob" });
assert.equal(bobAnswered.status, "answered");
await until(async () => {
  const current = await web("/r/bob/web/messages");
  return current.data.find((item) => item.id === bobAnswered.messageId)?.voice?.key;
});
const ttsAfterBob = (await voiceTtsCalls()).slice(ttsBeforeBob);
assert.ok(ttsAfterBob.some((call) => call.endpoint === "v1/text-to-speech/voice-bob-2"), "bob's opening uses bob's own voice");
console.log("PASS per-resident opt-in, voice isolation, and cross-resident call isolation hold");
