// Real agents/sessions + Node SQLite, actual Resident recovery/admission hooks.
// Node 22+: node test/letter-recovery-budget.mjs. No Worker/network/model.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Sessions } from "agents/sessions";

const root = fileURLToPath(new URL("../", import.meta.url));
const msg = (id, role = "user", text = `text:${id}`) => ({ id, role, parts: [{ type: "text", text }] });
const ids = (messages) => messages.map(({ id }) => id);
const errorCode = (code) => (error) => error.code === code;
const B = 128 * 1024;

async function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const kv = new Map();
  const state = { forbidPayloads: false, payloads: [], deletions: [], messageReads: [] };
  let transactionId = 0;
  const storage = {
    get: async (key) => kv.get(key),
    put: async (key, value) => { kv.set(key, value); },
    sql: {
      exec(query, ...params) {
        // Stats compute LENGTH(content) inside WITH RECURSIVE, not a payload
        // SELECT. Deletion's attachment hash/ref metadata is allowed, data not.
        if (/^\s*SELECT/.test(query) && /\b(content|data)\b/.test(query)) {
          state.payloads.push(query);
          if (state.forbidPayloads) throw new Error("Unexpected body/attachment hydration");
        }
        const statement = db.prepare(query);
        const bindings = params.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
        return statement.columns().length
          ? Object.assign(statement.all(...bindings), { rowsWritten: 0 })
          : Object.assign([], { rowsWritten: Number(statement.run(...bindings).changes) });
      },
    },
    transactionSync(fn) {
      const name = `test_${transactionId++}`;
      db.exec(`SAVEPOINT ${name}`);
      try { const result = fn(); db.exec(`RELEASE ${name}`); return result; }
      catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
    },
  };
  const sql = (strings, ...values) => {
    const statement = db.prepare(strings.join("?"));
    return statement.columns().length ? statement.all(...values) : (statement.run(...values), []);
  };
  async function open(id = "default") {
    const sessions = new Sessions();
    Object.defineProperty(sessions, "lifecycle", {
      value: { storage, ready: async () => {}, events: { emit() {} } },
    });
    await sessions.onStart();
    const session = sessions.session(id);
    const getMessage = session.getMessage.bind(session);
    const deleteMessages = session.deleteMessages.bind(session);
    session.getMessage = async (id) => { state.messageReads.push(id); return getMessage(id); };
    session.deleteMessages = async (ids) => { state.deletions.push(ids); return deleteMessages(ids); };
    session.getLatestLeaf = async () => { throw new Error("Must select the leaf by metadata, not hydration"); };
    return session;
  }
  const session = await open();
  const resident = new ResidentHarness(session, sql, B, storage);
  return { db, storage, state, session, resident, open, sql,
    rawIds: () => db.prepare("SELECT id FROM cf_agents_session_messages WHERE session_id = ? ORDER BY seq").all(session.sessionId).map(({ id }) => id),
    forbid() { state.payloads.length = 0; state.messageReads.length = 0; state.forbidPayloads = true; },
  };
}

async function seed(session) {
  for (let i = 0; i < 4; i++) await session.appendMessage(msg(`m${i}`, i % 2 ? "assistant" : "user"));
}
function job(summary = null, createdAt = Date.now() - 11 * 60_000) {
  return { promptId: "letter_prompt", reason: "handoff", fromMessageId: "m0", toMessageId: "m1", summary, createdAt };
}
async function auxiliary(session, text = "saved answer") {
  await session.appendMessage(msg("letter_prompt", "user", LETTER_PREFIX));
  await session.appendMessage(msg("letter_answer", "assistant", text));
}
async function oversizedTail(session) {
  await session.appendMessage(msg("new_user", "user", "x".repeat(B * 2)));
  await session.appendMessage(msg("new_reply", "assistant", "original reply"));
}
const turn = (messages) => ({ messages, tools: {}, system: "synthetic" });

