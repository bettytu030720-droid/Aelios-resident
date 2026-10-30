// Unit tests for files handed over in the chat (src/made-files.ts): names, types, the make_file tool's limits, and
// the file list in SQLite (node:sqlite stands in for the agent's). Usage: node test/made-files.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-files-"));
const out = join(dir, "made-files.mjs");
await build({ entryPoints: ["src/made-files.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const f = await import(pathToFileURL(join(process.cwd(), out)).href);
rmSync(dir, { recursive: true, force: true });

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

/** The tool on a host that keeps what it is given; `send` says where a file went, or throws. */
function tool(send = async () => "Telegram") {
  const kept = [];
  const host = {
    turn: () => "turn-1",
    made: () => kept.length,
    keep: (turn, name, type, bytes) => (kept.push({ name, type, size: bytes.length }), { key: `k${kept.length}` }),
    send
  };
  const make = (input) => f.fileTools(host).make_file.execute(input, { toolCallId: "c", messages: [] });
  return { kept, make };
}

await test("a name loses its folders, quotes and control characters, and gets .md without an extension", () => {
  assert.equal(f.fileName("周末/计划"), "计划.md");
  assert.equal(f.fileName('..\\a"b<c>.csv'), "abc.csv");
  assert.equal(f.fileName("note.txt"), "note.txt");
  assert.equal(f.fileName("x".repeat(100)).length, 83);
  assert.equal(f.fileName(" / "), null);
  assert.equal(f.fileName(".."), null);
  assert.equal(f.fileType("a.md"), "text/markdown; charset=utf-8");
  assert.equal(f.fileType("a.HTML"), "text/html; charset=utf-8");
  assert.equal(f.fileType("a.weird"), "text/plain; charset=utf-8");
});

await test("make_file: at most 3 per reply, no empty or nameless file, and a failed send still keeps it for the web page", async () => {
  const { kept, make } = tool();
  assert.match((await make({ name: "", content: "x" })).error, /Give the file a name/);
  assert.match((await make({ name: "a.md", content: "  \n" })).error, /empty/);
  for (const name of ["a.md", "b.md", "c.md"]) assert.match((await make({ name, content: "x" })).note, /Sent to Telegram/);
  assert.match((await make({ name: "d.md", content: "x" })).error, /At most 3 files/);
  assert.deepEqual(kept.map((file) => file.name), ["a.md", "b.md", "c.md"]);

  const failing = tool(async () => {
    throw new Error("Telegram: Bad Request");
  });
  const made = await failing.make({ name: "plan", content: "# plan" });
  assert.deepEqual([made.made, made.size], ["plan.md", 6]);
  assert.match(made.note, /Not sent to their chat \(Telegram: Bad Request\); it shows under your reply/);
  assert.equal(failing.kept.length, 1);
  assert.match((await tool(async () => null).make({ name: "a.md", content: "x" })).note, /^Shown under your reply on the web page/);
});

await test("the files go with their reply; ones the media store let go of are left out and forgotten", () => {
  const db = new DatabaseSync(":memory:");
  const sql = (strings, ...values) => {
    const statement = db.prepare(strings.join("?"));
    return /^\s*SELECT/i.test(strings[0]) ? statement.all(...values) : (statement.run(...values), []);
  };
  sql`CREATE TABLE res_media (key TEXT PRIMARY KEY)`;
  const files = new f.MadeFiles(sql);
  for (const key of ["k1", "k2", "k3"]) sql`INSERT INTO res_media (key) VALUES (${key})`;
  files.add("turn-1", "k1", "a.md", 1);
  files.add("turn-1", "k2", "b.csv", 2);
  files.add("turn-2", "k3", "c.md", 3);
  assert.deepEqual([files.madeIn("turn-1"), files.madeIn("turn-2"), files.madeIn("turn-3")], [2, 1, 0]);
  files.withReply("turn-1", "m1");
  files.withReply("turn-2", "m2");
  files.withReply("turn-3", "m3");
  assert.equal(files.madeIn("turn-1"), 0, "done with once its reply has them");
  assert.deepEqual(Object.fromEntries(files.ofReplies(["m1", "m9"])), { m1: [{ key: "k1", name: "a.md", size: 1 }, { key: "k2", name: "b.csv", size: 2 }] });
  sql`DELETE FROM res_media WHERE key = ${"k1"}`;
  assert.deepEqual(files.ofReplies(["m1"]).get("m1").map((file) => file.key), ["k2"]);
  files.add("turn-4", "k4", "d.md", 4);
  assert.equal(files.get("k1"), null);
  assert.equal(files.get("k2").name, "b.csv");
});
