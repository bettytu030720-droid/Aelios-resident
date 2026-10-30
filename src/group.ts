// Group chats (多住户二期): on the web door she makes groups of some of her residents and talks with them there.
// The groups live in the default resident, which decides who speaks (Resident.groupTurn). As in sakios's group
// chat, what is said in a group goes into each member's own conversation: on a member's turn, everything said
// there since it last spoke is handed to it as one message (groupHeard), it answers in its own conversation, with
// its own persona, model, tools and Aelios memory (Resident.groupHear), and its answer is posted to the group. So
// a member sees the group's context in its own chat, keeps it in memory, and can talk about it in private later.
// From mist's group chat design (docs/design/group-chat-phase-0.md in mist-agent-harness/mist-agent, AGPL like
// this repository):
// - The group decides who speaks, not the residents: @ calls only those named, otherwise the group's setting says
//   who. Residents do not call each other, so a message of hers gets at most one reply from each member.
// - Stopping is a separate button that does not wait in line.
// - A member is shown a bounded number of lines, cut where it says so.

import { SKIP } from "./prompts";
import type { Sql } from "./sticker-store";

/** The author of her lines; a resident's id starts with a letter. */
export const HER = "";
export const GROUP_TEXT_MAX = 4000;
export const GROUPS_MAX = 20;
export const GROUP_NAME_MAX = 30;
/** Lines the page gets at a time. */
export const GROUP_PAGE = 100;
// A member is handed at most the latest HEARD_MAX lines at once, each cut at LINE_MAX characters, saying so.
const HEARD_MAX = 60;
const LINE_MAX = 2000;

export type GroupConfig = {
  name: string;
  /** Its residents' ids. */
  members: string[];
  /** Who answers a message of hers that names no one: everyone, one of them (whoever spoke least lately), or no one. */
  reply: "all" | "one" | "none";
  /** The order they answer in: the sidebar's, or shuffled each time. */
  order: "list" | "random";
};
export type Group = GroupConfig & { id: string; at: number };

/** A line in a group: hers, a resident's, or a note from the group itself. */
export type GroupLine = { seq: number; author: string; text: string; at: number; kind: "say" | "note" };

/**
 * A group's round in progress: who is still to answer her latest message, who is answering now and since when.
 * `epoch` changes when a round that stopped moving is started again, so the old turn, if it ever comes back,
 * leaves the new round alone.
 */
export type GroupRound = { queue: string[]; speaking: string; since: number; epoch: number; running: boolean };
export const ROUND_IDLE: GroupRound = { queue: [], speaking: "", since: 0, epoch: 0, running: false };

export type Member = { id: string; name: string };

/**
 * A group's settings from the web page, checked against the residents there are. Who answers and in what order
 * have defaults; a name left empty is filled in by the caller.
 */
export function groupConfigFrom(body: Record<string, unknown>, ids: readonly string[]): { config: GroupConfig } | { error: string } {
  const name = String(body.name ?? "").trim();
  if (name.length > GROUP_NAME_MAX) return { error: `群名最多 ${GROUP_NAME_MAX} 个字` };
  const members = Array.isArray(body.members) ? [...new Set(body.members.map(String))] : [];
  if (members.length < 2 || members.some((id) => !ids.includes(id))) return { error: "一个群至少要两个住户，而且得是现有的住户" };
  const reply = body.reply ?? "all";
  const order = body.order ?? "list";
  if (reply !== "all" && reply !== "one" && reply !== "none") return { error: "没@人时谁回，没这个选项" };
  if (order !== "list" && order !== "random") return { error: "谁先说，没这个选项" };
  return { config: { name, members: membersOf({ members }, ids), reply, order } };
}

/** A group left without a name is called by its members' names. */
export function named(config: GroupConfig, people: readonly Member[]): GroupConfig {
  if (config.name) return config;
  return { ...config, name: config.members.map((id) => people.find((person) => person.id === id)?.name ?? id).join("、").slice(0, GROUP_NAME_MAX) };
}

