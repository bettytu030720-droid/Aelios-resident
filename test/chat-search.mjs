// Unit tests for searching the conversation (src/chat-search.ts). Usage: node test/chat-search.mjs
// The quick LIKE on the stored JSON must let through every message the search then finds in its text, so a message
// is never left out before it is looked at. Checked on Node's SQLite, whose LIKE is the one the resident runs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-chat-search-"));
const out = join(dir, "chat-search.mjs");
await build({ entryPoints: ["src/chat-search.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const { fold, hitIn, searchQuery, searchable, storedLike } = await import(pathToFileURL(join(process.cwd(), out)).href);
rmSync(dir, { recursive: true, force: true });

// The marks the resident takes out of her messages (src/resident.ts, voice.ts, refused-pictures.ts).
const MARKS = [
  /\[evicted image\/[^\]]*\]/g,
  /\[Picture taken out unseen: [^\]]*\]/g,
  /^\[\d\d-\d\d [^\]]*\]\s*/,
  /^\[replying to (?:your|their own) message: "[^\]]*"\]\n?/,
  /\[sticker [^\]]*\]\n?/,
  /\[voice(?: (\d+:\d\d))?(, could not be heard)?\]/g
];

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE m (id TEXT, content TEXT)");
const insert = db.prepare("INSERT INTO m (id, content) VALUES (?, ?)");
const like = db.prepare("SELECT content LIKE ? ESCAPE '\\' AS hit FROM m WHERE id = ?");
let rows = 0;
/** A message stored the way the session stores it: the message as JSON. */
function store(parts, role = "user") {
  const id = `m${++rows}`;
  insert.run(id, JSON.stringify({ id, role, parts: parts.map((text) => ({ type: "text", text })), metadata: { at: 1 } }));
  return { id, parts, role };
}
function check(message, raw) {
  const asked = searchQuery(raw);
  if ("error" in asked) return null;
  const search = searchable(message.parts, message.role === "user" ? MARKS : []);
  const hit = hitIn({ id: message.id, role: message.role, text: "", at: 1 }, search, asked.query);
  const sql = like.get(storedLike(asked.query), message.id).hit === 1;
  return { hit, sql };
}
function mustFind(message, raw) {
  const result = check(message, raw);
  assert.ok(result.hit, `${JSON.stringify(raw)} is in ${JSON.stringify(message.parts)}`);
  assert.ok(result.sql, `the LIKE lets ${JSON.stringify(message.parts)} through for ${JSON.stringify(raw)}: ${storedLike(searchQuery(raw).query)}`);
  return result.hit;
}

// Every character folds to one character of the same length, so a hit's place in the folded text is its place in
// the text; and a character the LIKE takes literally matches exactly the characters the search folds together with it.
const groups = new Map();
for (let cp = 0; cp <= 0x10ffff; cp += 1) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const c = String.fromCodePoint(cp);
  const f = fold(c);
  assert.equal(f.length, c.length, `U+${cp.toString(16)}`);
  assert.equal([...f].length, 1, `U+${cp.toString(16)}`);
  if (!groups.has(f)) groups.set(f, []);
  groups.get(f).push(c);
}
for (const members of groups.values()) {
  if (members.length < 2) continue;
  for (const q of members) {
    if (storedLike(q) === "%_%") continue;
    for (const s of members) {
      if (s !== q) assert.ok(q.charCodeAt(0) < 0x80 && s.charCodeAt(0) < 0x80, `${q} and ${s} fold together, so ${q} is not taken literally`);
    }
  }
}
console.log("PASS every character folds to one of the same length; the LIKE takes literally only what it matches exactly");

// Her review: across a line break, across a run of spaces, and a letter outside ASCII in the other case.
assert.equal(mustFind(store(["hello\nworld"]), "hello world").match, "hello world");
mustFind(store(["hello  world"]), "hello world");
mustFind(store(["CAFÉ"]), "café");
mustFind(store(["café"]), "CAFÉ");
mustFind(store(["Ελληνικά ΣΟΦΙΑ"]), "σοφια");
mustFind(store(["ПРИВЕТ, мир"]), "привет");
mustFind(store(["tab\there", "nbsp\u00a0there"]), "tab here");
mustFind(store(["tab\there", "nbsp\u00a0there"]), "nbsp there");
mustFind(store(['她说"蓝月亮"\n记得 100% 带伞_明天 D:\\照片']), '"蓝月亮" 记得 100% 带伞_明天 D:\\照片');
mustFind(store(["emoji 🐱🐶 here"]), "🐱🐶");
mustFind(store(["𐐀𐐁 Deseret"]), "𐐨𐐩");
mustFind(store(["İstanbul"]), "İstanbul");
mustFind(store(["5 \u212a"]), "5 \u212a");
console.log("PASS line breaks and runs of spaces, letters outside ASCII in either case, quotes, backslashes, % and _");

// The parts of a message and the marks taken out of it each leave a space, so words never run across them.
const parted = store(["前半", "后半"], "assistant");
assert.equal(check(parted, "前半后半").hit, null, "not across two parts");
mustFind(parted, "前半 后半");
const marked = store(["[10-29 周四 22:57] [replying to your message: \"引用里的字\"]\n开头[sticker cat]结尾 [voice 0:03] 说完"]);
assert.equal(check(marked, "引用里的字").hit, null, "a quote is not her words");
assert.equal(check(marked, "周四").hit, null, "nor the time stamp");
assert.equal(check(marked, "开头结尾").hit, null, "a sticker leaves a space");
assert.equal(check(marked, "sticker").hit, null);
mustFind(marked, "开头 结尾 说完");
const hit = mustFind(marked, "开头");
assert.deepEqual([hit.before, hit.match, hit.after], ["", "开头", " 结尾 说完"]);
console.log("PASS not across parts or the marks only the model reads, which are not searched");

// Many words from many messages, in any case: whatever the search finds, the LIKE lets through.
let seed = 7;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const alphabet = ["a", "B", "ç", "Ö", "ß", "ẞ", "σ", "Σ", "ς", "д", "Д", "猫", "说", "1", "%", "_", "\\", '"', "'", "🐱", "𐐀", "𐐨", "\u212a", "k", "İ", "i", " ", "  ", "\n", "\t", "\u00a0", "\u3000"];
let found = 0;
for (let n = 0; n < 400; n += 1) {
  const parts = Array.from({ length: 1 + Math.floor(random() * 3) }, () => Array.from({ length: 4 + Math.floor(random() * 20) }, () => alphabet[Math.floor(random() * alphabet.length)]).join(""));
  const message = store(parts, random() < 0.5 ? "user" : "assistant");
  const flat = searchable(parts, message.role === "user" ? MARKS : []).replace(/\s+/g, " ").trim();
  const chars = [...flat];
  for (let k = 0; k < 6 && chars.length; k += 1) {
    const from = Math.floor(random() * chars.length);
    const words = chars.slice(from, from + 1 + Math.floor(random() * 8)).map((c) => (random() < 0.5 ? c.toUpperCase() : c.toLowerCase())).join("");
    const result = check(message, words);
    if (!result) continue;
    if (result.hit) {
      found += 1;
      assert.ok(result.sql, `the LIKE lets ${JSON.stringify(parts)} through for ${JSON.stringify(words)}`);
    }
  }
}
assert.ok(found > 1000, `enough words found to mean something: ${found}`);
console.log(`PASS ${found} searches over 400 random messages: every message the search finds, the LIKE lets through`);
