// Voice messages she keeps (src/kept-voices.ts, src/media-store.ts): kept ones are never pruned and do not count
// towards the 200 MB; with no R2 bucket they stay in SQLite, with one they move there and come back when let go.
// node:sqlite stands in for the agent's SQLite, a Map for the bucket. Run: node test/kept-voices.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join(realpathSync("node_modules/.cache"), "kept-voices-"));
let media, kept;
try {
  await build({ entryPoints: ["src/kept-voices.ts", "src/media-store.ts"], bundle: true, platform: "node", format: "esm", outdir: dir, outExtension: { ".js": ".mjs" }, logLevel: "error" });
  const load = (name) => import(pathToFileURL(join(dir, `${name}.mjs`)).href);
  [kept, media] = await Promise.all([load("kept-voices"), load("media-store")]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const MB = 1024 * 1024;
// `db` to open the same SQLite again (a new isolate), `sentAwayAs` as the resident gives it (the earlier draft's name).
const store = (onAwayRemoved, { db = new DatabaseSync(":memory:"), sentAwayAs } = {}) => {
  const sql = (strings, ...values) => {
    const statement = db.prepare(strings.join("?"));
    const bound = values.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value)); // Node's SQLite takes views, Workers' takes buffers
    return statement.columns().length ? statement.all(...bound) : (statement.run(...bound), []);
  };
  const m = new media.MediaStore(sql, undefined, onAwayRemoved, sentAwayAs);
  m.db = db;
  return m;
};
/** An R2 bucket in memory, with what was done to it. */
const bucket = ({ failPut = false, failDeletes = 0 } = {}) => {
  const objects = new Map();
  const deleted = [];
  // Requests held back until let go (holdDeletes, holdPuts, holdGets): R2 requests can land in any order.
  const held = [];
  const wait = () => new Promise((resolve) => held.push(resolve));
  return {
    objects,
    deleted,
    held,
    holdDeletes: false,
    holdPuts: false,
    holdGets: false,
    release() {
      for (const resolve of held.splice(0)) resolve();
    },
    async put(key, bytes, options) {
      if (this.holdPuts) await wait();
      if (failPut) throw new Error("R2 is down");
      objects.set(key, { bytes: new Uint8Array(bytes), type: options?.httpMetadata?.contentType });
    },
    async get(key) {
      if (this.holdGets) await wait();
      const object = objects.get(key);
      return object ? { arrayBuffer: async () => object.bytes.buffer.slice(object.bytes.byteOffset, object.bytes.byteOffset + object.bytes.byteLength) } : null;
    },
    failDeletes,
    async delete(keys) {
      if (this.holdDeletes) await wait();
      if (this.failDeletes > 0) {
        this.failDeletes -= 1;
        throw new Error("R2 delete failed");
      }
      for (const key of [keys].flat()) {
        deleted.push(key);
        objects.delete(key);
      }
    },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    }
  };
};
const audio = (size, fill = 1) => new Uint8Array(size).fill(fill);
const putVoice = (m, size = 5 * MB, fill = 1) => m.put("voice", "audio/wav", audio(size, fill), 3).key;
const voiceOf = (message, keys) => ({ message, role: "user", text: "今天好累呀", keys, seconds: 3, at: 1000 });

await test("without a bucket: a kept voice stays in SQLite, is never pruned and does not count towards the 200 MB", async () => {
  const m = store();
  const voices = new kept.KeptVoices(m, null, "default");
  const first = putVoice(m);
  assert.equal(await voices.keep(voiceOf("msg-1", [first])), true);
  assert.equal(m.isAway(first), false);
  // 41 more of 5 MB: 205 MB besides the kept one, so the oldest unkept go, never the kept one.
  const later = Array.from({ length: 41 }, () => putVoice(m));
  assert.ok(m.get(first), "the kept voice is still there");
  assert.equal(m.kindOf(later[0]), null, "the oldest unkept one went");
  assert.ok(m.get(later[1]), "200 MB of the others stay: the kept one is not counted");
  assert.deepEqual((await voices.file(first)).bytes.length, 5 * MB);
  assert.deepEqual(m.keptVoices().map((voice) => [voice.message, voice.keys, voice.text, voice.memory]), [["msg-1", [first], "今天好累呀", null]]);
  assert.deepEqual([...m.keptAmong(["msg-1", "msg-2"])], ["msg-1"]);

  // Let go, it is the oldest again: pruned at once now the store is full.
  assert.deepEqual(await voices.unkeep("msg-1"), { ok: true });
  assert.equal(m.kept("msg-1"), null);
  assert.equal(m.kindOf(first), null);
});

