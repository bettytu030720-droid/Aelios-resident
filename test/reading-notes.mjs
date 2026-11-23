import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { build } from "esbuild";

const { outputFiles: [bundle] } = await build({
  entryPoints: ["src/web/reading.ts"], bundle: true, platform: "node", format: "esm", write: false
});
const { annotationPrompt, passageIn, readingDocument, ReadingNotes } =
  await import("data:text/javascript;base64," + Buffer.from(bundle.contents).toString("base64"));

const source = new TextEncoder().encode("# 标题\n\n- 第一段\n- 第二段\n\n结尾");

test("the model sees Markdown blocks while the stored quote keeps DOM offsets", async () => {
  const doc = await readingDocument("test", "read.md", source);
  assert.equal(doc.text, "标题第一段第二段结尾");
  const passage = passageIn(doc, { start: 5, end: 8, quote: "第二段" });
  assert.deepEqual(JSON.parse(annotationPrompt(doc, passage)), {
    title: "read.md", before: "标题\n第一段", passage: "第二段", after: "结尾"
  });
});

test("old offsets are reused only when the saved quote still matches", async t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const sql = (strings, ...values) => db.prepare(strings.join("?")).all(...values).map(row => ({ ...row }));
  const notes = new ReadingNotes(sql);
  const file = { key: "f".repeat(32) };
  const doc = await readingDocument(JSON.stringify(file), "read.md", source);
  const passage = passageIn(doc, { start: 5, end: 8, quote: "第二段" });
  const saved = await notes.add(doc, passage, () => "A complete note");
  assert.deepEqual(await notes.add(doc, passage, () => assert.fail("note was already saved")), saved);

  db.prepare("UPDATE res_reading_notes SET quote = ?").run("旧引文");
  assert.deepEqual(notes.list(doc), []);
  const fresh = await notes.add(doc, passage, () => "A corrected note");
  assert.equal(fresh.note, "A corrected note");
  assert.deepEqual(notes.list(doc), [fresh]);
  notes.remove(file);
  assert.deepEqual(notes.list(doc), []);
});
