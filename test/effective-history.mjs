// Real agents/sessions + Node SQLite, synthetic data only. No Worker/network/model.
// Node 22+: node test/effective-history.mjs
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Sessions } from "agents/sessions";

const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../src/effective-history.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "error",
});
const { installEffectiveHistory, EffectiveHistoryError } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`
);
// Execute the actual installation hook too: a correct planner not installed before Think's reads is insufficient.
const residentSource = readFileSync(new URL("../src/resident.ts", import.meta.url), "utf8");
const glue = ["historyControl", "configureSession"].map(name => {
  const method = residentSource.match(new RegExp(`^  (?:private |override )*(?:async )?${name}\\([^\\n]*[\\s\\S]*?^  \\}`, "m"));
  assert.ok(method, `actual Resident ${name} installation must exist`);
  return method[0].replace("override ", "");
}).join("\n");
const glued = await build({ stdin: {
  contents: `import { installEffectiveHistory } from './src/effective-history.ts';
    import { historyPathComplete } from './src/history-path.ts';
    import { foldIntoLetter } from './src/fold.ts';
    export class ResidentHistoryHarness {
      effectiveHistories = new WeakMap();
      #short = false;
      constructor(public session, public sql, public hydrationByteBudget) {}
      async letterTurn() { throw new Error('model must not run in installation test'); }
      ${glue}
    }`,
  resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "ts"
}, bundle: true, platform: "node", format: "esm", write: false, logLevel: "error" });
const { ResidentHistoryHarness } = await import(`data:text/javascript;base64,${Buffer.from(glued.outputFiles[0].text).toString("base64")}`);
const byteLength = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const ids = (messages) => messages.map((message) => message.id);
const msg = (id, text = `text:${id}`) => ({ id, role: "user", parts: [{ type: "text", text }] });
const isError = (code) => (error) => error instanceof EffectiveHistoryError && error.code === code;

async function fixture(t, disk = false) {
  const directory = disk ? mkdtempSync(join(tmpdir(), "aelios-effective-history-")) : null;
  const filename = directory ? join(directory, "sessions.sqlite") : ":memory:";
  let db = new DatabaseSync(filename);
  const kv = new Map();
  let transactionId = 0;
  const queries = [];
  const state = { forbidPayloads: false };
  const storage = {
    get: async (key) => kv.get(key),
    put: async (key, value) => { kv.set(key, value); },
    sql: {
      exec(query, ...params) {
        if (/^\s*SELECT/.test(query) && (/\bcontent\b/.test(query) || /\bdata\b/.test(query))) {
          // Stats use LENGTH(content) inside a WITH RECURSIVE query, not a
          // payload SELECT. This deliberately traps actual body hydration.
          queries.push({ query, params });
          if (state.forbidPayloads) throw new Error("Unexpected body/attachment hydration");
        }
        const statement = db.prepare(query);
        // DO SQL accepts ArrayBuffer blobs; Node SQLite accepts typed views.
        const bindings = params.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
        if (statement.columns().length) return Object.assign(statement.all(...bindings), { rowsWritten: 0 });
        return Object.assign([], { rowsWritten: Number(statement.run(...bindings).changes) });
      },
    },
    transactionSync(fn) {
      const name = `test_${transactionId++}`;
      db.exec(`SAVEPOINT ${name}`);
      try { const result = fn(); db.exec(`RELEASE ${name}`); return result; }
      catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
    },
  };
  async function open() {
    const sessions = new Sessions();
    // The only fake is the DO lifecycle/storage boundary, not Session methods.
    Object.defineProperty(sessions, "lifecycle", {
      value: { storage, ready: async () => {}, events: { emit() {} } },
    });
    await sessions.onStart();
    return sessions;
  }
  const pathComplete = (session) => (leafId) => {
    if (leafId === null) return !db.prepare(
      "SELECT 1 FROM cf_agents_session_messages WHERE session_id = ? LIMIT 1"
    ).get(session.sessionId);
    // Include hidden stored overlays, stop at exactly the SDK depth cap, and
    // require an actual NULL parent (not merely failure to find another row).
    const oldest = db.prepare(`WITH RECURSIVE path(id, parent_id, depth) AS (
      SELECT id, parent_id, 0 FROM cf_agents_session_messages WHERE session_id = ? AND id = ?
      UNION ALL
      SELECT m.id, m.parent_id, p.depth + 1 FROM cf_agents_session_messages m
      JOIN path p ON m.id = p.parent_id WHERE m.session_id = ? AND p.depth < 10000
    ) SELECT parent_id, depth FROM path ORDER BY depth DESC LIMIT 1`).get(
      session.sessionId, leafId, session.sessionId
    );
    return !!oldest && oldest.parent_id === null;
  };
  t.after(() => { db.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  return {
    sessions: await open(), open, queries, state, get db() { return db; }, pathComplete,
    install(session, budget = 8192) {
      return installEffectiveHistory(session, {
        budget: typeof budget === "function" ? budget : () => budget,
        pathComplete: pathComplete(session),
      });
    },
    async restart() {
      assert.ok(directory, "restart must reopen an actual file, not an in-memory DB");
      db.close(); db = new DatabaseSync(filename);
      return open();
    },
  };
}

async function seed(session, count = 10, size = 30) {
  for (let i = 0; i < count; i++) await session.appendMessage(msg(`m${i}`, "x".repeat(size)));
}

// Public boundary spies only; install must bind these before patching.
function spyReads(session) {
  const history = session.getHistory.bind(session);
  const recent = session.getRecentHistory.bind(session);
  const calls = { history: [], recent: [] };
  session.getHistory = async (options) => { calls.history.push(options); return history(options); };
  session.getRecentHistory = async (budget, options) => { calls.recent.push([budget, options]); return recent(budget, options); };
  session.getLatestLeaf = async () => { throw new Error("getLatestLeaf must never be called"); };
  return calls;
}

function assertSummaryCost(plan, history, stats) {
  const raw = new Map(stats.map((row) => [row.id, row.bytes]));
  const uncovered = history.filter((message) => raw.has(message.id)).reduce((n, message) => n + raw.get(message.id), 0);
  const summaries = history.filter((message) => !raw.has(message.id)).reduce((n, message) => n + byteLength(message), 0);
  assert.equal(plan.uncoveredBytes, uncovered);
  assert.equal(plan.summaryBytes, summaries);
  assert.equal(plan.effectiveBytes, uncovered + summaries);
}

test("control: stock raw-window bug; adapter includes a summary whose end is outside the raw window", async (t) => {
  const f = await fixture(t);
  const s = f.sessions.session();
  await seed(s, 3, 9000);
  await s.appendMessage(msg("tail", "recent"));
  const record = await s.addCompaction("交接信：事实保留", "m0", "m2");
  const stats = await s.getHistoryRowStats();
  const rawTotal = stats.reduce((n, row) => n + row.bytes, 0);
  const stock = await s.getRecentHistory(1024);
  assert.equal(stock.truncated, true);
  assert.deepEqual(ids(stock.messages), ["tail"]);
  assert.equal(stock.totalContentBytes, rawTotal);
  const calls = spyReads(s);
  const c = f.install(s, 1024);
  assert.equal(await c.fits(100), true);
  const recent = await s.getRecentHistory(1024);
  assert.deepEqual(ids(recent.messages), [`compaction_${record.id}`, "tail"]);
  assert.equal(recent.truncated, false);
  assert.equal(recent.totalContentBytes, rawTotal, "keep SDK RAW total semantics");
  assert.equal(calls.recent.length, 0, "full effective read bypasses broken stock window");
  assert.equal(calls.history.at(-1).leafId, "tail", "pin from last stat, not a hydrated leaf");
  assertSummaryCost(await c.plan(), recent.messages, stats);
  assert.deepEqual(await s.getHistoryRowStats(), stats, "raw rows were not deleted or evicted");
});

test(">32 MiB raw single media leaf is covered by a small letter and NEVER hydrated", async (t) => {
  const f = await fixture(t);
  const s = f.sessions.session();
  const B = 32 * 1024 * 1024;
  // 25 MiB binary -> >33 MiB inline base64. One raw leaf alone exceeds B.
  await s.appendMessage({ id: "huge", role: "user", parts: [{
    type: "file", mediaType: "image/png",
    url: `data:image/png;base64,${Buffer.alloc(25 * 1024 * 1024, 7).toString("base64")}`,
  }] });
  const [stat] = await s.getHistoryRowStats();
  assert.ok(stat.bytes > B);
  const record = await s.addCompaction("小信，保留事实。", "huge", "huge");
  const attachmentBefore = f.db.prepare("SELECT sum(bytes) AS bytes FROM cf_agents_session_attachment_meta").get().bytes;
  assert.equal(attachmentBefore, 25 * 1024 * 1024, "actual persisted media, not fake byte metadata");
  const calls = spyReads(s);
  f.queries.length = 0;
  f.state.forbidPayloads = true;
  // onCompactionError is the thin Think-session extension over the real Sessions handle.
  s.onCompactionError = () => s;
  const sql = (strings, ...values) => f.db.prepare(strings.join("?")).all(...values);
  const resident = new ResidentHistoryHarness(s, sql, B);
  resident.configureSession(s);
  resident.configureSession(s); // repeated configuration must reuse the same instance adapter
  const c = resident.historyControl(s);
  assert.equal(c, resident.historyControl(s));
  assert.equal(await c.fits(4096), true);
  const recent = await s.getRecentHistory(B);
  assert.deepEqual(ids(recent.messages), [`compaction_${record.id}`]);
  assert.equal(recent.truncated, false);
  assert.equal(recent.totalContentBytes, stat.bytes);
  assert.deepEqual(ids(await s.getHistory()), ids(recent.messages));
  assert.equal(calls.history.length, 2);
  assert.equal(calls.recent.length, 0);
  assert.deepEqual(f.queries, [], "not even a single body or attachment SELECT was issued");
  assert.equal((await c.plan()).uncoveredBytes, 0);
  assert.equal(f.db.prepare("SELECT sum(bytes) AS bytes FROM cf_agents_session_attachment_meta").get().bytes, attachmentBefore);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM cf_agents_session_attachment_refs").get().n, 1);
});

test("uncovered oversized leaf fails admission and guarded getHistory BEFORE any body read", async (t) => {
  const f = await fixture(t);
  const s = f.sessions.session();
  await seed(s, 1, 5000);
  const calls = spyReads(s);
  const c = f.install(s, 512);
  f.state.forbidPayloads = true;
  assert.equal(await c.fits(), false);
  await assert.rejects(s.getHistory(), isError("budget"));
  await assert.rejects(s.getRecentHistory(512), isError("budget"));
  assert.equal(calls.history.length, 0);
  assert.equal(calls.recent.length, 0, "bound stock reader's always-include-leaf exception is not safe here");
});

test("ordinary chat falls back to the stock finite suffix while letter admission rejects", async (t) => {
  const f = await fixture(t);
  const s = f.sessions.session();
  await seed(s, 2, 5000);
  await s.appendMessage(msg("tail"));
  const stock = await s.getRecentHistory(512);
  const calls = spyReads(s);
  const c = f.install(s, 512);
  assert.equal(await c.fits(30), false);
  await assert.rejects(s.getHistory(), isError("budget"));
  const recent = await s.getRecentHistory(512);
  assert.deepEqual(recent, stock);
  assert.equal(recent.truncated, true);
  assert.equal(calls.history.length, 0);
  assert.deepEqual(calls.recent, [[512, { leafId: "tail" }]]);
  // Caller budgets cannot enlarge the installed ceiling.
  await s.getRecentHistory(1000000);
  assert.equal(calls.recent.at(-1)[0], 512);
});

test("summary UTF-8/JSON overhead is charged, even when all RAW rows fit", async (t) => {
  const f = await fixture(t);
  const s = f.sessions.session();
  await seed(s, 2);
  const record = await s.addCompaction('汉🙂\n"\\'.repeat(300), "m0", "m1");
  const calls = spyReads(s);
  let B = 1024;
  const c = f.install(s, () => B);
  const plan = await c.plan();
  assert.ok(plan.rawBytes < B);
  assert.ok(plan.summaryBytes > B);
  assert.ok(plan.summaryBytes > record.summary.length);
  assert.equal(await c.fits(), false);
  await assert.rejects(s.getHistory(), isError("budget"));
  await assert.rejects(s.getRecentHistory(B), isError("budget"));
  assert.equal(calls.history.length + calls.recent.length, 0);
  B = plan.effectiveBytes;
  assert.equal(await c.fits(), true, "inclusive byte boundary");
  assert.equal(await c.fits(1), false, "letter prompt reserve shares the same effective plan");
  const full = await s.getRecentHistory(B);
  assert.equal(full.truncated, false);
  assert.equal(byteLength(full.messages[0]), plan.summaryBytes);
  B += 100;
  assert.equal(await c.fits(100), true);
  assert.equal(await c.fits(101), false);
  await assert.rejects(s.getRecentHistory(plan.effectiveBytes - 1), isError("budget"));
});

test("exact SDK selection: legacy heads, same-start newest, skips, overlaps, reverse ranges, off-branch", async (t) => {
  const f = await fixture(t);
  const s = f.sessions.session();
  await seed(s);
  await s.appendMessage(msg("fork"), { parentId: "m2" });
  await s.appendMessage(msg("m10"), { parentId: "m9" });
  await s.addCompaction("older long span", "m3", "m7");
  await s.addCompaction("inside chosen span must be skipped", "m4", "m8");
  const winner = await s.addCompaction("newer SHORT same-start wins", "m3", "m5");
  const later = await s.addCompaction("later disjoint span", "m6", "m8");
  await s.addCompaction("newest same-start but OFF BRANCH", "m3", "fork");
  await s.addCompaction("reversed range", "m9", "m2");
  const stockFull = await s.getHistory();
  assert.deepEqual(ids(stockFull), ["m0", "m1", "m2", `compaction_${winner.id}`, `compaction_${later.id}`, "m9", "m10"]);
  const c = f.install(s);
  assert.deepEqual(ids(await s.getRecentHistory(8192).then((r) => r.messages)), ids(stockFull));
  assertSummaryCost(await c.plan(), stockFull, await s.getHistoryRowStats());
  const branch = await s.getRecentHistory(8192, { leafId: "m2" });
  assert.deepEqual(ids(branch.messages), ["m0", "m1", "m2"]);
  assert.equal(branch.truncated, false);
  // Root-to-leaf skipping beats the global newest compaction.
  const outer = await s.addCompaction("covers legacy head and all earlier overlays", "m0", "m8");
  await s.addCompaction("globally newest, but skipped inside outer", "m2", "m9");
  assert.deepEqual(ids(await s.getHistory()), [`compaction_${outer.id}`, "m9", "m10"]);
  assert.deepEqual((await c.plan()).messageIds, [`compaction_${outer.id}`, "m9", "m10"]);
});

test("repeated real SDK folds and disk restart keep only the selected latest letter, raw rows intact", async (t) => {
  const f = await fixture(t, true);
  let s = f.sessions.session();
  await seed(s, 10, 3000);
  await s.addCompaction("first", "m0", "m3");
  f.install(s, 32000);
  const callbacks = [];
  for (const end of ["m5", "m7", "m8"]) {
    const input = await s.getRecentHistory(32000);
    s.onCompaction(async (history) => {
      callbacks.push(ids(history));
      assert.deepEqual(ids(history), ids(input.messages));
      return { summary: `fold:${end}`, fromMessageId: "m4", toMessageId: end };
    });
    assert.equal((await s.compact()).fromMessageId, "m0");
    const next = await s.getRecentHistory(32000);
    assert.equal(next.messages[0].parts[0].text, `fold:${end}`);
    assert.equal(next.messages.filter((m) => m.id.startsWith("compaction_")).length, 1);
    assert.equal(next.truncated, false);
  }
  const before = await s.getHistoryRowStats();
  const effectiveBefore = (await s.getHistory()).map(({ createdAt, ...m }) => m);
  s = (await f.restart()).session();
  const c = f.install(s, 32000);
  assert.equal(await c.fits(1024), true);
  assert.deepEqual((await s.getHistory()).map(({ createdAt, ...m }) => m), effectiveBefore);
  assert.deepEqual(await s.getHistoryRowStats(), before);
  assert.equal((await s.getCompactions()).length, 4);
  assert.equal(callbacks.length, 3);
});

test("hidden legacy stored overlays are skipped, imported foreign summaries remain charged", async (t) => {
  const f = await fixture(t);
  const s = f.sessions.session();
  await seed(s, 2);
  const record = await s.addCompaction("own letter", "m0", "m1");
  await s.importMessage(msg(`compaction_${record.id}`, "obsolete duplicate body"), { parentId: "m1", createdAt: 0 });
  await s.importMessage(msg("compaction_foreign", "only surviving imported summary"), {
    parentId: `compaction_${record.id}`, createdAt: 0,
  });
  await s.appendMessage(msg("tail"));
  const expected = await s.getHistory();
  const c = f.install(s);
  const actual = await s.getHistory();
  assert.deepEqual(ids(actual), [`compaction_${record.id}`, "compaction_foreign", "tail"]);
  assertSummaryCost(await c.plan(), expected, await s.getHistoryRowStats());
  assert.deepEqual(ids(actual), ids(expected));
});

test("active leaf moves during metadata preflight: reject before full hydration", async (t) => {
  const f = await fixture(t);
  const s = f.sessions.session();
  await seed(s, 2);
  const base = s.getHistoryRowStats.bind(s);
  let changed = false;
  s.getHistoryRowStats = async (leaf) => {
    const rows = await base(leaf);
    if (!changed) { changed = true; await s.appendMessage(msg("new-leaf")); }
    return rows;
  };
  const calls = spyReads(s);
  f.install(s);
  await assert.rejects(s.getHistory(), isError("changed"));
  assert.equal(calls.history.length, 0);
});

test("same-length overlay replacement during materialization is rejected, not reported as full", async (t) => {
  const f = await fixture(t);
  const s = f.sessions.session();
  await seed(s, 3);
  await s.addCompaction("old", "m0", "m1");
  const original = s.getHistory.bind(s);
  s.getHistory = async (options) => {
    const messages = await original(options);
    await s.addCompaction("new", "m0", "m1");
    return messages;
  };
  f.install(s);
  await assert.rejects(s.getRecentHistory(8192), isError("changed"));
});

test("moving leaf after full hydration and moving records after stock fallback both fail closed", async (t) => {
  const f = await fixture(t);
  const full = f.sessions.session("full");
  await seed(full, 2);
  const original = full.getHistory.bind(full);
  full.getHistory = async (options) => {
    const messages = await original(options);
    await full.appendMessage(msg("moved"));
    return messages;
  };
  f.install(full);
  await assert.rejects(full.getHistory(), isError("changed"));

  const window = f.sessions.session("window");
  await seed(window, 2, 5000);
  await window.appendMessage(msg("tail"));
  const recent = window.getRecentHistory.bind(window);
  window.getRecentHistory = async (...args) => {
    const result = await recent(...args);
    await window.addCompaction("changed record", "m0", "m1");
    return result;
  };
  f.install(window, 512);
  await assert.rejects(window.getRecentHistory(512), isError("changed"));
});

test("pinned branch, newestFirst full reads, and abort preserve public read options", async (t) => {
  const f = await fixture(t);
  const s = f.sessions.session();
  await seed(s, 4);
  const record = await s.addCompaction("letter", "m0", "m1");
  const calls = spyReads(s);
  const c = f.install(s);
  assert.equal(await c.fits(1, { leafId: "m2" }), true);
  assert.deepEqual((await c.plan({ leafId: "m2" })).messageIds, [`compaction_${record.id}`, "m2"]);
  const reverse = await s.getHistory({ leafId: "m2", newestFirst: true });
  assert.deepEqual(ids(reverse), ["m2", `compaction_${record.id}`]);
  assert.deepEqual(calls.history.at(-1), { leafId: "m2", newestFirst: true });
  const signal = AbortSignal.abort(new Error("test abort"));
  await assert.rejects(s.getHistory({ signal }), /test abort/);
  assert.equal(calls.history.length, 1, "abort before calling the bound full reader");
});

test("missing parent on a short path is incomplete: reject full/letter, permit only truncated stock", async (t) => {
  const f = await fixture(t);
  const s = f.sessions.session();
  await s.importMessage(msg("orphan"), { parentId: "missing-root", createdAt: 0 });
  const calls = spyReads(s);
  const c = f.install(s);
  assert.equal((await c.plan()).complete, false);
  assert.equal(await c.fits(), false);
  await assert.rejects(s.getHistory(), isError("incomplete"));
  const recent = await s.getRecentHistory(8192);
  assert.equal(recent.truncated, true, "stock would incorrectly say false for a missing parent");
  assert.deepEqual(ids(recent.messages), ["orphan"]);
  assert.equal(calls.history.length, 0);
});

test("10,000-depth boundary uses SQL root verification, not stat length or effective bytes", async (t) => {
  const f = await fixture(t);
  // Bulk synthetic schema fixture, then all reads use actual Sessions. Direct
  // SQL keeps the test fast and also permits legacy/corrupt-parent scenarios.
  const insert = f.db.prepare(`INSERT INTO cf_agents_session_messages
    (session_id, id, seq, parent_id, role, content, content_chunks, token_estimate, created_at)
    VALUES (?, ?, ?, ?, 'user', ?, 0, 1, 0)`);
  f.db.exec("BEGIN");
  for (let i = 0; i < 10002; i++) insert.run("deep", `d${i}`, i + 1, i ? `d${i - 1}` : null, JSON.stringify(msg(`d${i}`)));
  f.db.exec("COMMIT");
  const s = (await f.open()).session("deep");
  // A compaction can make the depth-capped suffix LOOK tiny; it still isn't a
  // verified full path, even though the SDK returns exactly 10,001 stat rows.
  await s.addCompaction("small capped summary", "d1", "d10001");
  const calls = spyReads(s);
  const c = f.install(s, 4 * 1024 * 1024);
  assert.equal((await s.getHistoryRowStats()).length, 10001);
  assert.equal((await c.plan()).complete, false);
  assert.equal(await c.fits(), false);
  await assert.rejects(s.getHistory(), isError("incomplete"));
  const capped = await s.getRecentHistory(4 * 1024 * 1024);
  assert.equal(capped.truncated, true);
  assert.equal(calls.history.length, 0);
  // Exactly depth 10,000 (10,001 rows) with a real root IS complete.
  assert.equal((await c.plan({ leafId: "d10000" })).complete, true);
  assert.equal(await c.fits(0, { leafId: "d10000" }), true);
  // Hidden legacy rows also count toward the SDK cap even though they do not
  // appear in getHistoryRowStats. Never infer completeness from stats.length.
  const record = (await s.getCompactions())[0];
  const hidden = `compaction_${record.id}`;
  insert.run("deep", hidden, 10003, "d0", JSON.stringify(msg(hidden)));
  f.db.prepare("UPDATE cf_agents_session_messages SET parent_id = ? WHERE session_id = 'deep' AND id = 'd1'").run(hidden);
  assert.equal((await s.getHistoryRowStats("d10000")).length, 10000);
  assert.equal((await c.plan({ leafId: "d10000" })).complete, false);
});

test("post-read ids/content must match the plan even with unchanged metadata", async (t) => {
  const f = await fixture(t);
  const s = f.sessions.session();
  await seed(s, 2);
  const original = s.getHistory.bind(s);
  s.getHistory = async (options) => (await original(options)).slice(1);
  f.install(s);
  await assert.rejects(s.getHistory(), isError("changed"));
});

test("summary content mismatch is rejected even if ids, lengths and public metadata match", async (t) => {
  const f = await fixture(t);
  const s = f.sessions.session();
  await seed(s, 2);
  await s.addCompaction("old", "m0", "m1");
  const original = s.getHistory.bind(s);
  s.getHistory = async (options) => (await original(options)).map((m) => ({
    ...m, parts: [{ type: "text", text: "new" }],
  }));
  f.install(s);
  await assert.rejects(s.getRecentHistory(8192), isError("changed"));
});

test("budget shrink during preflight or materialization cannot yield a successful admission", async (t) => {
  const f = await fixture(t);
  const s = f.sessions.session();
  await seed(s, 2);
  let B = 8192;
  const calls = spyReads(s);
  const verify = f.pathComplete(s);
  const c = installEffectiveHistory(s, {
    budget: () => B,
    pathComplete(leafId) { B = 0; return verify(leafId); },
  });
  assert.equal(await c.fits(), false);
  B = 8192;
  await assert.rejects(s.getHistory(), isError("changed"));
  B = 8192;
  await assert.rejects(s.getRecentHistory(8192), isError("changed"));
  assert.equal(calls.history.length + calls.recent.length, 0);
  c.restore();
  B = 8192;
  const original = s.getHistory.bind(s);
  s.getHistory = async (options) => {
    const messages = await original(options);
    B = 0;
    return messages;
  };
  f.install(s, () => B);
  await assert.rejects(s.getHistory(), isError("changed"));
});

test("finite ceilings, reserves, per-instance patching, empty path, and exact restoration", async (t) => {
  const f = await fixture(t);
  const s = f.sessions.session();
  for (const value of [Infinity, NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => f.install(s, value), isError("budget"));
  }
  const prototypeHistory = s.getHistory;
  const other = f.sessions.session("other");
  let B = 8192;
  const c = f.install(s, () => B);
  assert.equal(other.getHistory, prototypeHistory);
  assert.throws(() => f.install(s), /already installed/);
  assert.equal(await c.fits(), true);
  assert.deepEqual(await s.getHistory(), []);
  assert.deepEqual(await s.getRecentHistory(0), { messages: [], truncated: false, totalContentBytes: 0 });
  await assert.rejects(s.getRecentHistory(Infinity), isError("budget"));
  await assert.rejects(c.fits(Infinity), isError("budget"));
  B = Infinity;
  await assert.rejects(s.getHistory(), isError("budget"));
  c.restore();
  assert.equal(s.getHistory, prototypeHistory);
  assert.equal(Object.hasOwn(s, "getHistory"), false);
  assert.equal(Object.hasOwn(s, "getRecentHistory"), false);
  f.install(s).restore();
});