// Read the CURRENT complete methods at test startup, after the parent has wired
// the final Resident glue. Do not freeze earlier method copies into this test.
const source = readFileSync(new URL("../src/resident.ts", import.meta.url), "utf8");
function method(name) {
  const match = source.match(new RegExp(`^  (?:private |override )*(?:async )?${name}\\([^\\n]*[\\s\\S]*?^  \\}`, "m"));
  assert.ok(match, `cannot extract actual Resident ${name}`);
  return match[0].replace("override ", "");
}
const compiled = await build({
  stdin: { contents: `
    import { AsyncLocalStorage } from 'node:async_hooks';
    import { installEffectiveHistory } from './src/effective-history.ts';
    import { historyPathComplete } from './src/history-path.ts';
    import { readAuxiliaryAnswer, removeAuxiliaryTurn } from './src/letter-auxiliary.ts';
    import { resumeLetterCompaction } from './src/letter-recovery.ts';
    import { LetterStateStore } from './src/letter-state.ts';
    import { LETTER_PREFIX, isNote, letterPrompt, stamp } from './src/prompts.ts';
    import { markedForLetter } from './src/cache-window.ts';
    export { LETTER_PREFIX, installEffectiveHistory, readAuxiliaryAnswer, removeAuxiliaryTurn };
    const promptCache = () => ({});
    class WebDraft { constructor(..._args) {} }
    export class ResidentHarness {
      #letterState = null;
      #letterPromptId = null;
      #letterReason = 'handoff';
      #letterAttempted = false;
      #theirTurns = new Set(); #readOutside = new Set(); #drafts = new Map();
      #spoke = null; #draftActive = null; #outbox = new Map();
      #turnThread = new Map(); #stickerSent = new Set(); #turnTasks = new Map();
      effectiveHistories = new WeakMap();
      cfg = {}; tz = 'UTC'; liveUser = null;
      constructor(public session, public sql, public hydrationByteBudget, storage) { this.ctx = { storage }; }
      restoreTurn() {} markTurn() {} async stopHeartbeats() {}
      userMessageBefore() { return this.liveUser; }
      windowHistory(messages) { return messages; }
      async boot() { return ''; } getTools() { return {}; } letterCache() { return null; }
      async schedule() { throw new Error('Unexpected recovery poll'); }
      async saveMessages() { throw new Error('Model must not run'); }
      ${["historyControl", "letterState", "letterJob", "saveLetterJob", "deleteLetterJob", "failLetter", "setWindow", "performResumeLetter", "answerAfter", "takeOut", "beforeTurn", "letterTurn"].map(method).join("\n")}
    }
  `, loader: "ts", resolveDir: root },
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "error",
});
const { ResidentHarness, LETTER_PREFIX, readAuxiliaryAnswer, removeAuxiliaryTurn } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`
);

test("65536 reserve admits, persisted expired job cleans up after oversized append; bounded ordinary chat continues", async (t) => {
  const f = await fixture(t);
  const { session: s, resident: r } = f;
  await seed(s);
  const control = r.historyControl();
  assert.equal(await control.fits(65536), true);
  r.saveLetterJob(job()); // actual SQLite-backed Resident job persistence
  await auxiliary(s);
  await oversizedTail(s);
  assert.equal(await control.fits(), false);
  f.forbid();
  await assert.rejects(s.getHistory(), errorCode("budget"));
  await r.performResumeLetter();
  assert.equal(r.letterJob(), null, "expired failed job is durably retired");
  assert.equal(r.letterState().readWrite().state, "failed");
  assert.deepEqual(f.rawIds(), ["m0", "m1", "m2", "m3", "new_user", "new_reply"]);
  assert.deepEqual(f.state.deletions, [["letter_prompt", "letter_answer"]]);
  assert.deepEqual(f.state.messageReads, []);
  assert.deepEqual(f.state.payloads, []);
  assert.deepEqual(await s.getCompactions(), [], "failed job must not fold original chat");
  f.state.forbidPayloads = false;
  const recent = await s.getRecentHistory(B);
  assert.equal(recent.truncated, true);
  assert.deepEqual(ids(recent.messages), ["new_reply"]);
  const ordinary = [{ role: "user", content: "continue ordinary chat" }];
  assert.deepEqual((await r.beforeTurn(turn(ordinary))).messages, ordinary);
});

test("actual letterTurn failure cleanup escapes guarded answerAfter trap and preserves concurrent originals", async (t) => {
  const f = await fixture(t);
  const { session: s, resident: r } = f;
  await seed(s);
  assert.equal(await r.historyControl().fits(65536), true);
  r.saveMessages = async ([prompt]) => {
    assert.equal(r.letterJob().promptId, prompt.id, "job persisted BEFORE prompt/model boundary");
    await s.appendMessage(prompt);
    await s.appendMessage(msg("partial", "assistant", "x".repeat(B * 2)));
    await s.appendMessage(msg("concurrent_original"));
    await s.appendMessage(msg("concurrent_reply", "assistant"));
    f.forbid();
    throw new Error("synthetic model boundary failure");
  };
  await assert.rejects(r.letterTurn({ fromMessageId: "m0", toMessageId: "m1" }), /letter generation failed/);
  assert.equal(r.letterJob(), null);
  assert.equal(r.letterState().readWrite().state, "failed");
  assert.deepEqual(f.rawIds(), ["m0", "m1", "m2", "m3", "concurrent_original", "concurrent_reply"]);
  assert.deepEqual(f.state.payloads, []);
});

test("beforeTurn guards actual model letter input, not latest live UI user, and permits ordinary turns with pending job", async (t) => {
  const f = await fixture(t);
  const { session: s, resident: r } = f;
  await seed(s);
  r.historyControl();
  r.saveLetterJob(job(null, Date.now()));
  await auxiliary(s);
  await oversizedTail(s);
  f.forbid();
  r.liveUser = { id: "new_user", text: "ordinary live UI message" };
  for (const content of [LETTER_PREFIX, [{ type: "text", text: LETTER_PREFIX }]]) {
    await assert.rejects(r.beforeTurn(turn([{ role: "user", content }, { role: "assistant", content: "tool step" }])), /safe hydration budget/);
  }
  r.liveUser = { id: "letter_prompt", text: LETTER_PREFIX };
  const messages = [{ role: "user", content: "ordinary model turn despite pending UI prompt" }];
  assert.deepEqual((await r.beforeTurn(turn(messages))).messages, messages);
  assert.ok(r.letterJob(), "ordinary turn does not discard the pending job");
  assert.deepEqual(f.state.payloads, []);
});

test("saved summary recovery folds metadata-only while concurrent tail remains oversized, then survives reopen/idempotent retry", async (t) => {
  const f = await fixture(t);
  const { session: s, resident: r } = f;
  await seed(s);
  await s.addCompaction("old letter", "m0", "m1");
  const control = r.historyControl();
  assert.equal(await control.fits(65536), true);
  const saved = { ...job("saved dated new letter"), fromMessageId: "m2", toMessageId: "m3" };
  r.saveLetterJob(saved);
  await auxiliary(s);
  await oversizedTail(s);
  f.forbid();
  assert.equal(await control.fits(), false);
  await r.performResumeLetter();
  assert.equal(r.letterJob(), null);
  assert.equal(r.letterState().readWrite().state, "written");
  const records = await s.getCompactions();
  assert.equal(records.length, 2);
  assert.equal(records[1].fromMessageId, "m0", "existing letter folded into replacement prefix");
  assert.equal(records[1].toMessageId, "m3");
  assert.equal(records[1].summary, saved.summary);
  assert.equal(await control.fits(), false, "recovery did not enlarge the finite budget");
  assert.deepEqual(f.state.messageReads, []);
  assert.deepEqual(f.state.payloads, []);
  assert.deepEqual(f.rawIds(), ["m0", "m1", "m2", "m3", "new_user", "new_reply"]);
  const reopened = new ResidentHarness(await f.open(), f.sql, B, f.storage);
  reopened.saveLetterJob(saved); // simulate interruption after add before job deletion
  await reopened.performResumeLetter();
  assert.equal(reopened.letterJob(), null);
  assert.deepEqual(await reopened.session.getCompactions(), records);
  assert.deepEqual(f.state.payloads, []);
});

test("readAuxiliaryAnswer uses raw answer IDs behind an overlay and never reads oversized unrelated rows", async (t) => {
  const f = await fixture(t);
  const s = f.session;
  await s.appendMessage(msg("old_huge", "user", "x".repeat(B * 2)));
  await auxiliary(s);
  await s.appendMessage(msg("answer2", "assistant", "second answer"));
  await oversizedTail(s);
  await s.addCompaction("overlay hiding auxiliary answer", "letter_prompt", "answer2");
  f.resident.historyControl();
  assert.deepEqual(ids(await f.resident.answerAfter("letter_prompt")), ["letter_answer", "answer2"]);
  assert.deepEqual(f.state.messageReads, ["letter_answer", "answer2"]);
  f.forbid();
  await f.resident.takeOut("letter_prompt");
  assert.deepEqual(f.rawIds(), ["old_huge", "new_user", "new_reply"]);
  assert.deepEqual(f.state.payloads, []);
});

test("aggregate answer bytes are charged BEFORE any getMessage; cleanup needs no body or attachment reads", async (t) => {
  const f = await fixture(t);
  const s = f.session;
  await seed(s);
  await auxiliary(s, "x".repeat(700));
  await s.appendMessage(msg("answer2", "assistant", "y".repeat(700)));
  await s.appendMessage(msg("next_user"));
  await s.appendMessage(msg("next_reply", "assistant"));
  const stats = await s.getHistoryRowStats();
  const cost = stats.filter(({ id }) => ["letter_answer", "answer2"].includes(id)).reduce((n, { bytes }) => n + bytes, 0);
  f.forbid();
  await assert.rejects(readAuxiliaryAnswer(s, "letter_prompt", cost - 1), errorCode("budget"));
  assert.deepEqual(f.state.messageReads, [], "do not read even the first individually-small answer");
  await removeAuxiliaryTurn(s, "letter_prompt");
  assert.deepEqual(f.rawIds(), ["m0", "m1", "m2", "m3", "next_user", "next_reply"]);
  assert.deepEqual(f.state.payloads, []);
});

test("oversized attachment answer is refused by stats but metadata-only cleanup releases just its attachment", async (t) => {
  const f = await fixture(t);
  const s = f.session;
  await seed(s);
  await s.appendMessage(msg("letter_prompt"));
  const image = `data:image/png;base64,${Buffer.alloc(B * 2, 3).toString("base64")}`;
  await s.appendMessage({ id: "attachment_answer", role: "assistant", parts: [{ type: "file", mediaType: "image/png", url: image }] });
  await s.appendMessage(msg("next_user"));
  await s.appendMessage(msg("next_reply", "assistant"));
  assert.ok(f.db.prepare("SELECT count(*) AS n FROM cf_agents_session_attachment_meta").get().n > 0);
  f.forbid();
  await assert.rejects(readAuxiliaryAnswer(s, "letter_prompt", B), errorCode("budget"));
  await removeAuxiliaryTurn(s, "letter_prompt");
  assert.deepEqual(f.rawIds(), ["m0", "m1", "m2", "m3", "next_user", "next_reply"]);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM cf_agents_session_attachment_refs").get().n, 0);
  assert.deepEqual(f.state.messageReads, []);
  assert.deepEqual(f.state.payloads, []);
});

test("finite answer budgets and inclusive exact boundary", async (t) => {
  const f = await fixture(t);
  await auxiliary(f.session);
  const cost = (await f.session.getHistoryRowStats()).find(({ id }) => id === "letter_answer").bytes;
  for (const budget of [Infinity, NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(readAuxiliaryAnswer(f.session, "letter_prompt", budget), errorCode("budget"));
  }
  assert.deepEqual(f.state.messageReads, []);
  assert.deepEqual(ids(await readAuxiliaryAnswer(f.session, "letter_prompt", cost)), ["letter_answer"]);
});

test("off-branch/absent prompt never deletes by id, and an assistant id is never accepted as a prompt", async (t) => {
  const f = await fixture(t);
  const s = f.session;
  await seed(s);
  await auxiliary(s);
  await s.appendMessage(msg("fork_user"), { parentId: "m3" });
  await s.appendMessage(msg("fork_reply", "assistant"));
  const before = f.rawIds();
  f.forbid();
  for (const id of ["letter_prompt", "absent"]) {
    assert.deepEqual(await readAuxiliaryAnswer(s, id, B), []);
    await removeAuxiliaryTurn(s, id);
  }
  await assert.rejects(readAuxiliaryAnswer(s, "fork_reply", B), errorCode("metadata"));
  await assert.rejects(removeAuxiliaryTurn(s, "fork_reply"), errorCode("metadata"));
  assert.deepEqual(f.state.deletions, []);
  assert.deepEqual(f.rawIds(), before);
  assert.deepEqual(f.state.payloads, []);
});

test("cleanup works for a recent prompt on a depth-capped path without pretending full recovery is complete", async (t) => {
  const f = await fixture(t);
  const insert = f.db.prepare(`INSERT INTO cf_agents_session_messages
    (session_id, id, seq, parent_id, role, content, content_chunks, token_estimate, created_at)
    VALUES (?, ?, ?, ?, 'user', ?, 0, 1, 0)`);
  f.db.exec("BEGIN");
  for (let i = 0; i < 10002; i++) insert.run("deep", `d${i}`, i + 1, i ? `d${i - 1}` : null, JSON.stringify(msg(`d${i}`)));
  f.db.exec("COMMIT");
  const s = await f.open("deep");
  const r = new ResidentHarness(s, f.sql, B, f.storage);
  await auxiliary(s);
  await s.appendMessage(msg("next_user"));
  await s.appendMessage(msg("next_reply", "assistant"));
  f.forbid();
  await assert.rejects(r.historyControl().recovery(), errorCode("incomplete"));
  await removeAuxiliaryTurn(s, "letter_prompt");
  assert.deepEqual(f.state.deletions, [["letter_prompt", "letter_answer"]]);
  const rows = await s.getHistoryRowStats();
  assert.deepEqual(ids(rows).slice(-2), ["next_user", "next_reply"]);
  assert.deepEqual(f.state.payloads, []);
});

test("recovery snapshot exposes IDs only, raw ordered membership, and no fit prerequisite", async (t) => {
  const f = await fixture(t);
  const s = f.session;
  await seed(s);
  const record = await s.addCompaction("prior", "m0", "m1");
  await oversizedTail(s);
  const c = f.resident.historyControl();
  f.forbid();
  assert.equal(await c.fits(), false);
  const view = await c.recovery();
  assert.deepEqual(view.messages, [{ id: `compaction_${record.id}` }, { id: "m2" }, { id: "m3" }, { id: "new_user" }, { id: "new_reply" }]);
  assert.deepEqual(view.compactions, [record]);
  assert.equal(view.containsRange("m0", "m3"), true, "hidden raw endpoints remain usable");
  assert.equal(view.containsRange("m1", "m1"), true);
  for (const [from, to] of [["m3", "m0"], ["missing", "m3"], ["m0", `compaction_${record.id}`]]) {
    assert.equal(view.containsRange(from, to), false);
  }
  await view.assertCurrent();
  assert.deepEqual(f.state.payloads, []);
});

for (const change of ["leaf", "record", "stats"]) {
  test(`recovery assertCurrent rejects moving ${change} metadata before commit`, async (t) => {
    const f = await fixture(t);
    const s = f.session;
    await seed(s);
    await s.addCompaction("old", "m0", "m1");
    const view = await f.resident.historyControl().recovery();
    if (change === "leaf") await s.appendMessage(msg("fork"), { parentId: "m0" });
    if (change === "record") f.db.prepare("UPDATE cf_agents_session_compactions SET summary = 'new'").run();
    if (change === "stats") f.db.prepare("UPDATE cf_agents_session_messages SET token_estimate = token_estimate + 1 WHERE id = 'm0'").run();
    f.forbid();
    await assert.rejects(view.assertCurrent(), errorCode("changed"));
    assert.deepEqual(f.state.payloads, []);
  });
}

for (const operation of ["read", "remove"]) {
  test(`auxiliary ${operation} rejects a leaf move during metadata preflight`, async (t) => {
    const f = await fixture(t);
    const s = f.session;
    await seed(s);
    await auxiliary(s);
    const original = s.getHistoryRowStats.bind(s);
    let moved = false;
    s.getHistoryRowStats = async (...args) => {
      const rows = await original(...args);
      if (!moved) { moved = true; await s.appendMessage(msg("fork"), { parentId: "m3" }); }
      return rows;
    };
    f.forbid();
    await assert.rejects(operation === "read" ? readAuxiliaryAnswer(s, "letter_prompt", B) : removeAuxiliaryTurn(s, "letter_prompt"), errorCode("changed"));
    assert.deepEqual(f.state.deletions, []);
    assert.deepEqual(f.state.messageReads, []);
    assert.deepEqual(f.state.payloads, []);
  });
}

test("actual saved-summary callback refuses a missing/reversed/off-branch range without native add", async (t) => {
  const f = await fixture(t);
  const s = f.session;
  await seed(s);
  const r = f.resident;
  await s.appendMessage(msg("off_branch"), { parentId: "m1" });
  await s.appendMessage(msg("active_tail"), { parentId: "m3" });
  for (const endpoints of [
    { fromMessageId: "m3", toMessageId: "m0" },
    { fromMessageId: "missing", toMessageId: "m3" },
    { fromMessageId: "m0", toMessageId: "off_branch" },
  ]) {
    r.saveLetterJob({ ...job("saved"), ...endpoints });
    f.forbid();
    await assert.rejects(r.performResumeLetter(), /selected branch/);
    assert.ok(r.letterJob(), "invalid range remains retryable, never falsely written");
    assert.deepEqual(await s.getCompactions(), []);
  }
  assert.deepEqual(f.state.payloads, []);
});

test("actual saved-summary callback checks snapshot currency immediately before native add", async (t) => {
  const f = await fixture(t);
  const { session: s, resident: r } = f;
  await seed(s);
  r.saveLetterJob(job("saved summary"));
  const c = r.historyControl();
  const recovery = c.recovery.bind(c);
  c.recovery = async () => {
    const view = await recovery();
    await s.appendMessage(msg("moved_after_snapshot"));
    return view;
  };
  f.forbid();
  await assert.rejects(r.performResumeLetter(), errorCode("changed"));
  assert.ok(r.letterJob(), "failed commit guard leaves saved letter retryable");
  assert.deepEqual(await s.getCompactions(), []);
  assert.deepEqual(f.state.payloads, []);
});

test("auxiliary read rejects metadata that moves during bounded answer hydration", async (t) => {
  const f = await fixture(t);
  const s = f.session;
  await auxiliary(s);
  const getMessage = s.getMessage.bind(s);
  s.getMessage = async (id) => {
    const answer = await getMessage(id);
    await s.appendMessage(msg("new_user"));
    return answer;
  };
  await assert.rejects(readAuxiliaryAnswer(s, "letter_prompt", B), errorCode("changed"));
  assert.deepEqual(f.state.messageReads, ["letter_answer"]);
  assert.deepEqual(f.state.deletions, []);
});

test("recovery commit refuses a leaf that moved after its snapshot, without any body read", async (t) => {
  const f = await fixture(t);
  const s = f.session;
  await seed(s);
  const view = await f.resident.historyControl().recovery();
  await s.appendMessage(msg("moved"));
  f.forbid();
  await assert.rejects(view.assertCurrent(), errorCode("changed"));
  assert.deepEqual(f.state.payloads, []);
});

test("SDK compact bypasses public getHistory guard: recovery must never call it as a metadata substitute", async (t) => {
  const f = await fixture(t);
  const s = f.session;
  await seed(s);
  await oversizedTail(s);
  f.resident.historyControl();
  await assert.rejects(s.getHistory(), errorCode("budget"));
  s.onCompaction(async () => null);
  f.forbid();
  // Installed SDK uses core.getHistory before invoking onCompaction. This
  // control proves a public guard alone is NOT a compact() hydration barrier.
  await assert.rejects(s.compact(), /Unexpected body\/attachment hydration/);
  assert.ok(f.state.payloads.length > 0);
});