await test("a voice whose audio is already gone cannot be kept; one said in parts is kept whole", async () => {
  const m = store();
  const voices = new kept.KeptVoices(m, null, "default");
  const a = m.put("spoken", "audio/mpeg", audio(100)).key;
  const b = m.put("spoken", "audio/mpeg", audio(100)).key;
  assert.equal(await voices.keep({ ...voiceOf("gone", [a, "f".repeat(32)]), role: "assistant" }), false);
  assert.equal(m.isKeptFile(a), false, "nothing is half kept");
  assert.equal(await voices.keep({ ...voiceOf("reply", [a, b]), role: "assistant" }), true);
  assert.equal(m.isKeptFile(a) && m.isKeptFile(b), true);
  m.keptInMemory("reply", "p1");
  assert.equal(m.kept("reply").memory, "p1");
  // Keeping it again keeps when it was first kept and its memory.
  const before = m.kept("reply").keptAt;
  await voices.keep({ ...voiceOf("reply", [a, b]), role: "assistant" });
  assert.deepEqual([m.kept("reply").keptAt, m.kept("reply").memory], [before, "p1"]);
  // A file of it removed (its reply taken back) takes the keeping with it.
  m.remove(b);
  assert.equal(m.kept("reply"), null);
});

await test("with a bucket: a kept voice moves there, plays from there, and comes back into SQLite when let go", async () => {
  let told = 0;
  const m = store(() => (told += 1));
  const r2 = bucket();
  const voices = new kept.KeptVoices(m, r2, "second");
  const key = putVoice(m, 3 * MB, 7);
  await voices.keep(voiceOf("msg-1", [key]));
  assert.equal(m.isAway(key), true);
  assert.equal(m.get(key), null, "its bytes left SQLite");
  const [object] = r2.objects.keys();
  assert.match(object, new RegExp(`^voices/second/${key}-[0-9a-f]{8}$`));
  assert.equal(r2.objects.get(object).type, "audio/wav");
  const file = await voices.file(key);
  assert.deepEqual([file.type, file.seconds, file.bytes.length, file.bytes[0]], ["audio/wav", 3, 3 * MB, 7]);

  await voices.unkeep("msg-1");
  assert.equal(m.isAway(key), false);
  assert.equal(m.get(key).bytes[3 * MB - 1], 7, "back in SQLite, whole");
  assert.equal(r2.objects.size, 0, "and gone from the bucket");
  assert.equal(told, 0);

  // Removed while kept (a deleted reply): where it went is written down, and cleared from the bucket.
  const other = putVoice(m, 100);
  await voices.keep(voiceOf("msg-2", [other]));
  const where = m.awayTo(other);
  m.remove(other);
  assert.equal(told, 1);
  assert.deepEqual(m.toClear(), [where]);
  await voices.clear();
  assert.equal(r2.objects.has(where), false);
  assert.deepEqual(m.toClear(), []);
});

await test("with a bucket that fails, the voice stays kept in SQLite; without the bucket any more, letting go waits for it", async () => {
  const m = store();
  const key = putVoice(m, 100);
  assert.equal(await new kept.KeptVoices(m, bucket({ failPut: true }), "default").keep(voiceOf("msg-1", [key])), true);
  assert.deepEqual([m.isAway(key), m.isKeptFile(key), m.get(key).bytes.length], [false, true, 100]);

  const moved = putVoice(m, 100);
  await new kept.KeptVoices(m, bucket(), "default").keep(voiceOf("msg-2", [moved]));
  const unbound = new kept.KeptVoices(m, null, "default");
  assert.match((await unbound.unkeep("msg-2")).error, /KEPT_VOICES/);
  assert.ok(m.kept("msg-2"), "still kept");

  // Nor can the resident be deleted: its voice would be left in the bucket with nothing to find it by.
  assert.match(unbound.forgetProblem(), /KEPT_VOICES/);
  await assert.rejects(unbound.forgetAll(), /KEPT_VOICES/);
  assert.equal(new kept.KeptVoices(m, bucket(), "default").forgetProblem(), null, "bound again, it can");
  assert.equal(new kept.KeptVoices(store(), null, "default").forgetProblem(), null, "nothing in R2, nothing to leave");
});

