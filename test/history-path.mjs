// Metadata-only checks against SQLite; no Worker, network, or private transcript.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({
  entryPoints: [new URL("../src/history-path.ts", import.meta.url).pathname],
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "error"
});
const { historyPathComplete } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE cf_agents_session_messages (session_id TEXT, id TEXT, parent_id TEXT, PRIMARY KEY(session_id,id))");
  const add = db.prepare("INSERT INTO cf_agents_session_messages VALUES (?, ?, ?)");
  const sql = (strings, ...values) => db.prepare(strings.join("?")).all(...values);
  return { db, sql, add };
}

test("complete selected branch reaches its own root, independent of sibling branches", t => {
  const { sql, add } = fixture(t);
  add.run("s", "root", null); add.run("s", "a", "root"); add.run("s", "b", "root");
  assert.equal(historyPathComplete(sql, "s", "a"), true);
  assert.equal(historyPathComplete(sql, "s", "b"), true);
});

test("missing leaf, missing parent, and same IDs from another session do not prove completeness", t => {
  const { sql, add } = fixture(t);
  add.run("s", "leaf", "missing"); add.run("other", "missing", null);
  assert.equal(historyPathComplete(sql, "s", "leaf"), false);
  assert.equal(historyPathComplete(sql, "s", "unknown"), false);
});

test("raw depth includes hidden overlay rows; exact SDK ceiling is allowed, deeper paths refused", t => {
  const { db, sql, add } = fixture(t);
  db.exec("BEGIN");
  for (let i = 0; i <= 10_001; i++) add.run("s", `m${i}`, i ? `m${i - 1}` : null);
  db.exec("COMMIT");
  assert.equal(historyPathComplete(sql, "s", "m10000"), true);
  assert.equal(historyPathComplete(sql, "s", "m10001"), false);
});

test("cyclic ancestry fails closed without loading any content", t => {
  const { sql, add } = fixture(t);
  add.run("s", "a", "b"); add.run("s", "b", "a");
  assert.equal(historyPathComplete(sql, "s", "a"), false);
});
