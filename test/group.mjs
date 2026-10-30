// Unit tests for the group chats (src/group.ts): the rules and the store. Usage: node test/group.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-group-"));
const out = join(dir, "group.mjs");
const via = join(dir, "via-aelios.mjs");
await build({ entryPoints: ["src/group.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
await build({ entryPoints: ["src/via-aelios.ts"], bundle: true, platform: "node", format: "esm", outfile: via, logLevel: "error" });
const { GROUP_HEAD, GroupStore, HER, ROUND_IDLE, afterTurn, cleanReply, groupConfigFrom, groupHeard, membersOf, mentionsIn, speakersFor } = await import(pathToFileURL(join(process.cwd(), out)).href);
const { isAuxiliary } = await import(pathToFileURL(join(process.cwd(), via)).href);
rmSync(dir, { recursive: true, force: true });

const members = [
  { id: "default", name: "旦九" },
  { id: "mochi", name: "麻薯" },
  { id: "mochi-sugar", name: "麻薯糖" },
  { id: "kiki", name: "Kiki" }
];

// @ calls by name or id, the longest name first, a Latin name only as a whole word, never inside an address.
assert.deepEqual(mentionsIn("@麻薯糖 你先", members), ["mochi-sugar"]);
assert.deepEqual(mentionsIn("@麻薯你说呢", members), ["mochi"], "a Chinese name needs no space after it");
assert.deepEqual(mentionsIn("@kiki 和 @旦九，还有 @KIKI", members), ["kiki", "default"], "either case, each once, in the order called");
assert.deepEqual(mentionsIn("@kikis 不是她，@mochi-sugar 是", members), ["mochi-sugar"]);
assert.deepEqual(mentionsIn("写信到 me@kiki.com，提到麻薯", members), [], "an address or a name without @ calls no one");
console.log("PASS @ calls by name or id: the longest name, whole Latin words, either case, not inside an address");

// Who answers a message of hers.
const defaults = { reply: "all", order: "list" };
const two = members.slice(0, 2);
assert.deepEqual(speakersFor("大家好", two, defaults, {}), ["default", "mochi"], "everyone, in the sidebar's order");
assert.deepEqual(speakersFor("@麻薯 你呢", two, defaults, {}), ["mochi"], "@ calls only those named");
assert.deepEqual(speakersFor("大家好", two, { ...defaults, reply: "none" }, {}), []);
assert.deepEqual(speakersFor("@旦九", two, { ...defaults, reply: "none" }, {}), ["default"], "@ still calls");
assert.deepEqual(speakersFor("大家好", two, { ...defaults, reply: "one" }, {}), ["default"], "one: the first who has not spoken");
assert.deepEqual(speakersFor("大家好", two, { ...defaults, reply: "one" }, { default: 5, mochi: 3 }), ["mochi"], "one: whoever spoke least lately");
assert.deepEqual(speakersFor("大家好", members, { ...defaults, order: "random" }, {}, { random: () => 0 }), ["mochi", "mochi-sugar", "kiki", "default"], "shuffled");
assert.deepEqual(speakersFor("@Kiki 你呢", two, defaults, {}, { everyone: members }), [], "calling only someone outside the group calls no one");
assert.deepEqual(speakersFor("@Kiki @麻薯", two, defaults, {}, { everyone: members }), ["mochi"]);
console.log("PASS who answers: everyone in order, only those called (in the group), one in turn, no one, shuffled");

// A group's settings from the web page.
const ids = ["default", "mochi", "kiki"];
assert.deepEqual(groupConfigFrom({ name: " 周末 ", members: ["kiki", "default", "kiki"] }, ids), { config: { name: "周末", members: ["default", "kiki"], reply: "all", order: "list", rounds: 3 } }, "who answers and how many rounds have defaults; the members in the sidebar's order, once each");
assert.deepEqual(groupConfigFrom({ members: ["mochi", "kiki"], reply: "one", order: "random", rounds: "5" }, ids).config, { name: "", members: ["mochi", "kiki"], reply: "one", order: "random", rounds: 5 }, "a name left empty is the caller's to fill");
for (const bad of [{ members: ["mochi"] }, { members: ["mochi", "nobody"] }, { members: "mochi,kiki" }, { reply: "some" }, { order: "abc" }, { name: "长".repeat(31) }, { rounds: 0 }, { rounds: 6 }, { rounds: 1.5 }]) {
  assert.ok("error" in groupConfigFrom({ members: ["mochi", "kiki"], ...bad }, ids), JSON.stringify(bad));
}
assert.deepEqual(membersOf({ members: ["kiki", "gone", "default"] }, ids), ["default", "kiki"], "a deleted resident is not in it; the sidebar's order");
console.log("PASS a group's settings: at least two residents there are, defaults for who answers and the rounds, checked");

// What a member is handed on its turn: what the others said since it last spoke, hers without a name.
const line = (seq, author, text) => ({ seq, author, text, at: seq, kind: "say" });
const names = { default: "旦九", mochi: "麻薯", kiki: "Kiki" };
const at = { names, round: 1, rounds: 3 };
const heard = groupHeard([line(1, HER, "今晚吃什么"), line(2, "default", "火锅")], false, { ...at, group: "周末", me: "麻薯", others: ["旦九", "Kiki"] });
assert.equal(
  heard,
  '[group chat "周末" with them, 旦九 and Kiki, where you are 麻薯. What was said there since you last spoke, oldest first; a line without a [name] is theirs. Your reply is posted there: write only your own message. This is round 1 of at most 3 on their latest message; if you have nothing more to add, reply with just SKIP to end]\n今晚吃什么\n[旦九] 火锅'
);
assert.match(groupHeard([line(1, HER, "在吗")], false, { ...at, round: 2, group: "两个人", me: "麻薯", others: ["旦九"] }), /^\[group chat "两个人" with them and 旦九, where you are 麻薯\..* This is round 2 of at most 3 /);
assert.match(groupHeard([line(9, HER, "嗯")], true, { ...at, group: "a", me: "麻薯", others: ["旦九"] }), /\]\n\(Earlier messages of this group are not shown\.\)\n嗯$/);
assert.match(groupHeard([line(1, HER, "长".repeat(2500))], false, { ...at, group: "a", me: "麻薯", others: ["旦九"] }), /…\(cut here: 2500 characters in all\)$/);
assert.match(groupHeard([], false, { ...at, group: 'a "b"]\nc', me: "麻薯", others: ["旦九"] }), /^\[group chat "a  b   c" with/, "a name cannot end the head early");
const marked = groupHeard(
  [{ ...line(1, HER, "看这个"), pictures: 2, stickers: [{ url: "/stickers/x", video: false, mark: "[sticker 🤗 A hug.]" }] }, { ...line(2, "default", ""), stickers: [{ url: "/stickers/y", video: false, mark: "[sticker 👋 Say hi.]" }] }],
  false,
  { ...at, group: "a", me: "麻薯", others: ["旦九"] }
);
assert.deepEqual(marked.split("\n").slice(1), ["看这个 [sticker 🤗 A hug.] [picture] [picture]", "[旦九] [sticker 👋 Say hi.]"], "stickers and pictures marked where they were");
// It is a message of hers, not one of the system's notes: Aelios recalls for it and records it.
const stamped = `[10-30 Fri 01:40] ${heard}`;
assert.equal(isAuxiliary({ messages: [{ role: "user", content: stamped }] }), false);
assert.equal(stamped.replace(/^\[\d\d-\d\d [^\]]*\]\s*/, "").replace(GROUP_HEAD, ""), "今晚吃什么\n[旦九] 火锅", "the web page shows only what was said");
console.log("PASS what a member is handed: who is there, hers without a name, the others with theirs, cut where it says so, recorded by Aelios");

// Rounds: when everyone in one has had a turn and someone said something, the next starts, up to the setting.
const round = { ...ROUND_IDLE, root: 5, order: ["default", "mochi"], queue: ["mochi"], running: true, speaking: "default" };
let after = afterTurn(round, { root: 5, said: true }, 3);
assert.deepEqual([after.n, after.queue, after.spoke, after.speaking, after.running], [1, ["mochi"], true, "", true], "the round goes on");
after = afterTurn({ ...after, queue: [] }, { root: 5, said: false }, 3);
assert.deepEqual([after.n, after.queue, after.spoke, after.running], [2, ["default", "mochi"], false, true], "someone spoke: the next round");
assert.deepEqual(afterTurn({ ...after, queue: [] }, { root: 5, said: false }, 3).running, false, "no one spoke in it: it ends");
assert.deepEqual(afterTurn({ ...round, queue: [], n: 3 }, { root: 5, said: true }, 3).running, false, "not past the setting");
assert.deepEqual(afterTurn({ ...round, queue: [] }, { root: 4, said: true }, 3).running, false, "a reply to her earlier message does not count for this one");
assert.deepEqual(afterTurn({ ...round, queue: [], order: [] }, { root: 5, said: true }, 3).running, false, "stopped: no new round");
console.log("PASS rounds: the next one starts when someone spoke, up to the setting; her new message and stop are respected");

assert.equal(cleanReply("SKIP", "麻薯"), "");
assert.equal(cleanReply(" skip. ", "麻薯"), "");
assert.equal(cleanReply("[麻薯] 我也去", "麻薯"), "我也去");
assert.equal(cleanReply("麻薯：我也去", "麻薯"), "我也去");
assert.equal(cleanReply("SKIP 这个词我不懂", "麻薯"), "SKIP 这个词我不懂", "only SKIP alone passes");
assert.equal(cleanReply("[a.b] 嗯", "a.b"), "嗯", "its name is taken as it is, not as a pattern");
console.log("PASS a reply: SKIP passes, its own name in front is taken off");

// The store: groups, lines by group, and what each member has not heard.
const db = new DatabaseSync(":memory:");
const sql = (strings, ...values) => db.prepare(strings.join("?")).all(...values);
const store = new GroupStore(sql);
const weekend = store.create({ name: "周末", members: ["default", "mochi"], reply: "all", order: "list", rounds: 3 });
const work = store.create({ name: "work", members: ["mochi", "kiki"], reply: "one", order: "list", rounds: 2 });
store.add(weekend.id, HER, "今晚吃什么");
store.add(work.id, HER, "开会");
store.add(weekend.id, "default", "火锅");
store.add(weekend.id, HER, "你让大家先停一下。", "note");
assert.deepEqual(store.list().map((g) => g.name), ["周末", "work"]);
assert.deepEqual(store.page(weekend.id, null).lines.map((l) => l.text), ["今晚吃什么", "火锅", "你让大家先停一下。"], "each group its own lines");
let unheard = store.unheard(weekend.id, "mochi", 0);
assert.deepEqual([unheard.lines.map((l) => l.text), unheard.cut, unheard.last], [["今晚吃什么", "火锅"], false, 4], "not the notes, not another group's");
assert.deepEqual(store.unheard(weekend.id, "default", 0).lines.map((l) => l.text), ["今晚吃什么"], "not its own");
store.setSeen(weekend.id, "mochi", unheard.last);
store.add(weekend.id, "mochi", "我也要");
store.add(weekend.id, HER, "好");
assert.deepEqual(store.unheard(weekend.id, "mochi", store.get(weekend.id).seen.mochi).lines.map((l) => l.text), ["好"], "only what came after it was last handed some");
for (let i = 0; i < 70; i += 1) store.add(work.id, HER, `第 ${i} 句`);
unheard = store.unheard(work.id, "kiki", 0);
assert.deepEqual([unheard.lines.length, unheard.cut, unheard.lines.at(-1).text], [60, true, "第 69 句"], "the latest 60, saying earlier ones are left out");
assert.deepEqual(store.lastSaid(weekend.id), { default: 3, mochi: 5 });
assert.deepEqual(Object.fromEntries(Object.entries(store.latest()).map(([id, l]) => [id, l.text])), { [weekend.id]: "好", [work.id]: "第 69 句" });
store.setRound(work.id, { ...ROUND_IDLE, root: 9, order: ["mochi", "kiki"], n: 2, queue: ["kiki"], speaking: "mochi", since: 1, epoch: 2, running: true });
assert.deepEqual(store.get(work.id).round, { root: 9, order: ["mochi", "kiki"], n: 2, queue: ["kiki"], spoke: false, speaking: "mochi", since: 1, epoch: 2, running: true });
store.update(work.id, { name: "工作", members: ["default", "kiki"], reply: "all", order: "random", rounds: 4 });
assert.deepEqual([store.get(work.id).name, store.get(work.id).members, store.get(work.id).order, store.get(work.id).rounds, store.get(work.id).round.speaking], ["工作", ["default", "kiki"], "random", 4, "mochi"], "settings change, the round stays");
// Pictures are kept as keys the page never sees; stickers as they are; an icon is some group's, or not.
const sticker = { url: "/r/mochi/stickers/" + "a".repeat(24), video: false, mark: "[sticker 🤗 A hug.]" };
const shown = store.add(work.id, HER, "看", "say", { pictures: ["k1", "k2"], stickers: [sticker] });
assert.deepEqual([shown.pictures, shown.stickers], [2, [sticker]]);
assert.ok(!JSON.stringify(store.page(work.id, null)).includes("k1"), "the page gets a count, not the keys");
assert.deepEqual(store.pictures(work.id, shown.seq), ["k1", "k2"]);
assert.equal(store.setIcon(work.id, "icon1"), "");
assert.deepEqual([store.isIcon("icon1"), store.isIcon("k1"), store.isIcon(""), store.views(["default", "kiki"]).find((g) => g.id === work.id).icon], [true, false, false, "/avatar/icon1"]);
assert.equal(store.setIcon(work.id, "icon2"), "icon1", "the old one is handed back to be thrown away");
assert.deepEqual(store.remove(work.id).sort(), ["icon2", "k1", "k2"], "its icon and pictures are handed back too");
assert.deepEqual([store.get(work.id), store.list().length, store.page(work.id, null).lines.length], [null, 1, 0], "a group goes with its lines");
// A table from the first group chats gets the new columns.
const old = new DatabaseSync(":memory:");
const oldSql = (strings, ...values) => old.prepare(strings.join("?")).all(...values);
oldSql`CREATE TABLE grp_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, members TEXT NOT NULL, reply TEXT NOT NULL, ord TEXT NOT NULL, seen TEXT NOT NULL, round TEXT NOT NULL, at INTEGER NOT NULL)`;
oldSql`CREATE TABLE grp_said (seq INTEGER PRIMARY KEY AUTOINCREMENT, grp TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL)`;
oldSql`INSERT INTO grp_groups VALUES ('g1', '老群', '["default","mochi"]', 'all', 'list', '{}', '{"queue":[],"speaking":"","since":0,"epoch":3,"running":false}', 1)`;
oldSql`INSERT INTO grp_said (grp, author, text, at, kind) VALUES ('g1', '', '以前的话', 1, 'say')`;
const upgraded = new GroupStore(oldSql);
assert.deepEqual([upgraded.get("g1").rounds, upgraded.get("g1").icon, upgraded.get("g1").round.n, upgraded.get("g1").round.epoch, upgraded.page("g1", null).lines[0].text], [3, "", 1, 3, "以前的话"]);
new GroupStore(oldSql);
console.log("PASS the store: groups kept apart, notes and its own lines not handed back, only what is new, the latest 60, pictures as hidden keys, stickers, icons, removed with what it held, an old table upgraded once");