await test("let go on one device and kept again on another: a late delete of the old copy never takes the new one", async () => {
  const m = store();
  const r2 = bucket();
  // Two at once, each on its own: the order the bucket finishes in decides, as when two requests race.
  const [one, other] = [new kept.KeptVoices(m, r2, "default"), new kept.KeptVoices(m, r2, "default")];
  const key = putVoice(m, 100, 9);
  await one.keep(voiceOf("msg-1", [key]));
  const first = m.awayTo(key);

  r2.holdDeletes = true;
  const letGo = one.unkeep("msg-1");
  while (!r2.held.length) await new Promise((resolve) => setTimeout(resolve, 1));
  // Let go here (back in SQLite, its old copy's delete still on its way), and kept again there meanwhile.
  r2.holdDeletes = false;
  assert.equal(await other.keep(voiceOf("msg-1", [key])), true);
  const second = m.awayTo(key);
  assert.notEqual(second, first);
  for (const resolve of r2.held) resolve();
  await letGo;

  assert.deepEqual([...r2.objects.keys()], [second], "only the old copy went");
  assert.ok(m.kept("msg-1"), "kept");
  assert.equal((await other.file(key)).bytes[99], 9, "and it still plays");
});

await test("a reply taken back while R2 is not bound: its copy there is remembered, and the resident cannot be deleted until it is cleared", async () => {
  const m = store();
  const r2 = bucket();
  const key = putVoice(m, 100);
  await new kept.KeptVoices(m, r2, "second").keep(voiceOf("msg-1", [key]));
  const where = m.awayTo(key);
  const unbound = new kept.KeptVoices(m, null, "second");
  m.remove(key);
  await unbound.clear();
  assert.match(unbound.forgetProblem(), /KEPT_VOICES/, "nothing in SQLite points at it any more, but it is still in R2");
  await assert.rejects(unbound.forgetAll(), /KEPT_VOICES/);
  assert.ok(r2.objects.has(where));
  const bound = new kept.KeptVoices(m, r2, "second");
  await bound.clear();
  assert.deepEqual([r2.objects.size, bound.forgetProblem()], [0, null]);
});

await test("deleting the resident waits for a keep under way, takes what it put in the bucket, and nothing is kept after", async () => {
  const m = store();
  const r2 = bucket();
  const voices = new kept.KeptVoices(m, r2, "second");
  r2.holdPuts = true;
  const keeping = voices.keep(voiceOf("msg-1", [putVoice(m, 100)]));
  while (!r2.held.length) await new Promise((resolve) => setTimeout(resolve, 1));
  const forgetting = voices.forgetAll();
  r2.holdPuts = false;
  r2.release();
  await Promise.all([keeping, forgetting]);
  assert.equal(r2.objects.size, 0, "listed after the keep was written, so it went too");
  assert.equal(await voices.keep(voiceOf("msg-2", [putVoice(m, 100)])), false);
  assert.equal(r2.objects.size, 0);
});

await test("kept again while a letting go waits on the bucket: the keep waits its turn and wins", async () => {
  const m = store();
  const r2 = bucket();
  const voices = new kept.KeptVoices(m, r2, "default");
  const key = putVoice(m, 100, 6);
  await voices.keep(voiceOf("msg-1", [key]));
  r2.holdGets = true;
  const letGo = voices.unkeep("msg-1");
  while (!r2.held.length) await new Promise((resolve) => setTimeout(resolve, 1));
  // What the web door does: look and keep in one turn, never on what it saw before its turn.
  const again = voices.run(async () => (m.kept("msg-1") ? "skipped" : await voices.keepNow(voiceOf("msg-1", [key]))));
  r2.holdGets = false;
  r2.release();
  assert.deepEqual(await Promise.all([letGo, again]), [{ ok: true }, true]);
  assert.ok(m.kept("msg-1"), "kept in the end");
  assert.equal((await voices.file(key)).bytes[0], 6);
});

await test("a voice sent to R2 by the earlier draft (no name written down) is found under its old name", async () => {
  const m = store();
  const r2 = bucket();
  const key = putVoice(m, 100, 5);
  await new kept.KeptVoices(m, r2, "second").keep(voiceOf("msg-1", [key]));
  const [now] = r2.objects.keys();
  // As 2a66361 left it: the object at voices/<resident>/<key>, and nothing in away_to.
  r2.objects.set(`voices/second/${key}`, r2.objects.get(now));
  r2.objects.delete(now);
  m.db.prepare("UPDATE res_media SET away_to = NULL").run();
  // Opened again by this version: the name is written down as the store opens, before anything can remove it.
  const again = store(undefined, { db: m.db, sentAwayAs: (key) => `voices/second/${key}` });
  const voices = new kept.KeptVoices(again, r2, "second");
  assert.equal(again.awayTo(key), `voices/second/${key}`);
  assert.equal((await voices.file(key)).bytes[0], 5);
  assert.deepEqual(await voices.unkeep("msg-1"), { ok: true });
  assert.equal(again.get(key).bytes[99], 5, "back in SQLite");
  assert.equal(r2.objects.size, 0);
});

