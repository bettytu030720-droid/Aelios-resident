// Real agents/sessions overlays on Node SQLite. No Worker, model, or network.
// Usage (Node 22+): node test/letter-recovery.mjs
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Sessions } from "agents/sessions";

// Compile in memory: this test creates no generated files in the repository.
const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../src/letter-recovery.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "error",
});
const { resumeLetterCompaction } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`
);

/**
 * Adapt only the DO lifecycle/storage boundary. All session operations,
 * schema creation, branch selection, and overlay planning are the real SDK.
 */
async function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const kv = new Map();
  let transactionId = 0;
  const storage = {
    get: async (key) => kv.get(key),
    put: async (key, value) => { kv.set(key, value); },
    sql: {
      exec(query, ...params) {
        const statement = db.prepare(query);
        if (statement.columns().length) return Object.assign(statement.all(...params), { rowsWritten: 0 });
        const { changes } = statement.run(...params);
        return Object.assign([], { rowsWritten: Number(changes) });
      },
    },
    transactionSync(fn) {
      const name = `test_${transactionId++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
        throw error;
      }
    },
  };
  async function open() {
    const sessions = new Sessions();
    // Node has no DurableObject runtime. Supply its boundary without replacing
    // getHistory/getCompactions/addCompaction or reaching into SDK internals.
    Object.defineProperty(sessions, "lifecycle", {
      value: { storage, ready: async () => {}, events: { emit() {} } },
    });
    await sessions.onStart();
    return sessions;
  }
  return { sessions: await open(), open };
}

const message = (id, role = "user") => ({ id, role, parts: [{ type: "text", text: `text:${id}` }] });
async function seed(session) {
  for (let i = 0; i < 10; i++) await session.appendMessage(message(`m${i}`, i % 2 ? "assistant" : "user"));
}
const first = { summary: "第一封信", fromMessageId: "m3", toMessageId: "m4" };
const second = { summary: "第二封信", fromMessageId: "m5", toMessageId: "m6" };
const third = { summary: "第三封信", fromMessageId: "m7", toMessageId: "m8" };
const ids = (history) => history.map((m) => m.id.startsWith("compaction_") ? "<letter>" : m.id);
const letters = (history) => history.filter((m) => m.id.startsWith("compaction_")).map((m) => m.parts[0].text);
const comparable = (history) => history.map((m) => ({
  id: m.id.startsWith("compaction_") ? "<letter>" : m.id,
  role: m.role,
  parts: m.parts,
}));
const adapter = (session) => ({
  getHistory: () => session.getHistory(),
  getCompactions: () => session.getCompactions(),
  addCompaction: (...args) => session.addCompaction(...args),
});

// A passing control that proves the SDK reproduces the original bug.
test("old direct-add recovery leaves both letters in actual history", async (t) => {
  const { sessions } = await fixture(t);
  const session = sessions.session();
  await seed(session);
  await session.addCompaction(first.summary, first.fromMessageId, first.toMessageId);
  await session.addCompaction(second.summary, second.fromMessageId, second.toMessageId);
  const history = await session.getHistory();
  assert.deepEqual(letters(history), [first.summary, second.summary]);
  assert.deepEqual(ids(history), ["m0", "m1", "m2", "<letter>", "<letter>", "m7", "m8", "m9"]);
});

test("first recovery preserves the head and tail and stores the job's exact range", async (t) => {
  const { sessions } = await fixture(t);
  const session = sessions.session();
  await seed(session);
  assert.equal(await resumeLetterCompaction(session, first), undefined);
  const [stored] = await session.getCompactions();
  assert.equal(stored.fromMessageId, first.fromMessageId);
  assert.equal(stored.toMessageId, first.toMessageId);
  assert.equal(stored.summary, first.summary);
  const history = await session.getHistory();
  assert.deepEqual(letters(history), [first.summary]);
  assert.deepEqual(ids(history), ["m0", "m1", "m2", "<letter>", "m5", "m6", "m7", "m8", "m9"]);
  assert.equal((await session.getMessage("m3")).parts[0].text, "text:m3", "compaction is an overlay, not deletion");
});

