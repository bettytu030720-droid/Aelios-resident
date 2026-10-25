// Focused activity-policy regression: node test/alarm-activity.mjs (Node 22+).
// Execute complete methods extracted from Resident, not a copy of the policy.
// Synthetic UI-message/result shapes, in-memory storage/scheduler, and fake delivery:
// no Worker, real transcript, network, model, or paid calls. Compaction itself is a boundary stub.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(new URL("../src/resident.ts", import.meta.url), "utf8");
function method(name) {
  const match = source.match(new RegExp(`^  (?:private |override )*(?:async )?${name}(?:<[^\\n]+>)?\\([^\\n]*[\\s\\S]*?^  \\}`, "m"));
  assert.ok(match, `cannot extract actual Resident method ${name}`);
  return match[0].replace("override ", "");
}
function fn(name) {
  const match = source.match(new RegExp(`^function ${name}\\([^\\n]*[\\s\\S]*?^\\}`, "m"));
  assert.ok(match, `cannot extract actual Resident function ${name}`);
  return match[0];
}
const built = await build({
  stdin: {
    resolveDir: root, loader: "ts", sourcefile: "alarm-activity-harness.ts",
    contents: `
      import { ALARM_PREFIX, HEARTBEATS, MAX_HEARTBEATS, SKIP, isNote, isCheckin, heartbeatPrompt, stamp } from "./src/prompts.ts";
      import { taskOfNote } from "./src/cloud-tasks.ts";
      import { onMessages } from "./src/via-aelios.ts";
      import { reachesLetterThreshold, letterTokenThreshold } from "./src/fold.ts";
      export { ALARM_PREFIX, SKIP };
      export { checkinPrompt, heartbeatPrompt, letterPrompt } from "./src/prompts.ts";
      export { alarmNote } from "./src/alarms.ts";
      let now = 0;
      export function setNow(at) { now = at; }
      const NativeDate = globalThis.Date;
      class Date extends NativeDate {
        constructor(value = now) { super(value); }
        static now() { return now; }
      }
      // External delivery/memory boundaries only. Never call actual ingest or Telegram.
      export const ingested = [];
      const aeliosConfig = (cfg) => cfg.memory ? { synthetic: true } : null;
      const ingest = async (...args) => { ingested.push(args); };
      const splitIntoBubbles = (text) => [text];
      const chatIdOf = (thread) => thread;
      const resumeLetterCompaction = async () => { throw new Error("unexpected recovery boundary"); };
      ${["idleMinutes", "promptCache", "textOf"].map(fn).join("\n")}
      export class ActivityHarness {
        #drafts = new Map();
        #draftActive = null;
        #searches = new Map();
        #theirTurns = new Set();
        #readOutside = new Set();
        #turnThread = new Map();
        #stickerSent = new Set();
        #turnTasks = new Map();
        #outbox = new Map();
        #short = false;
        #letterPromise = null;
        #letterReason = "handoff";
        #letterAttempted = false;
        activeTurn = null;
        cfg = {};
        tz = "UTC";
        messages = [];
        defaultModel = "fake";
        hydrationByteBudget = 32 * 1024 * 1024;
        // Admission/compaction are boundaries here; effective-history.mjs tests the real planner.
        historyControl() { return { admission: async () => "fits" }; }
        job = null;
        finished = [];
        learned = [];
        writes = [];
        windows = [];
        letterJob() { return this.job; }
        async finishLetter(...args) { this.finished.push(args); }
        clearTurn() {}
        savedModel() { return "fake"; }
        alarmsOn() { return true; }
        async checkinAsVoice() { return false; }
        learn(...args) { this.learned.push(args); }
        letterState() { return { write: (value) => this.writes.push(value) }; }
        failLetter(error) { this.writes.push({ state: "failed", error }); }
        setWindow(...args) { this.windows.push(args); }
        letterThreshold() { return letterTokenThreshold(this.cfg.LETTER_TOKEN_THRESHOLD); }
        seedSearch(requestId) { this.#searches.set(requestId, [{ synthetic: "search result" }]); }
        ${["onChatResponse", "userMessageBefore", "planIdleLetter", "stopHeartbeats", "idleLetter",
          "heartbeatTimes", "heartbeatOn", "heartbeat", "heartbeatAgain", "writeLetter", "letterExclusive", "performWriteLetter"].map(method).join("\n")}
      }
    `,
  },
  bundle: true, platform: "node", target: "node22", format: "esm", write: false, logLevel: "error",
});
const { ActivityHarness, ALARM_PREFIX, SKIP, alarmNote, checkinPrompt, heartbeatPrompt, letterPrompt, setNow, ingested } =
  await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