await test("an earlier draft's voice, R2 unbound, its reply taken back first: its old name is still to clear, and the resident waits for it", async () => {
  const m = store();
  const r2 = bucket();
  const key = putVoice(m, 100, 5);
  await new kept.KeptVoices(m, r2, "second").keep(voiceOf("msg-1", [key]));
  const [now] = r2.objects.keys();
  r2.objects.set(`voices/second/${key}`, r2.objects.get(now));
  r2.objects.delete(now);
  m.db.prepare("UPDATE res_media SET away_to = NULL").run();
  const again = store(undefined, { db: m.db, sentAwayAs: (key) => `voices/second/${key}` });
  const unbound = new kept.KeptVoices(again, null, "second");
  // The first thing done, before any letting go or clearing: the reply is taken back.
  again.remove(key);
  assert.deepEqual(again.toClear(), [`voices/second/${key}`]);
  assert.match(unbound.forgetProblem(), /KEPT_VOICES/);
  await assert.rejects(unbound.forgetAll(), /KEPT_VOICES/);
  const bound = new kept.KeptVoices(again, r2, "second");
  await bound.clear();
  assert.deepEqual([r2.objects.size, again.toClear(), bound.forgetProblem()], [0, [], null]);
});

await test("a delete in R2 that fails is never taken as done: the copy stays to clear, tried again, and holds the resident's delete", async () => {
  const m = store();
  const r2 = bucket({ failDeletes: 1 });
  const voices = new kept.KeptVoices(m, r2, "second");
  const key = putVoice(m, 100, 3);
  await voices.keep(voiceOf("msg-1", [key]));
  const where = m.awayTo(key);
  // Let go: the audio comes back, but clearing its copy fails.
  assert.deepEqual(await voices.unkeep("msg-1"), { ok: true });
  assert.equal(m.get(key).bytes[0], 3, "the audio is back in SQLite");
  assert.ok(r2.objects.has(where));
  assert.deepEqual(m.toClear(), [where], "still to clear");
  // Deleting the resident clears it first; a failure there stops the delete.
  r2.failDeletes = 1;
  await assert.rejects(new kept.KeptVoices(m, r2, "second").forgetAll(), /could not be cleared/);
  assert.deepEqual(m.toClear(), [where]);
  await voices.clear();
  assert.deepEqual([r2.objects.has(where), m.toClear()], [false, []], "cleared the next time");
  // A copy the bucket no longer has counts as cleared.
  m.copying("voices/second/never-made");
  await voices.clear();
  assert.deepEqual(m.toClear(), []);
});

await test("a copy made but never pointed to (let go while it was written) is cleared, not left in R2", async () => {
  const m = store();
  const r2 = bucket();
  const voices = new kept.KeptVoices(m, r2, "default");
  const key = putVoice(m, 100);
  m.keep(voiceOf("msg-1", [key]));
  r2.holdPuts = true;
  const sending = voices.keepNow(voiceOf("msg-1", [key]));
  while (!r2.held.length) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(m.toClear().length, 1, "written down before the copy is made");
  m.unkeep("msg-1");
  m.db.prepare("UPDATE res_media SET kept = 0").run();
  r2.holdPuts = false;
  r2.release();
  await sending;
  assert.deepEqual([r2.objects.size, m.toClear(), m.isAway(key)], [0, [], false]);
  // And one that failed to be written leaves nothing to clear either.
  const failing = new kept.KeptVoices(m, bucket({ failPut: true }), "default");
  assert.equal(await failing.keep(voiceOf("msg-2", [putVoice(m, 100)])), true);
  assert.deepEqual(m.toClear(), []);
});

await test("played while being let go: a voice whose copy is just gone from R2 is read from SQLite", async () => {
  const m = store();
  const r2 = bucket();
  const voices = new kept.KeptVoices(m, r2, "default");
  const key = putVoice(m, 100, 8);
  await voices.keep(voiceOf("msg-1", [key]));
  r2.holdGets = true;
  const playing = voices.file(key);
  while (!r2.held.length) await new Promise((resolve) => setTimeout(resolve, 1));
  r2.holdGets = false;
  await voices.unkeep("msg-1");
  r2.release();
  assert.equal((await playing).bytes[99], 8);
});