test("second and third recoveries replace old letters and match ordinary SDK compact", async (t) => {
  const { sessions } = await fixture(t);
  const resumed = sessions.session("resumed");
  const ordinary = sessions.session("ordinary");
  await seed(resumed);
  await seed(ordinary);
  for (const job of [first, second, third]) {
    const saved = { ...job };
    await resumeLetterCompaction(resumed, job);
    assert.deepEqual(job, saved, "the saved job is not mutated");
    ordinary.onCompaction(async () => job);
    const compacted = await ordinary.compact();
    assert.equal(compacted.fromMessageId, "m3");
    assert.deepEqual(comparable(await resumed.getHistory()), comparable(await ordinary.getHistory()));
    assert.deepEqual(letters(await resumed.getHistory()), [job.summary]);
    assert.equal((await resumed.getCompactions()).at(-1).fromMessageId, "m3");
  }
  assert.deepEqual(ids(await resumed.getHistory()), ["m0", "m1", "m2", "<letter>", "m9"]);
  assert.equal((await resumed.getCompactions()).length, 3);
});

test("a new full-range letter folds the first messages that older deployments kept forever", async (t) => {
  const { sessions } = await fixture(t);
  const session = sessions.session();
  await seed(session);
  await session.addCompaction(first.summary, first.fromMessageId, first.toMessageId);
  const full = { ...second, fromMessageId: "m0" };
  await resumeLetterCompaction(session, full);
  assert.deepEqual(ids(await session.getHistory()), ["<letter>", "m7", "m8", "m9"]);
  assert.equal((await session.getCompactions()).at(-1).fromMessageId, "m0");
});

test("a normal SDK compaction's legacy head is repaired and subsequent retries are idempotent", async (t) => {
  const { sessions } = await fixture(t);
  const session = sessions.session();
  await seed(session);
  await session.addCompaction(first.summary, first.fromMessageId, first.toMessageId);
  const full = { ...second, fromMessageId: "m0" };
  session.onCompaction(async () => full);
  assert.equal((await session.compact()).fromMessageId, "m3", "SDK otherwise retains the old start");
  await resumeLetterCompaction(session, full);
  const records = await session.getCompactions();
  assert.deepEqual(ids(await session.getHistory()), ["<letter>", "m7", "m8", "m9"]);
  assert.equal(records.at(-1).fromMessageId, "m0");
  await resumeLetterCompaction(session, full);
  assert.deepEqual(await session.getCompactions(), records);
});

for (const ordinaryFirst of [false, true]) {
  test(`legacy head alone lies before the old letter: extend both endpoints (${ordinaryFirst ? "normal" : "recovered"})`, async (t) => {
    const { sessions, open } = await fixture(t);
    const session = sessions.session();
    await seed(session);
    await session.addCompaction(first.summary, first.fromMessageId, first.toMessageId);
    // Only the former permanent head is being folded; the latest whole exchange stays as it is.
    const headOnly = { summary: "新信含旧信", fromMessageId: "m0", toMessageId: "m2" };
    if (ordinaryFirst) {
      session.onCompaction(async () => headOnly);
      await session.compact();
    }
    await resumeLetterCompaction(session, headOnly);
    assert.deepEqual(letters(await session.getHistory()), [headOnly.summary]);
    assert.deepEqual(ids(await session.getHistory()), ["<letter>", "m5", "m6", "m7", "m8", "m9"]);
    const records = await session.getCompactions();
    assert.equal(records.at(-1).fromMessageId, "m0");
    assert.equal(records.at(-1).toMessageId, "m4");
    const reopened = (await open()).session();
    await resumeLetterCompaction(reopened, headOnly);
    assert.deepEqual(await reopened.getCompactions(), records, "retry recognizes the extended end");
    assert.deepEqual(letters(await reopened.getHistory()), [headOnly.summary]);
  });
}

test("same summary/to is idempotent even after reopening and with a different saved from", async (t) => {
  const { sessions, open } = await fixture(t);
  const session = sessions.session();
  await seed(session);
  await resumeLetterCompaction(session, first);
  await resumeLetterCompaction(session, second);
  const records = await session.getCompactions();
  const history = await session.getHistory();
  const reopened = (await open()).session();
  await resumeLetterCompaction(reopened, { ...second, fromMessageId: "m3" });
  await resumeLetterCompaction(reopened, second);
  assert.deepEqual(await reopened.getCompactions(), records);
  // SDK synthesizes overlay createdAt on each read; compare durable identity
  // and content, not that transient timestamp.
  const withoutReadTime = (items) => items.map(({ createdAt, ...message }) => message);
  assert.deepEqual(withoutReadTime(await reopened.getHistory()), withoutReadTime(history));
});