const MIN = 60_000;
const START = Date.parse("2026-10-24T12:00:00Z");
const THEIR_LAST = START - 24 * 60 * MIN;
const alarm = () => alarmNote({ id: "synthetic-alarm", note: "synthetic reminder", repeat: "every 1 hour", anchor: START, next: START, setAt: START, scheduleId: "synthetic-ring" }, "now", "earlier");
const ui = (id, role, text) => ({ id, role, parts: [{ type: "text", text }], metadata: { at: START } });

class Storage {
  values = new Map([["their_last_at", THEIR_LAST]]);
  mutations = [];
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.mutations.push(["put", key, value]); this.values.set(key, structuredClone(value)); }
  async delete(key) { this.mutations.push(["delete", key]); return this.values.delete(key); }
}

function fixture(cfg = {}) {
  setNow(START);
  ingested.length = 0;
  const h = new ActivityHarness();
  h.cfg = cfg;
  h.now = START;
  h.storage = new Storage();
  h.schedules = new Map();
  h.cancelled = [];
  h.delivered = [];
  h.submitted = [];
  h.waits = [];
  h.compactions = 0;
  let serial = 0;
  h.ctx = { storage: h.storage, waitUntil: (promise) => h.waits.push(promise) };
  h.session = {
    getHistoryRowStats: async () => [{ bytes: 100_000 }],
    getHistory: async () => h.messages,
    compact: async () => { h.compactions++; return { synthetic: "compacted" }; },
  };
  h.schedule = async (seconds, callback, payload) => {
    const row = { id: `synthetic-schedule-${++serial}`, at: h.now + seconds * 1000, callback, payload };
    h.schedules.set(row.id, row);
    return row;
  };
  h.cancelSchedule = async (id) => { h.cancelled.push(id); return h.schedules.delete(id); };
  h.toTelegram = async (reply) => { h.delivered.push(reply); return true; };
  h.submitMessages = async (messages) => {
    h.submitted.push(...messages);
    h.messages.push(...messages);
    // Heartbeat 2 passes silently; all three completions must leave the count alone.
    await complete(h, { reply: h.submitted.length === 2 ? SKIP : "synthetic heartbeat", trigger: "submission" });
  };
  h.runTo = async (target) => {
    for (let n = 0; ; n++) {
      assert.ok(n < 20, "unexpected unbounded scheduling loop");
      const row = [...h.schedules.values()].sort((a, b) => a.at - b.at)[0];
      if (!row || row.at > target) break;
      h.now = row.at;
      setNow(h.now);
      h.schedules.delete(row.id); // one-shot dispatch
      await h[row.callback](row.payload);
    }
    h.now = target;
    setNow(target);
  };
  return h;
}

let messages = 0;
async function complete(h, { status = "completed", reply = "synthetic reply", trigger = "submission", recovered = false } = {}) {
  const id = `synthetic-result-${++messages}`;
  const result = { requestId: `req-${id}`, continuation: false, status, recovered, message: ui(id, "assistant", reply), ...(status === "error" ? { error: "synthetic failure" } : {}) };
  h.messages.push(result.message);
  h.seedSearch(result.requestId); // A tool search in an alarm must not turn it into learning from a user.
  h.activeTurn = trigger ? { trigger } : null;
  try { await h.onChatResponse(result); } finally { h.activeTurn = null; }
  return result;
}
async function respond(h, asked, options) {
  h.messages.push(ui(`synthetic-prompt-${++messages}`, "user", asked));
  return complete(h, options);
}
async function priorCycle(h, wrote = true) {
  await h.storage.put("wrote_since_letter", wrote);
  const idle = await h.schedule(10 * 60, "idleLetter");
  const beat = await h.schedule(20 * 60, "heartbeatAgain", { n: 3 });
  await h.storage.put("idle_letter", idle.id);
  await h.storage.put("heartbeat", beat.id);
  h.storage.mutations.length = 0;
  return { idle, beat };
}
function idleAt(h, at) {
  const id = h.storage.values.get("idle_letter");
  assert.equal(h.schedules.get(id)?.callback, "idleLetter");
  assert.equal(h.schedules.get(id)?.at, at);
}
function unchangedUserTime(h) {
  assert.equal(h.storage.values.get("their_last_at"), THEIR_LAST);
  assert.ok(!h.storage.mutations.some(([, key]) => key === "their_last_at"));
}

