// Pure synchronous tagged SQL on real Node SQLite, including close/reopen.
// Usage (Node 22+): node test/letter-state.mjs
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../src/letter-state.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "error",
});
const { LetterStateStore } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`
);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "resident-letter-state-"));
  const path = join(dir, "letters.sqlite");
  let db;
  let store;
  const sql = (strings, ...values) => {
    const statement = db.prepare(strings.join("?"));
    // UPDATE ... RETURNING is also a row-producing statement.
    if (statement.columns().length) return statement.all(...values);
    statement.run(...values);
    return [];
  };
  const reopen = () => {
    db?.close();
    db = new DatabaseSync(path);
    store = new LetterStateStore(sql);
    return store;
  };
  t.after(() => {
    try { db?.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  reopen();
  return { get store() { return store; }, get db() { return db; }, sql, reopen };
}

const target = { url: "https://memory.example.test", namespace: "resident-test" };
const letter = (id = "letter-1", at = 100, dest = target) => ({
  id, at, text: `私密正文 '${id}' ? 中文\n第二行`, target: { ...dest },
});
const expected = (input) => ({
  id: input.id, at: input.at, text: input.text, ...input.target,
  attempts: 0, status: "pending", nextAt: input.at, lastError: null, sentAt: null,
});

// Exhaust by expired leases, without inventing attempt counts through SQL.
function exhaust(store, id, start) {
  let now = start;
  for (let n = 1; n <= 6; n++) {
    assert.equal(store.claim(id, now)?.attempts, n);
    now += 60_000;
  }
  assert.equal(store.claim(id, now), null);
  assert.equal(store.get(id).status, "failed");
  return now;
}

test("empty database and missing ids return null/zero, with synchronous void writes", (t) => {
  const { store } = fixture(t);
  assert.equal(store.get("missing"), null);
  assert.equal(store.due(1_000_000), null);
  assert.equal(store.nextAt(), null);
  assert.equal(store.readWrite(), null);
  assert.deepEqual(store.summary(), { pending: 0, failed: 0, blocked: 0, latest: null });
  assert.equal(store.claim("missing", 100), null);
  assert.equal(store.accepted("missing", 100), undefined);
  assert.equal(store.attemptFailed("missing", "网络错误", 100), undefined);
  assert.equal(store.block("missing", "目标未配置"), undefined);
  assert.equal(store.retry(100), undefined);
  assert.equal(store.resumeBlocked(target, 100), undefined);
  assert.equal(store.write({ state: "empty", at: 100 }), undefined);
});

test("enqueue is INSERT OR IGNORE: payload, target, timestamp and progress never get replaced", (t) => {
  const f = fixture(t);
  const input = letter("id' ? --");
  assert.equal(f.store.enqueue(input), undefined);
  assert.deepEqual(f.store.get(input.id), expected(input));
  const duplicate = { ...letter(input.id, 999, { url: "https://other.example.test", namespace: "other" }), text: "替换正文" };
  const unchanged = () => {
    const before = f.store.get(input.id);
    f.store.enqueue(duplicate);
    assert.deepEqual(f.store.get(input.id), before);
  };
  unchanged();
  f.store.claim(input.id, 100);
  unchanged();
  f.store.block(input.id, "目标未配置");
  unchanged();
  f.store.retry(200);
  exhaust(f.store, input.id, 200);
  unchanged();
  f.store.accepted(input.id, 999_999);
  unchanged();
  const before = f.store.get(input.id);
  f.reopen();
  unchanged();
  assert.deepEqual(f.store.get(input.id), before);
  assert.equal(before.text, input.text);
  assert.equal(before.url, target.url);
});

test("due orders eligible pending letters by at then id, nextAt is the earliest schedule", (t) => {
  const { store } = fixture(t);
  for (const input of [letter("b", 100), letter("a", 100), letter("old", 50), letter("future", 200)]) store.enqueue(input);
  assert.equal(store.nextAt(), 50);
  assert.equal(store.due(49), null);
  assert.equal(store.due(100).id, "old");
  store.claim("old", 100);
  assert.equal(store.nextAt(), 100);
  assert.equal(store.due(100).id, "a");
  store.block("a", "目标已变更");
  assert.equal(store.due(100).id, "b");
  store.accepted("b", 101);
  assert.equal(store.due(199), null);
  assert.equal(store.due(200).id, "future");
  // The old letter has the latest nextAt, but must be selected first when due.
  assert.equal(store.due(60_100).id, "old");
  assert.equal(store.nextAt(), 200);
});

test("claim enforces due time and a persisted 60-second crash lease", (t) => {
  const f = fixture(t);
  const input = letter();
  f.store.enqueue(input);
  assert.equal(f.store.claim(input.id, 99), null);
  assert.deepEqual(f.store.get(input.id), expected(input));
  const claimed = f.store.claim(input.id, 100);
  assert.deepEqual(claimed, { ...expected(input), attempts: 1, nextAt: 60_100 });
  assert.equal(f.store.claim(input.id, 100), null);
  const peer = new LetterStateStore(f.sql);
  assert.equal(peer.claim(input.id, 60_099), null, "another store cannot claim the active lease");
  f.reopen();
  assert.deepEqual(f.store.get(input.id), claimed);
  assert.equal(f.store.due(60_099), null);
  assert.equal(f.store.nextAt(), 60_100);
  assert.equal(f.store.claim(input.id, 60_100).attempts, 2);
  assert.equal(f.store.get(input.id).nextAt, 120_100);
});

test("six claimed failures use all five backoffs and keep the failed letter across reopen", (t) => {
  const f = fixture(t);
  const input = letter();
  f.store.enqueue(input);
  let now = 100;
  const delays = [30_000, 120_000, 600_000, 1_800_000, 7_200_000];
  for (let attempt = 1; attempt <= 6; attempt++) {
    const claimed = f.store.claim(input.id, now);
    assert.equal(claimed.attempts, attempt);
    assert.equal(claimed.nextAt, now + 60_000);
    const failedAt = now + 7; // Backoff starts at failure, not claim.
    assert.equal(f.store.attemptFailed(input.id, `网络错误 ${attempt}`, failedAt), undefined);
    const row = f.store.get(input.id);
    assert.equal(row.attempts, attempt);
    assert.equal(row.text, input.text);
    assert.equal(row.url, target.url);
    assert.equal(row.namespace, target.namespace);
    assert.equal(row.lastError, `网络错误 ${attempt}`);
    assert.equal(row.sentAt, null);
    if (attempt < 6) {
      now = failedAt + delays[attempt - 1];
      assert.equal(row.status, "pending");
      assert.equal(row.nextAt, now);
      assert.equal(f.store.due(now - 1), null);
      assert.equal(f.store.claim(input.id, now - 1), null);
      assert.equal(f.store.due(now).id, input.id);
    } else {
      assert.equal(row.status, "failed");
      assert.equal(row.nextAt, null);
      assert.equal(f.store.nextAt(), null);
      assert.equal(f.store.due(Number.MAX_SAFE_INTEGER), null);
      assert.equal(f.store.claim(input.id, Number.MAX_SAFE_INTEGER), null);
    }
    f.reopen();
    assert.deepEqual(f.store.get(input.id), row);
  }
});

test("a sixth crash lease is honored, then fails in Chinese without a seventh attempt", (t) => {
  const f = fixture(t);
  f.store.enqueue(letter());
  for (let n = 1; n <= 6; n++) assert.equal(f.store.claim("letter-1", 100 + (n - 1) * 60_000).attempts, n);
  f.reopen();
  assert.equal(f.store.claim("letter-1", 360_099), null);
  assert.equal(f.store.get("letter-1").status, "pending");
  assert.equal(f.store.claim("letter-1", 360_100), null);
  const row = f.store.get("letter-1");
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 6);
  assert.equal(row.nextAt, null);
  assert.match(row.lastError, /次数.*耗尽/);
  assert.equal(row.text, letter().text);
  assert.equal(f.store.nextAt(), null);
  f.reopen();
  assert.deepEqual(f.store.get("letter-1"), row);
});

test("accepted clears schedule/error, persists sentAt and cannot be regressed by failure or block", (t) => {
  const f = fixture(t);
  f.store.enqueue(letter());
  f.store.claim("letter-1", 100);
  f.store.attemptFailed("letter-1", "暂时断网", 110);
  assert.equal(f.store.accepted("letter-1", 120), undefined);
  const sent = { ...expected(letter()), attempts: 1, status: "sent", nextAt: null, sentAt: 120 };
  assert.deepEqual(f.store.get("letter-1"), sent);
  f.store.accepted("letter-1", 130);
  f.store.attemptFailed("letter-1", "迟到的错误", 140);
  f.store.block("letter-1", "迟到的配置检查");
  f.store.retry(150);
  f.store.resumeBlocked(target, 160);
  assert.equal(f.store.claim("letter-1", 999_999), null);
  assert.equal(f.store.nextAt(), null);
  f.reopen();
  assert.deepEqual(f.store.get("letter-1"), sent);
});

test("blocking pauses deliveries; automatic resume requires exact URL AND namespace", (t) => {
  const f = fixture(t);
  const destinations = [target, target, { ...target, url: `${target.url}/other` }, { ...target, namespace: "other" }];
  for (let n = 0; n < destinations.length; n++) {
    f.store.enqueue(letter(`blocked-${n}`, 100, destinations[n]));
    if (n === 0) f.store.claim(`blocked-${n}`, 100);
    assert.equal(f.store.block(`blocked-${n}`, "目标或授权已改变"), undefined);
    assert.equal(f.store.get(`blocked-${n}`).nextAt, null);
  }
  f.store.enqueue(letter("pending", 500));
  f.store.enqueue(letter("failed"));
  exhaust(f.store, "failed", 100);
  f.store.enqueue(letter("sent"));
  f.store.accepted("sent", 200);
  const untouched = ["blocked-2", "blocked-3", "pending", "failed", "sent"].map((id) => f.store.get(id));
  f.reopen();
  f.store.resumeBlocked({ ...target, url: `${target.url}/` }, 300);
  assert.equal(f.store.get("blocked-0").status, "blocked", "no URL normalization or retargeting");
  assert.equal(f.store.resumeBlocked(target, 300), undefined);
  for (const id of ["blocked-0", "blocked-1"]) {
    const row = f.store.get(id);
    assert.equal(row.status, "pending");
    assert.equal(row.nextAt, 300);
    assert.equal(row.lastError, null);
    assert.equal(row.attempts, id === "blocked-0" ? 1 : 0);
    assert.equal(row.text, letter(id).text);
    assert.equal(row.url, target.url);
    assert.equal(row.namespace, target.namespace);
  }
  for (const row of untouched) assert.deepEqual(f.store.get(row.id), row);
  assert.equal(f.store.claim("blocked-0", 299), null);
  assert.equal(f.store.claim("blocked-0", 300).attempts, 2);
});

test("automatic resume does not bypass the six-attempt budget", (t) => {
  const { store } = fixture(t);
  store.enqueue(letter());
  for (let n = 1; n <= 6; n++) store.claim("letter-1", 100 + (n - 1) * 60_000);
  store.block("letter-1", "授权缺失");
  store.resumeBlocked(target, 400_000);
  assert.equal(store.claim("letter-1", 400_000), null);
  assert.equal(store.get("letter-1").status, "failed");
  assert.equal(store.get("letter-1").attempts, 6);
});

test("explicit retry resets every failed/blocked row but leaves pending leases and sent rows alone", (t) => {
  const f = fixture(t);
  for (const id of ["failed", "blocked", "blocked-other", "pending", "sent"]) {
    f.store.enqueue(letter(id, 100, id === "blocked-other" ? { ...target, namespace: "other" } : target));
  }
  exhaust(f.store, "failed", 100);
  f.store.claim("blocked", 100);
  f.store.block("blocked", "授权缺失");
  f.store.block("blocked-other", "目标不同");
  f.store.claim("pending", 100);
  f.store.accepted("sent", 200);
  const untouched = ["pending", "sent"].map((id) => f.store.get(id));
  f.reopen();
  assert.equal(f.store.retry(900_000), undefined);
  for (const id of ["failed", "blocked", "blocked-other"]) {
    const row = f.store.get(id);
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 0);
    assert.equal(row.nextAt, 900_000);
    assert.equal(row.lastError, null);
    assert.equal(row.sentAt, null);
    assert.equal(row.text, letter(id).text);
    if (id === "blocked-other") assert.equal(row.namespace, "other");
  }
  for (const row of untouched) assert.deepEqual(f.store.get(row.id), row);
  f.reopen();
  assert.equal(f.store.claim("failed", 900_000).attempts, 1);
  assert.equal(f.store.claim("blocked", 900_000).attempts, 1);
});

test("summary selects only counts and latest metadata, with no private body or target", (t) => {
  const { store } = fixture(t);
  const privateTarget = { url: "https://private.example.test/secret-path", namespace: "private-namespace" };
  for (const [id, at] of [["failed", 10], ["blocked", 20], ["pending", 30], ["latest-a", 40], ["latest-b", 40]]) {
    store.enqueue({ ...letter(id, at, privateTarget), text: "PRIVATE-LETTER-BODY" });
  }
  exhaust(store, "failed", 10);
  store.block("blocked", "授权缺失");
  store.claim("latest-b", 40);
  store.attemptFailed("latest-b", "网络错误", 50);
  assert.deepEqual(store.summary(), {
    pending: 3, failed: 1, blocked: 1,
    latest: { id: "latest-b", at: 40, status: "pending", attempts: 1, lastError: "网络错误", sentAt: null },
  });
  store.accepted("latest-b", 60);
  const summary = store.summary();
  assert.deepEqual(summary, {
    pending: 2, failed: 1, blocked: 1,
    latest: { id: "latest-b", at: 40, status: "sent", attempts: 1, lastError: null, sentAt: 60 },
  });
  const serialized = JSON.stringify(summary);
  for (const secret of ["PRIVATE-LETTER-BODY", privateTarget.url, privateTarget.namespace, '"text"', '"url"', '"namespace"', '"target"']) {
    assert.ok(!serialized.includes(secret), `must not expose ${secret}`);
  }
});

test("write state is a single durable row for every state; absent and empty errors round-trip", (t) => {
  const f = fixture(t);
  const states = [
    { state: "writing", at: 100 },
    { state: "recovering", at: 200 },
    { state: "failed", at: 300, error: "本地保存失败 ' ?" },
    { state: "written", at: 400 },
    { state: "empty", at: 500, error: "" },
  ];
  for (const state of states) {
    const original = { ...state };
    assert.equal(f.store.write(state), undefined);
    assert.deepEqual(state, original, "caller state is not mutated");
    assert.deepEqual(f.store.readWrite(), state);
    f.reopen();
    assert.deepEqual(f.store.readWrite(), state);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM res_letter_write_state").get().n, 1);
  }
});

test("caller transaction can atomically commit or roll back local letter storage plus enqueue", (t) => {
  const f = fixture(t);
  f.db.exec("CREATE TABLE local_letters (id TEXT PRIMARY KEY, text TEXT NOT NULL)");
  const transactionSync = (fn) => {
    f.db.exec("BEGIN");
    try {
      const value = fn();
      f.db.exec("COMMIT");
      return value;
    } catch (error) {
      f.db.exec("ROLLBACK");
      throw error;
    }
  };
  const save = () => {
    const input = letter();
    f.db.prepare("INSERT INTO local_letters VALUES (?, ?)").run(input.id, input.text);
    f.store.enqueue(input);
    f.store.write({ state: "written", at: input.at });
  };
  assert.throws(() => transactionSync(() => { save(); throw new Error("模拟写信中断"); }), /模拟写信中断/);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM local_letters").get().n, 0);
  assert.equal(f.store.get("letter-1"), null);
  assert.equal(f.store.readWrite(), null);
  transactionSync(save);
  f.reopen();
  assert.equal(f.db.prepare("SELECT text FROM local_letters").get().text, letter().text);
  assert.deepEqual(f.store.get("letter-1"), expected(letter()));
  assert.deepEqual(f.store.readWrite(), { state: "written", at: 100 });
});

test("SQL failures propagate rather than reporting delivery/write success", () => {
  const error = new Error("数据库不可写");
  let fail = false;
  const sql = () => { if (fail) throw error; return []; };
  const store = new LetterStateStore(sql);
  fail = true;
  for (const call of [
    () => store.enqueue(letter()), () => store.get("id"), () => store.due(100),
    () => store.claim("id", 100), () => store.accepted("id", 100),
    () => store.attemptFailed("id", "错误", 100), () => store.block("id", "错误"),
    () => store.retry(100), () => store.resumeBlocked(target, 100),
    () => store.nextAt(), () => store.summary(),
    () => store.write({ state: "failed", at: 100 }), () => store.readWrite(),
  ]) assert.throws(call, (caught) => caught === error);
});
