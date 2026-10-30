// Unit tests for the group chat's rules (src/group.ts). Usage: node test/group.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-group-"));
const out = join(dir, "group.mjs");
await build({ entryPoints: ["src/group.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const { HER, ROUND_IDLE, TURNS_DEFAULT, afterReply, cleanReply, groupConfig, groupConfigFrom, groupPrompt, groupRules, membersOf, mentionsIn, speakersFor, windowStart } = await import(pathToFileURL(join(process.cwd(), out)).href);
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
assert.deepEqual(mentionsIn("@麻薯 @旦九", members, "mochi"), ["default"], "a resident does not call itself");
console.log("PASS @ calls by name or id: the longest name, whole Latin words, either case, not inside an address or itself");

// Who answers a message of hers.
const defaults = groupConfig(null);
assert.deepEqual(defaults, { members: null, reply: "all", order: "list", turns: TURNS_DEFAULT });
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

// The settings from the web page.
const ids = ["default", "mochi", "kiki"];
assert.deepEqual(groupConfigFrom({ members: ["kiki", "default", "mochi"], reply: "one", order: "random", turns: 3 }, ids), { config: { members: null, reply: "one", order: "random", turns: 3 } }, "everyone ticked is everyone, new residents included");
assert.deepEqual(groupConfigFrom({ members: ["mochi"], reply: "all", order: "list", turns: 20 }, ids).config.members, ["mochi"]);
for (const bad of [{ members: [] }, { members: ["nobody"] }, { reply: "some" }, { order: "abc" }, { turns: 0 }, { turns: 21 }, { turns: 2.5 }, { members: undefined }]) {
  assert.ok("error" in groupConfigFrom({ members: ["mochi"], reply: "all", order: "list", turns: 6, ...bad }, ids), JSON.stringify(bad));
}
assert.deepEqual(membersOf({ ...defaults, members: ["kiki", "default"] }, ids), ["default", "kiki"], "in the sidebar's order");
assert.deepEqual(membersOf({ ...defaults, members: ["gone", "mochi"] }, ids), ["mochi"], "a deleted resident is not in it");
assert.deepEqual(groupConfig({ members: ["mochi"], reply: "x", order: 1, turns: 99 }), { members: ["mochi"], reply: "all", order: "list", turns: TURNS_DEFAULT }, "saved settings out of range fall back");
console.log("PASS the settings: checked, everyone ticked follows new residents, a deleted resident drops out");

// What a resident sees: its own lines as its turns, the others' with their names, hers without one.
const line = (seq, author, text, kind = "say") => ({ seq, author, text, at: seq, kind });
const names = { default: "旦九", mochi: "麻薯" };
assert.deepEqual(
  groupPrompt([line(1, HER, "今晚吃什么"), line(2, "default", "火锅"), line(3, HER, "停一下", "note"), line(4, "mochi", "我也要"), line(5, HER, "好")], false, "mochi", names),
  [
    { role: "user", content: "今晚吃什么\n\n[旦九] 火锅" },
    { role: "assistant", content: "我也要" },
    { role: "user", content: "好" }
  ],
  "the room's notes are not shown"
);
assert.deepEqual(groupPrompt([line(1, "mochi", "我先说"), line(2, "default", "嗯")], true, "mochi", names)[0], { role: "user", content: "(Earlier messages of this group are not shown.)" });
assert.equal(groupPrompt([line(1, "mochi", "我先说")], false, "mochi", names)[0].role, "user", "it starts with a message to it");
assert.deepEqual(groupPrompt([line(1, HER, "在吗"), line(2, "mochi", "在")], false, "mochi", names).at(-1), { role: "user", content: "(Your turn again.)" });
const long = groupPrompt([line(1, HER, "长".repeat(2500))], false, "mochi", names)[0].content;
assert.match(long, /…\(cut here: 2500 characters in all\)$/);
assert.equal(windowStart(60), 0);
assert.equal(windowStart(61), 30);
assert.equal(windowStart(90), 30, "the window starts at the same line for 30 lines");
assert.equal(windowStart(91), 60);
assert.match(groupRules("麻薯", ["旦九"]), /^You are 麻薯, in a group chat on the web door with the person you live with and another resident: 旦九\./);
assert.match(groupRules("麻薯", ["旦九", "Kiki"]), /other residents: 旦九, Kiki\./);
assert.equal(groupRules("麻薯", []).split("\n")[0], "You are 麻薯, in a group chat on the web door with the person you live with.", "alone with her");
console.log("PASS what a resident sees: its own turns, the others named, notes left out, cut where it says so, moved 30 lines at a time");

// What a reply does to the round.
const round = { ...ROUND_IDLE, root: 5, queue: ["mochi"], calls: 1, running: true };
assert.deepEqual(afterReply(round, { root: 5, speaker: "default", text: "@Kiki @麻薯 你们说" }, members, 6).round.queue, ["mochi", "kiki"], "those it calls join the line, once each");
assert.deepEqual(afterReply(round, { root: 4, speaker: "default", text: "@Kiki" }, members, 6), { round, note: "" }, "a reply to an earlier round calls no one");
assert.deepEqual(afterReply({ ...round, calls: 6 }, { root: 5, speaker: "default", text: "嗯" }, members, 6), { round: { ...round, calls: 6, queue: [] }, note: "这一轮说了 6 句，先停在这里。你再说一句就接着聊。" });
assert.equal(afterReply({ ...round, queue: [], calls: 6 }, { root: 5, speaker: "default", text: "嗯" }, members, 6).note, "", "at the cap with no one left: nothing to say");
console.log("PASS a reply: those it calls join this round only; the cap ends a round with someone still in line, saying so");

assert.equal(cleanReply("SKIP", "麻薯"), "");
assert.equal(cleanReply(" skip. ", "麻薯"), "");
assert.equal(cleanReply("[麻薯] 我也去", "麻薯"), "我也去");
assert.equal(cleanReply("麻薯：我也去", "麻薯"), "我也去");
assert.equal(cleanReply("SKIP 这个词我不懂", "麻薯"), "SKIP 这个词我不懂", "only SKIP alone passes");
assert.equal(cleanReply("[a.b] 嗯", "a.b"), "嗯", "its name is taken as it is, not as a pattern");
console.log("PASS a reply: SKIP passes, its own name in front is taken off");