test("completed alarm rearms 55 minutes from response completion and cancels the previous heartbeat chain", async () => {
  const h = fixture({ memory: true });
  const { idle, beat } = await priorCycle(h, false);
  // The model took seven minutes. The deadline is measured from completion, not ring admission.
  h.now += 7 * MIN;
  setNow(h.now);
  const note = alarm();
  assert.ok(note.startsWith(ALARM_PREFIX));
  await respond(h, note);
  idleAt(h, h.now + 55 * MIN);
  assert.deepEqual(h.cancelled, [beat.id, idle.id]);
  assert.equal(h.storage.values.get("wrote_since_letter"), true);
  assert.equal(h.storage.values.has("heartbeat"), false);
  assert.equal(h.schedules.size, 1);
  unchangedUserTime(h);
  assert.deepEqual(h.learned, []);
  assert.deepEqual(h.delivered, ["synthetic reply"], "existing proactive delivery remains");
  await Promise.all(h.waits);
  assert.deepEqual(ingested.map(([, entries, source]) => [entries, source]), [
    [[{ role: "assistant", content: "synthetic reply" }], "aelios-resident:checkin"],
  ], "only the assistant reply is ingested, never the alarm note as user memory");
});

for (const reply of [SKIP, ""]) test(`alarm reply ${JSON.stringify(reply)} still rearms, including recovered hooks without an active trigger`, async () => {
  const h = fixture({ memory: true });
  await priorCycle(h, false);
  await respond(h, alarm(), { reply, trigger: null, recovered: true });
  idleAt(h, START + 55 * MIN);
  assert.equal(h.storage.values.get("wrote_since_letter"), true);
  assert.equal(h.storage.values.has("heartbeat"), false);
  assert.deepEqual(h.delivered, []);
  assert.deepEqual(ingested, []);
  assert.deepEqual(h.learned, []);
  unchangedUserTime(h);
});

for (const status of ["error", "aborted"]) test(`failed alarm (${status}) preserves an existing cycle and cannot revive an exhausted one`, async () => {
  const h = fixture();
  const { idle, beat } = await priorCycle(h);
  await respond(h, alarm(), { status });
  idleAt(h, idle.at);
  assert.deepEqual(h.schedules.get(beat.id), beat);
  assert.deepEqual(h.cancelled, []);
  assert.deepEqual(h.storage.mutations, []);
  assert.deepEqual(h.delivered, []);
  const exhausted = fixture();
  exhausted.storage.values.set("wrote_since_letter", false);
  await respond(exhausted, alarm(), { status });
  assert.equal(exhausted.schedules.size, 0);
  assert.equal(exhausted.storage.values.get("wrote_since_letter"), false);
  unchangedUserTime(h);
  unchangedUserTime(exhausted);
});

for (const [name, note] of [["check-in", checkinPrompt("now")], ["heartbeat", heartbeatPrompt("now", 55, 2, 3)]]) {
  test(`${name} completion does not reset the deadline, heartbeat ordinal or activity flag`, async () => {
    const h = fixture();
    const { idle, beat } = await priorCycle(h);
    await respond(h, note, { reply: SKIP });
    idleAt(h, idle.at);
    assert.deepEqual(h.schedules.get(beat.id), beat);
    assert.deepEqual(h.cancelled, []);
    assert.deepEqual(h.storage.mutations, []);
    const exhausted = fixture();
    exhausted.storage.values.set("wrote_since_letter", false);
    await respond(exhausted, note);
    assert.equal(exhausted.schedules.size, 0);
    assert.equal(exhausted.storage.values.get("wrote_since_letter"), false);
    unchangedUserTime(h);
  });
}