await test("letting go and keeping again on one isolate take turns: the last asked wins and the audio stays", async () => {
  const m = store();
  const r2 = bucket();
  const voices = new kept.KeptVoices(m, r2, "default");
  const key = putVoice(m, 100, 4);
  await voices.keep(voiceOf("msg-1", [key]));
  const [gone, back] = await Promise.all([voices.unkeep("msg-1"), voices.keep(voiceOf("msg-1", [key]))]);
  assert.deepEqual([gone, back], [{ ok: true }, true]);
  assert.ok(m.kept("msg-1"));
  assert.equal(r2.objects.size, 1);
  assert.equal((await voices.file(key)).bytes[0], 4);
});

await test("let go and kept again, a voice keeps the precious memory it went into, and is kept anew", async () => {
  const m = store();
  const voices = new kept.KeptVoices(m, null, "default");
  const key = putVoice(m, 100);
  await voices.keep(voiceOf("msg-1", [key]));
  m.keptInMemory("msg-1", "p1");
  const keptAt = m.kept("msg-1").keptAt;
  await voices.unkeep("msg-1");
  assert.equal(m.kept("msg-1"), null);
  assert.deepEqual(m.keptVoices(), []);
  assert.deepEqual([...m.keptAmong(["msg-1"])], []);
  await new Promise((resolve) => setTimeout(resolve, 2));
  await voices.keep(voiceOf("msg-1", [key]));
  assert.equal(m.kept("msg-1").memory, "p1", "so it is not written into Aelios again");
  assert.ok(m.kept("msg-1").keptAt > keptAt);
  // Pruned once let go, its row goes with its audio.
  await voices.unkeep("msg-1");
  m.remove(key);
  await voices.keep(voiceOf("msg-1", [key]));
  assert.equal(m.kept("msg-1"), null);
});

await test("a deleted resident's kept voices leave the bucket, and only its own", async () => {
  const r2 = bucket();
  for (const resident of ["second", "third"]) {
    const m = store();
    await new kept.KeptVoices(m, r2, resident).keep(voiceOf("msg", [putVoice(m, 10)]));
  }
  await new kept.KeptVoices(store(), r2, "second").forgetAll();
  assert.deepEqual([...r2.objects.keys()].map((key) => key.split("/")[1]), ["third"]);
});

await test("played while let go and kept again at once: the copy read moved meanwhile, so it is read where it is now", async () => {
  const m = store();
  const r2 = bucket();
  const voices = new kept.KeptVoices(m, r2, "default");
  const key = putVoice(m, 100, 2);
  await voices.keep(voiceOf("msg-1", [key]));
  const first = m.awayTo(key);
  r2.holdGets = true;
  const playing = voices.file(key);
  while (!r2.held.length) await new Promise((resolve) => setTimeout(resolve, 1));
  r2.holdGets = false;
  await voices.unkeep("msg-1");
  await voices.keep(voiceOf("msg-1", [key]));
  assert.notEqual(m.awayTo(key), first, "under a new name now, and not in SQLite");
  assert.equal(m.get(key), null);
  r2.release();
  assert.equal((await playing).bytes[99], 2);
});

await test("a delete in R2 that failed is tried again on the usual ways too: another keep, a let-go asked again, the list looked at", async () => {
  const m = store();
  const r2 = bucket({ failDeletes: 1 });
  const voices = new kept.KeptVoices(m, r2, "default");
  const key = putVoice(m, 100);
  await voices.keep(voiceOf("msg-1", [key]));
  await voices.unkeep("msg-1");
  assert.equal(m.toClear().length, 1, "failed once");
  // Kept again (or any other voice kept): the old copy goes.
  assert.equal(await voices.keep(voiceOf("msg-2", [putVoice(m, 100)])), true);
  assert.deepEqual(m.toClear(), []);
  assert.equal(r2.objects.size, 1, "only the copy kept now is left");
  // Let go again when it already is: what failed to clear before goes then.
  r2.failDeletes = 1;
  await voices.unkeep("msg-2");
  assert.equal(m.toClear().length, 1);
  assert.deepEqual(await voices.unkeep("msg-2"), { ok: true });
  assert.deepEqual([m.toClear(), r2.objects.size], [[], 0]);
  // And a keep stands even when that clearing fails again.
  r2.failDeletes = 2;
  m.copying("voices/default/stuck");
  r2.objects.set("voices/default/stuck", { bytes: new Uint8Array(1) });
  assert.equal(await voices.keep(voiceOf("msg-3", [putVoice(m, 100)])), true);
  assert.ok(m.kept("msg-3"));
  assert.deepEqual(m.toClear(), ["voices/default/stuck"]);
});