/** The members still there, in the sidebar's order. */
export function membersOf(group: Pick<GroupConfig, "members">, ids: readonly string[]): string[] {
  return ids.filter((id) => group.members.includes(id));
}

/**
 * Whom a message calls with @, in the order they are called: a resident's name or id right after an @ (letters in
 * either case). The longest name wins, so @麻薯糖 is not @麻薯; a Latin name has to end there (@mochi2 is not
 * @mochi), and an @ inside a word (an email address) calls no one.
 */
export function mentionsIn(text: string, members: readonly Member[]): string[] {
  const keys = members
    .flatMap((member) => [member.name, member.id].map((key) => ({ id: member.id, key: key.trim().toLowerCase() })))
    .filter((entry) => entry.key)
    .sort((a, b) => b.key.length - a.key.length);
  const low = text.toLowerCase();
  const word = /[a-z0-9_]/;
  const called: string[] = [];
  for (let at = low.indexOf("@"); at >= 0; at = low.indexOf("@", at + 1)) {
    if (at > 0 && /[a-z0-9._]/.test(low[at - 1])) continue;
    const hit = keys.find(({ key }) => low.startsWith(key, at + 1) && !(word.test(key.at(-1) ?? "") && word.test(low[at + 1 + key.length] ?? "")));
    if (hit && !called.includes(hit.id)) called.push(hit.id);
  }
  return called;
}

/**
 * Who answers a message of hers: the members it calls (a message calling only residents outside the group gets no
 * answer), or as the group's settings say. `lastSaid` is each one's latest line there; `everyone` every resident.
 */