for (const status of ["completed", "error"]) test(`letter response (${status}) takes its existing early return before activity scheduling`, async () => {
  const h = fixture();
  const { idle, beat } = await priorCycle(h, false);
  const prompt = ui("synthetic-letter", "user", letterPrompt("now", true));
  h.job = { promptId: prompt.id };
  h.messages.push(prompt);
  const result = await complete(h, { status });
  assert.deepEqual(h.finished, [[h.job, status, result.message.id]]);
  idleAt(h, idle.at);
  assert.deepEqual(h.schedules.get(beat.id), beat);
  assert.deepEqual(h.storage.mutations, []);
  assert.deepEqual(h.delivered, []);
});

for (const status of ["completed", "error", "aborted"]) test(`existing real-user behavior remains on ${status} responses`, async () => {
  const h = fixture();
  const { idle, beat } = await priorCycle(h, false);
  await respond(h, "[10-24 周六 12:00] synthetic user message", { status, trigger: "messenger" });
  idleAt(h, START + 55 * MIN);
  assert.deepEqual(h.cancelled, [beat.id, idle.id]);
  assert.equal(h.storage.values.get("wrote_since_letter"), true);
  assert.equal(h.learned.length, status === "completed" ? 1 : 0);
  assert.deepEqual(h.delivered, [], "messenger delivery is still not proactive delivery");
});

test("below threshold: an alarm starts one bounded heartbeat cycle, not an indefinitely refreshed idle timer", async () => {
  const h = fixture();
  await respond(h, alarm(), { reply: SKIP });
  await h.runTo(START + 55 * MIN - 1);
  assert.equal(h.submitted.length, 0);
  await h.runTo(START + 55 * MIN);
  assert.equal(h.submitted.length, 1);
  assert.match(h.submitted[0].parts[0].text, /heartbeat 1 of 3/);
  assert.equal(h.storage.values.get("wrote_since_letter"), false);
  assert.equal(h.storage.values.has("idle_letter"), false);
  await h.runTo(START + 4 * 55 * MIN);
  assert.equal(h.compactions, 0);
  assert.equal(h.submitted.length, 3);
  for (let n = 1; n <= 3; n++) assert.match(h.submitted[n - 1].parts[0].text, new RegExp(`heartbeat ${n} of 3`));
  assert.equal(h.delivered.length, 2, "heartbeat 2's SKIP consumes its ordinal without delivery");
  assert.equal(h.schedules.size, 0);
  unchangedUserTime(h);
  // A subsequent ring can start another quiet cycle; alarm admission/daily budget is unchanged.
  await respond(h, alarm(), { reply: SKIP });
  idleAt(h, h.now + 55 * MIN);
  await h.runTo(h.now + 55 * MIN);
  assert.match(h.submitted[3].parts[0].text, /heartbeat 1 of 3/);
});

test("at token threshold: the real idle/write methods compact instead of starting heartbeat 1", async () => {
  const h = fixture();
  h.messages.push(ui("synthetic-large-history", "user", "合".repeat(30_000)));
  await respond(h, alarm(), { reply: SKIP });
  await h.runTo(START + 55 * MIN);
  assert.equal(h.compactions, 1);
  assert.deepEqual(h.windows, [["folded", 1]]);
  assert.equal(h.submitted.length, 0);
  assert.equal(h.schedules.size, 0);
  assert.equal(h.storage.values.get("wrote_since_letter"), false);
});

test("alarm activity arriving during a letter is not overwritten when compaction completes", async () => {
  const h = fixture();
  let entered;
  const entering = new Promise((resolve) => { entered = resolve; });
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  h.session.compact = async () => { entered(); return pending; };
  const writing = h.writeLetter("handoff");
  await entering; // real performWriteLetter has cleared wrote_since_letter before compaction
  assert.equal(h.storage.values.get("wrote_since_letter"), false);
  await respond(h, alarm(), { reply: SKIP });
  idleAt(h, START + 55 * MIN);
  finish({ synthetic: "compacted" });
  assert.deepEqual(await writing, { status: "written" });
  assert.equal(h.storage.values.get("wrote_since_letter"), true, "completion must not clear newer alarm activity");
  idleAt(h, START + 55 * MIN);
});

test("an alarm uses the configured idle delay rather than hard-coding 55 minutes", async () => {
  const h = fixture({ LETTER_IDLE_MINUTES: "12" });
  await respond(h, alarm(), { reply: SKIP });
  idleAt(h, START + 12 * MIN);
});
