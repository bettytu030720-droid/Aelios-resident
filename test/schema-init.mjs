// Execute actual lazy schema methods against SQLite, without importing the Worker.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { build } from "esbuild";
const source = readFileSync(new URL("../src/resident.ts", import.meta.url), "utf8");
const methods = ["markTurn", "restoreTurn", "letterJob", "saveLetterJob", "deleteLetterJob"].map(name => {
  const method = source.match(new RegExp(`^  private ${name}\\([^\\n]*[\\s\\S]*?^  \\}`, "m"));
  assert.ok(method, `actual ${name} method must exist`);
  return method[0];
}).join("\n");
const compiled = await build({ stdin: { contents: `export class Subject {
  #theirTurns = new Set(); #readOutside = new Set();
  constructor(public sql: any) {}
  ${methods}
}`, loader: "ts" }, platform: "node", format: "esm", write: false, logLevel: "error" });
const { Subject } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
function fixture(t) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const ddl = []; let failNext = false;
  const sql = (strings, ...values) => {
    const query = strings.join("?");
    if (query.includes("CREATE TABLE")) {
      ddl.push(query);
      if (failNext) { failNext = false; throw new Error("synthetic schema failure"); }
    }
    const statement = db.prepare(query);
    if (statement.columns().length) return statement.all(...values);
    statement.run(...values); return [];
  };
  return { subject: new Subject(sql), sql, ddl, fail() { failNext = true; } };
}
test("turn schema is created once across mark/restore, and recreated on a fresh object lifetime", t => {
  const f = fixture(t);
  f.subject.markTurn("r", "their"); f.subject.restoreTurn("r"); f.subject.markTurn("r", "outside");
  assert.equal(f.ddl.length, 1);
  new Subject(f.sql).restoreTurn("r");
  assert.equal(f.ddl.length, 2);
});
test("letter schema is created once across getters, save and delete", t => {
  const f = fixture(t);
  assert.equal(f.subject.letterJob(), null);
  f.subject.saveLetterJob({ promptId: "p", reason: "idle", fromMessageId: "a", toMessageId: "b", summary: null, createdAt: 1 });
  assert.equal(f.subject.letterJob().promptId, "p");
  f.subject.deleteLetterJob("p"); assert.equal(f.subject.letterJob(), null);
  assert.equal(f.ddl.length, 1);
});
test("DDL failure is not memoized as success; next call retries", t => {
  const f = fixture(t);
  f.fail(); assert.throws(() => f.subject.restoreTurn("r"), /synthetic schema failure/);
  f.subject.markTurn("r", "their");
  f.fail(); assert.throws(() => f.subject.letterJob(), /synthetic schema failure/);
  assert.equal(f.subject.letterJob(), null);
  assert.equal(f.ddl.length, 4);
});