test("idempotency requires both summary and to, not either alone", async (t) => {
  const { sessions } = await fixture(t);
  const session = sessions.session();
  await seed(session);
  await resumeLetterCompaction(session, first);
  const revised = { ...first, summary: "修订信" };
  await resumeLetterCompaction(session, revised);
  assert.deepEqual(letters(await session.getHistory()), [revised.summary]);
  const extended = { ...second, summary: revised.summary };
  await resumeLetterCompaction(session, extended);
  assert.equal((await session.getCompactions()).length, 3);
  assert.deepEqual(ids(await session.getHistory()), ["m0", "m1", "m2", "<letter>", "m7", "m8", "m9"]);
});

test("inactive branch compactions do not supply the start, even with one endpoint on the active path", async (t) => {
  const { sessions } = await fixture(t);
  const session = sessions.session();
  await seed(session);
  await session.appendMessage(message("fork"), { parentId: "m3" });
  await session.addCompaction("另一支的信", "m3", "fork");
  await session.appendMessage(message("m10"), { parentId: "m9" });
  await resumeLetterCompaction(session, second);
  assert.equal((await session.getCompactions()).at(-1).fromMessageId, "m5");
  assert.deepEqual(ids(await session.getHistory()), ["m0", "m1", "m2", "m3", "m4", "<letter>", "m7", "m8", "m9", "m10"]);

  await resumeLetterCompaction(session, third);
  assert.equal((await session.getCompactions()).at(-1).fromMessageId, "m5", "skip earlier inactive record in SDK order");
  assert.deepEqual(letters(await session.getHistory()), [third.summary]);
});

test("both-endpoints fallback matches SDK even when a stored range has no visible overlay", async (t) => {
  const { sessions } = await fixture(t);
  const resumed = sessions.session("resumed");
  const ordinary = sessions.session("ordinary");
  for (const session of [resumed, ordinary]) {
    await seed(session);
    // addCompaction permits a reversed span; it produces no overlay, so both
    // endpoints are still in history. Exercise the second SDK filter arm.
    await session.addCompaction("non-overlay range", "m4", "m3");
    assert.deepEqual(letters(await session.getHistory()), []);
  }
  await resumeLetterCompaction(resumed, second);
  ordinary.onCompaction(async () => second);
  assert.equal((await ordinary.compact()).fromMessageId, "m4");
  assert.equal((await resumed.getCompactions()).at(-1).fromMessageId, "m4");
  assert.deepEqual(comparable(await resumed.getHistory()), comparable(await ordinary.getHistory()));
});

for (const operation of ["getCompactions", "getHistory", "addCompaction"]) {
  test(`${operation} errors propagate unchanged and leave recovery retryable`, async (t) => {
    const { sessions } = await fixture(t);
    const session = sessions.session();
    await seed(session);
    const before = await session.getHistory();
    const failure = new Error(`failed ${operation}`);
    const failing = { ...adapter(session), [operation]: async () => { throw failure; } };
    await assert.rejects(resumeLetterCompaction(failing, first), (error) => error === failure);
    assert.deepEqual(await session.getCompactions(), []);
    assert.deepEqual(await session.getHistory(), before);
    await resumeLetterCompaction(session, first);
    assert.deepEqual(letters(await session.getHistory()), [first.summary]);
  });
}

test("a failure after the durable write propagates; retry does not duplicate the letter", async (t) => {
  const { sessions, open } = await fixture(t);
  const session = sessions.session();
  await seed(session);
  await resumeLetterCompaction(session, first);
  const failure = new Error("interrupted after commit");
  await assert.rejects(resumeLetterCompaction({
    ...adapter(session),
    async addCompaction(...args) {
      await session.addCompaction(...args);
      throw failure;
    },
  }, second), (error) => error === failure);
  const records = await session.getCompactions();
  assert.equal(records.length, 2);
  const reopened = (await open()).session();
  await resumeLetterCompaction(reopened, second);
  assert.deepEqual(await reopened.getCompactions(), records);
  assert.deepEqual(letters(await reopened.getHistory()), [second.summary]);
});
