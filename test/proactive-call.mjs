// Unit tests for proactive web calls (src/proactive-call.ts, src/residents.ts, src/config.ts).
// Usage: node test/proactive-call.mjs
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-proactive-call-"));
const out = join(dir, "proactive-call.mjs");
await build({
  stdin: {
    contents: [
      'export * from "./src/proactive-call.ts";',
      'export { residentEnv } from "./src/residents.ts";',
      'export { fieldOf, cleaned, withSaved } from "./src/config.ts";',
      'export { isNote } from "./src/prompts.ts";'
    ].join("\n"),
    resolveDir: process.cwd(),
    loader: "ts"
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: out,
  logLevel: "error"
});
const mod = await import(pathToFileURL(join(process.cwd(), out)).href);
rmSync(dir, { recursive: true, force: true });

function makeSql() {
  const db = new DatabaseSync(":memory:");
  return (strings, ...values) => {
    const query = strings.reduce((acc, part, idx) => acc + part + (idx < values.length ? "?" : ""), "");
    const stmt = db.prepare(query);
    return /^\s*SELECT\b/i.test(query) ? stmt.all(...values) : (stmt.run(...values), []);
  };
}

let failed = 0;
function step(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

step("PROACTIVE_CALL config field validates on/off and non-default residents default to off", () => {
  const field = mod.fieldOf("PROACTIVE_CALL");
  assert.ok(field, "PROACTIVE_CALL field exists");
  assert.deepEqual(mod.cleaned(field, "ON"), { value: "on" });
  assert.deepEqual(mod.cleaned(field, "off"), { value: "off" });
  assert.ok("error" in mod.cleaned(field, "maybe"));
  const workerEnv = { PROACTIVE_CALL: "on" };
  const bobEnv = mod.withSaved(mod.residentEnv(workerEnv, "bob", {}), {});
  assert.equal(bobEnv.PROACTIVE_CALL, "off", "other residents never inherit worker PROACTIVE_CALL=on");
  const bobEnabled = mod.withSaved(mod.residentEnv(workerEnv, "bob", { PROACTIVE_CALL: "on" }), { PROACTIVE_CALL: "on" });
  assert.equal(bobEnabled.PROACTIVE_CALL, "on", "resident can opt in explicitly");
});

step("call notes are system notes and a placed call can be recovered from the stored tool part", () => {
  const ansNote = mod.proactiveCallAnsweredNote("11-25 周三 21:00");
  const fbNote = mod.proactiveCallFallbackNote("declined", "11-25 周三 21:00");
  assert.ok(mod.isProactiveCallNote(ansNote) && mod.isNote(ansNote));
  assert.ok(mod.isProactiveCallNote(fbNote) && mod.isNote(fbNote));
  const input = { opening: "喂，聊两句", fallback: "有空回我", topic: "聊方案" };
  assert.deepEqual(mod.placedProactiveCall([{ type: "tool-call_web", input, output: "Placed: ringing" }]), input);
  assert.equal(mod.placedProactiveCall([{ type: "tool-call_web", input, output: "Not placed: quiet hours" }]), null);
});

step("single active ring, atomic answer prevents duplicate tab accept and blocks late decline/expire", () => {
  const store = new mod.ProactiveCallStore(makeSql());
  const request = { id: "c_reply1", opening: "喂，聊两句", fallback: "有空回我", topic: "聊方案", now: 1000, expiresAt: 46000 };
  const started = store.start(request);
  assert.ok(started);
  assert.equal(store.active(2000)?.id, started.id);
  assert.equal(store.start({ ...request, id: "c_reply2", now: 2000, expiresAt: 47000 }), null);
  assert.equal(store.expire(started.id, 45999), null, "an early timeout cannot end the ring");

  const tab1 = store.answer(started.id, 5000, "tab-1");
  assert.equal(tab1.ok, true);
  assert.equal(tab1.call.clientId, "tab-1");
  assert.equal(store.active(5000), null);

  const tab2 = store.answer(started.id, 5100, "tab-2");
  assert.deepEqual(tab2, { ok: false, reason: "already_answered" });
  const lateDecline = store.decline(started.id, 5200, "tab-2");
  assert.deepEqual(lateDecline, { ok: false, reason: "already_answered" });
  assert.equal(store.start({ ...request, now: 5200, expiresAt: 51000 }), null, "replaying the response cannot reopen an answered call");
  assert.equal(store.expire(started.id, 50000), null);
  assert.equal(store.claimFallbackDelivery(started.id, 50000), null, "answered call never claims fallback");
});

step("decline and timeout each allow fallback delivery at most once", () => {
  const store = new mod.ProactiveCallStore(makeSql());
  const c1 = store.start({ id: "c_reply1", opening: "开场1", fallback: "兜底1", topic: "", now: 1000, expiresAt: 10000 });
  const declined = store.decline(c1.id, 2000, "tab-a");
  assert.equal(declined.ok, true);
  assert.deepEqual(store.pendingFallbacks().map((call) => call.id), [c1.id], "restart can find an unsettled fallback");
  assert.ok(store.claimFallbackDelivery(c1.id, 2100), "first fallback claim succeeds");
  assert.deepEqual(store.pendingFallbacks(), []);
  assert.equal(store.claimFallbackDelivery(c1.id, 2200), null, "second fallback claim is blocked");
  assert.equal(store.expire(c1.id, 12000), null);
  assert.deepEqual(store.answer(c1.id, 2500, "tab-b"), { ok: false, reason: "declined" });

  const c2 = store.start({ id: "c_reply2", opening: "开场2", fallback: "兜底2", topic: "", now: 20000, expiresAt: 30000 });
  const lateAnswer = store.answer(c2.id, 30000, "tab-a");
  assert.equal(lateAnswer.ok, false);
  assert.equal(lateAnswer.reason, "expired");
  assert.ok(lateAnswer.expiredCall, "late answer transitions overdue ring to missed");
  assert.ok(store.claimFallbackDelivery(c2.id, 30100));
  assert.equal(store.claimFallbackDelivery(c2.id, 30200), null);
});

step("cancelRinging stops active rings without making them eligible for fallback", () => {
  const store = new mod.ProactiveCallStore(makeSql());
  const c = store.start({ id: "c_reply", opening: "开场", fallback: "兜底", topic: "", now: 1000, expiresAt: 20000 });
  const cancelled = store.cancelRinging(3000, "user_replied");
  assert.equal(cancelled.length, 1);
  assert.equal(store.active(3000), null);
  assert.equal(store.claimFallbackDelivery(c.id, 3100), null);
});

if (failed) process.exit(1);