export function speakersFor(
  text: string,
  members: readonly Member[],
  config: Pick<GroupConfig, "reply" | "order">,
  lastSaid: Readonly<Record<string, number>>,
  { everyone = members, random = Math.random }: { everyone?: readonly Member[]; random?: () => number } = {}
): string[] {
  const called = mentionsIn(text, everyone);
  if (called.length) return called.filter((id) => members.some((member) => member.id === id));
  const ids = members.map((member) => member.id);
  if (config.order === "random") {
    for (let i = ids.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
  }
  if (config.reply === "all") return ids;
  if (config.reply === "one") return ids.length ? [[...ids].sort((a, b) => (lastSaid[a] ?? 0) - (lastSaid[b] ?? 0))[0]] : [];
  return [];
}

/** How a message handed to a member from a group starts, after its time stamp; the web page and search take it off. */
export const GROUP_HEAD = /^\[group chat "[^"\n]*"[^\n]*\]\n?/;

/**
 * What member `me` is handed on its turn in a group: what the others said there since it last spoke, oldest
 * first, hers without a name and the residents' with theirs. It goes into its own conversation as a message of
 * hers (not one of the system's notes), so Aelios recalls for it and records it.
 */
export function groupHeard(
  lines: readonly GroupLine[],
  cut: boolean,
  { group, me, others, names }: { group: string; me: string; others: readonly string[]; names: Readonly<Record<string, string>> }
): string {
  const plain = (text: string) => text.replace(/["\]\n]/g, " ");
  const company = others.map((name, i) => `${i === others.length - 1 ? " and" : ","} ${plain(name)}`).join("");
  const head = `[group chat "${plain(group)}" with them${company}, where you are ${plain(me)}. What was said there since you last spoke, oldest first; a line without a [name] is theirs. Your reply is posted there: write only your own message, or ${SKIP} to stay quiet]`;
  const said = lines.map((line) => {
    const text = line.text.length > LINE_MAX ? `${line.text.slice(0, LINE_MAX)}…(cut here: ${line.text.length} characters in all)` : line.text;
    return line.author === HER ? text : `[${names[line.author] ?? line.author}] ${text}`;
  });
  return [head, ...(cut ? ["(Earlier messages of this group are not shown.)"] : []), ...said].join("\n");
}

/** A member's reply as it goes into the group: without its name in front; "" when it passes. */
export function cleanReply(text: string, name: string): string {
  const own = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const said = text.trim().replace(new RegExp(`^(\\[${own}\\]|${own}[:：])\\s*`), "").trim();
  return new RegExp(`^${SKIP}[.!。！]?$`, "i").test(said) ? "" : said.slice(0, GROUP_TEXT_MAX);
}

type GroupRow = { id: string; name: string; members: string; reply: GroupConfig["reply"]; ord: GroupConfig["order"]; seen: string; round: string; at: number };
export type StoredGroup = Group & { seen: Record<string, number>; round: GroupRound };

/** The groups and what was said in them, in the default resident's SQLite. */
export class GroupStore {
  constructor(private readonly sql: Sql) {
    sql`CREATE TABLE IF NOT EXISTS grp_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, members TEXT NOT NULL, reply TEXT NOT NULL, ord TEXT NOT NULL, seen TEXT NOT NULL, round TEXT NOT NULL, at INTEGER NOT NULL)`;
    sql`CREATE TABLE IF NOT EXISTS grp_said (seq INTEGER PRIMARY KEY AUTOINCREMENT, grp TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL)`;
    sql`CREATE INDEX IF NOT EXISTS grp_said_by_group ON grp_said (grp, seq)`;
  }

  private group(row: GroupRow): StoredGroup {
    return {
      id: row.id,
      name: row.name,
      members: JSON.parse(row.members) as string[],
      reply: row.reply,
      order: row.ord,
      at: row.at,
      seen: JSON.parse(row.seen) as Record<string, number>,
      round: { ...ROUND_IDLE, ...(JSON.parse(row.round) as Partial<GroupRound>) }
    };
  }

  list(): StoredGroup[] {
    return this.sql<GroupRow>`SELECT * FROM grp_groups ORDER BY at`.map((row) => this.group(row));
  }

  get(id: string): StoredGroup | null {
    const [row] = this.sql<GroupRow>`SELECT * FROM grp_groups WHERE id = ${id}`;
    return row ? this.group(row) : null;
  }

  create(config: GroupConfig): Group {
    const id = `g${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const at = Date.now();
    this.sql`INSERT INTO grp_groups (id, name, members, reply, ord, seen, round, at) VALUES (${id}, ${config.name}, ${JSON.stringify(config.members)}, ${config.reply}, ${config.order}, '{}', '{}', ${at})`;
    return { ...config, id, at };
  }

  update(id: string, config: GroupConfig): void {
    this.sql`UPDATE grp_groups SET name = ${config.name}, members = ${JSON.stringify(config.members)}, reply = ${config.reply}, ord = ${config.order} WHERE id = ${id}`;
  }

  /** A group and everything said in it; what its members heard stays in their own conversations. */
  remove(id: string): void {
    this.sql`DELETE FROM grp_said WHERE grp = ${id}`;
    this.sql`DELETE FROM grp_groups WHERE id = ${id}`;
  }

  setRound(id: string, round: GroupRound): void {
    this.sql`UPDATE grp_groups SET round = ${JSON.stringify(round)} WHERE id = ${id}`;
  }

  /** The latest line `member` has been handed. */
  setSeen(id: string, member: string, seq: number): void {
    const group = this.get(id);
    if (group) this.sql`UPDATE grp_groups SET seen = ${JSON.stringify({ ...group.seen, [member]: seq })} WHERE id = ${id}`;
  }

  add(grp: string, author: string, text: string, kind: GroupLine["kind"] = "say"): GroupLine {
    const at = Date.now();
    const [row] = this.sql<{ seq: number }>`INSERT INTO grp_said (grp, author, text, at, kind) VALUES (${grp}, ${author}, ${text}, ${at}, ${kind}) RETURNING seq`;
    return { seq: row.seq, author, text, at, kind };
  }

  /** Lines after the one the page has, oldest first. */
  after(grp: string, seq: number): GroupLine[] {
    return this.sql<GroupLine>`SELECT seq, author, text, at, kind FROM grp_said WHERE grp = ${grp} AND seq > ${seq} ORDER BY seq LIMIT ${GROUP_PAGE}`;
  }

  /** The latest lines, or the ones before `before`, oldest first; `more` when there are earlier ones. */
  page(grp: string, before: number | null): { lines: GroupLine[]; more: boolean } {
    const rows = this.sql<GroupLine>`SELECT seq, author, text, at, kind FROM grp_said WHERE grp = ${grp} AND seq < ${before ?? Number.MAX_SAFE_INTEGER} ORDER BY seq DESC LIMIT ${GROUP_PAGE + 1}`;
    return { lines: rows.slice(0, GROUP_PAGE).reverse(), more: rows.length > GROUP_PAGE };
  }

  /** The latest line of each group, for the list. */
  latest(): Record<string, GroupLine> {
    const rows = this.sql<GroupLine & { grp: string }>`SELECT s.grp, s.seq, s.author, s.text, s.at, s.kind FROM grp_said s JOIN (SELECT MAX(seq) AS seq FROM grp_said GROUP BY grp) m ON s.seq = m.seq`;
    return Object.fromEntries(rows.map(({ grp, ...line }) => [grp, line]));
  }

  /**
   * What `member` has not heard: the things others said after line `since` (not the group's notes), the latest
   * HEARD_MAX of them; `cut` when earlier ones are left out; `last` is the group's latest line.
   */
  unheard(grp: string, member: string, since: number): { lines: GroupLine[]; cut: boolean; last: number } {
    const rows = this.sql<GroupLine>`SELECT seq, author, text, at, kind FROM grp_said WHERE grp = ${grp} AND seq > ${since} AND kind = 'say' AND author != ${member} ORDER BY seq DESC LIMIT ${HEARD_MAX + 1}`;
    const [{ last }] = this.sql<{ last: number | null }>`SELECT MAX(seq) AS last FROM grp_said WHERE grp = ${grp}`;
    return { lines: rows.slice(0, HEARD_MAX).reverse(), cut: rows.length > HEARD_MAX, last: last ?? since };
  }

  /** The groups for the web page: each with its members still there (of `ids`) and its latest line. */
  views(ids: readonly string[]): (GroupConfig & { id: string; last: GroupLine | null; running: boolean })[] {
    const latest = this.latest();
    return this.list().map((group) => ({ ...this.settingsOf(group, ids), last: latest[group.id] ?? null, running: group.round.running }));
  }

  /** A group for the web page: its latest lines (or those after `after`, or before `before`), its settings, who speaks. */
  view(id: string, ids: readonly string[], after: number | null, before: number | null): Record<string, unknown> {
    const group = this.get(id);
    if (!group) return { error: "没有这个群" };
    const page = after !== null ? { lines: this.after(id, after), more: false } : this.page(id, before);
    return { ...page, group: this.settingsOf(group, ids), speaking: group.round.speaking, waiting: group.round.queue, running: group.round.running };
  }

  private settingsOf(group: StoredGroup, ids: readonly string[]): GroupConfig & { id: string } {
    return { id: group.id, name: group.name, members: membersOf(group, ids), reply: group.reply, order: group.order };
  }

  /** Stop: no one still in line answers. The one answering now finishes; its answer is already in its own chat. */
  stop(id: string): { ok: true } | { error: string } {
    const group = this.get(id);
    if (!group) return { error: "没有这个群" };
    if (group.round.queue.length || group.round.speaking) {
      this.setRound(id, { ...group.round, queue: [] });
      this.add(id, HER, "你让大家先停一下。", "note");
    }
    return { ok: true };
  }

  /** Each resident's latest line in a group, for whose turn it is when one answers. */
  lastSaid(grp: string): Record<string, number> {
    const rows = this.sql<{ author: string; seq: number }>`SELECT author, MAX(seq) AS seq FROM grp_said WHERE grp = ${grp} AND kind = 'say' AND author != '' GROUP BY author`;
    return Object.fromEntries(rows.map((row) => [row.author, row.seq]));
  }
}
