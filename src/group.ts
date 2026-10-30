// Group chats (多住户二期): on the web door she makes groups of some of her residents and talks with them there.
// The groups live in the default resident, which decides who speaks (Resident.groupTurn). As in sakios's group
// chat, what is said in a group goes into each member's own conversation: on a member's turn, everything said
// there since it last spoke is handed to it as one message (groupHeard), it answers in its own conversation, with
// its own persona, model, tools and Aelios memory (Resident.groupHear), and its answer is posted to the group. So
// a member sees the group's context in its own chat, keeps it in memory, and can talk about it in private later.
// From mist's group chat design (docs/design/group-chat-phase-0.md in mist-agent-harness/mist-agent, AGPL like
// this repository):
// - The group decides who speaks, not the residents: @ calls only those named, otherwise the group's setting says
//   who. Residents do not call each other; after everyone has had a turn, those who have something new to hear get
//   another, for at most `rounds` rounds (3 unless set), and a round in which no one says anything ends it.
// - Stopping is a separate button that does not wait in line.
// - A member is shown a bounded number of lines, cut where it says so.

import { SKIP } from "./prompts";
import type { Sql } from "./sticker-store";

/** The author of her lines; a resident's id starts with a letter. */
export const HER = "";
export const GROUP_TEXT_MAX = 4000;
export const GROUPS_MAX = 20;
export const GROUP_NAME_MAX = 30;
export const ROUNDS_DEFAULT = 3;
export const ROUNDS_MAX = 5;
/** Pictures in one message of hers, as in the chat. */
export const GROUP_PICTURES_MAX = 4;
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
  /** How many rounds one message of hers can lead to. */
  rounds: number;
};
export type Group = GroupConfig & { id: string; at: number; icon: string };
/** A group as the web page gets it: its icon's address, not its key. */
export type GroupView = GroupConfig & { id: string; icon: string | null };

/** A sticker in a group: where the page shows it from, and how the residents read it. */
export type GroupSticker = { url: string; video: boolean; mark: string };
/** A line in a group: hers, a resident's, or a note from the group itself; with how many pictures and its stickers. */
export type GroupLine = { seq: number; author: string; text: string; at: number; kind: "say" | "note"; pictures?: number; stickers?: GroupSticker[] };

/**
 * A group's rounds on her latest message (`root`): who answers it (`order`), which round it is (`n`), who is still
 * to answer in this one, whether anyone said something in it, who is answering now and since when. `epoch`
 * changes when a round that stopped moving is started again, so the old turn, if it ever comes back, leaves the
 * new round alone.
 */
export type GroupRound = { root: number; order: string[]; n: number; queue: string[]; spoke: boolean; speaking: string; since: number; epoch: number; running: boolean };
export const ROUND_IDLE: GroupRound = { root: 0, order: [], n: 1, queue: [], spoke: false, speaking: "", since: 0, epoch: 0, running: false };

/**
 * After a member's turn in round `round` on her message `root`: whether it said something counts for this round
 * only; when everyone in it has had a turn and someone said something, the next round starts, up to `rounds`.
 */
export function afterTurn(round: GroupRound, turn: { root: number; said: boolean }, rounds: number): GroupRound {
  const next = { ...round, speaking: "", spoke: round.spoke || (turn.said && turn.root === round.root) };
  if (!next.queue.length && next.spoke && next.n < rounds && next.order.length) Object.assign(next, { n: next.n + 1, queue: next.order, spoke: false });
  return { ...next, running: next.queue.length > 0 };
}

export type Member = { id: string; name: string };

/**
 * A group's settings from the web page, checked against the residents there are. Who answers, in what order and
 * for how many rounds have defaults; a name left empty is filled in by the caller.
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
  const rounds = Number(body.rounds ?? ROUNDS_DEFAULT);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > ROUNDS_MAX) return { error: `最多说几轮，要 1 到 ${ROUNDS_MAX}` };
  return { config: { name, members: membersOf({ members }, ids), reply, order, rounds } };
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
 * first, each line after who said it ([them] for her), stickers and pictures marked (the pictures go with it).
 * It goes into its own conversation as a message of hers (not one of the system's notes), so Aelios recalls for it
 * and records it.
 */
export function groupHeard(
  lines: readonly GroupLine[],
  cut: boolean,
  { group, me, others, names, round, rounds }: { group: string; me: string; others: readonly string[]; names: Readonly<Record<string, string>>; round: number; rounds: number }
): string {
  const plain = (text: string) => text.replace(/["\]\n]/g, " ");
  const company = others.map((name, i) => `${i === others.length - 1 ? " and" : ","} ${plain(name)}`).join("");
  const head = `[group chat "${plain(group)}" with them${company}, where you are ${plain(me)}. What was said there since you last spoke, oldest first, each line after who said it ([them] is them). Your reply is posted there: write only your own message. This is round ${round} of at most ${rounds} on their latest message; if you have nothing more to add, reply with just ${SKIP} to end]`;
  const said = lines.map((line) => {
    const words = line.text.length > LINE_MAX ? `${line.text.slice(0, LINE_MAX)}…(cut here: ${line.text.length} characters in all)` : line.text;
    const text = [words, ...(line.stickers ?? []).map((sticker) => sticker.mark), ...Array(line.pictures ?? 0).fill("[picture]")].filter(Boolean).join(" ");
    return `[${line.author === HER ? "them" : (names[line.author] ?? line.author)}] ${text}`;
  });
  return [head, ...(cut ? ["(Earlier messages of this group are not shown.)"] : []), ...said].join("\n");
}

/** A member's reply as it goes into the group: without its name in front; "" when it passes. */
export function cleanReply(text: string, name: string): string {
  const own = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const said = text.trim().replace(new RegExp(`^(\\[${own}\\]|${own}[:：])\\s*`), "").trim();
  return new RegExp(`^${SKIP}[.!。！]?$`, "i").test(said) ? "" : said.slice(0, GROUP_TEXT_MAX);
}

type GroupRow = { id: string; name: string; members: string; reply: GroupConfig["reply"]; ord: GroupConfig["order"]; rounds: number; icon: string; seen: string; round: string; at: number };
type LineRow = { seq: number; author: string; text: string; at: number; kind: GroupLine["kind"]; extra: string };
/** What a line carries besides words: its pictures (keys in the media store, never shown to the page) and stickers. */
type Extra = { pictures?: string[]; stickers?: GroupSticker[] };
export type StoredGroup = Group & { seen: Record<string, number>; round: GroupRound };

function lineOf(row: LineRow): GroupLine {
  const extra = JSON.parse(row.extra || "{}") as Extra;
  return {
    seq: row.seq,
    author: row.author,
    text: row.text,
    at: row.at,
    kind: row.kind,
    ...(extra.pictures?.length ? { pictures: extra.pictures.length } : {}),
    ...(extra.stickers?.length ? { stickers: extra.stickers } : {})
  };
}

/** The groups and what was said in them, in the default resident's SQLite. */
export class GroupStore {
  constructor(private readonly sql: Sql) {
    sql`CREATE TABLE IF NOT EXISTS grp_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, members TEXT NOT NULL, reply TEXT NOT NULL, ord TEXT NOT NULL, seen TEXT NOT NULL, round TEXT NOT NULL, at INTEGER NOT NULL)`;
    sql`CREATE TABLE IF NOT EXISTS grp_said (seq INTEGER PRIMARY KEY AUTOINCREMENT, grp TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL)`;
    sql`CREATE INDEX IF NOT EXISTS grp_said_by_group ON grp_said (grp, seq)`;
    // Columns added since the first group chats; a table from before gets them once.
    try {
      sql`SELECT rounds, icon FROM grp_groups LIMIT 0`;
    } catch {
      sql`ALTER TABLE grp_groups ADD COLUMN rounds INTEGER NOT NULL DEFAULT 3`;
      sql`ALTER TABLE grp_groups ADD COLUMN icon TEXT NOT NULL DEFAULT ''`;
    }
    try {
      sql`SELECT extra FROM grp_said LIMIT 0`;
    } catch {
      sql`ALTER TABLE grp_said ADD COLUMN extra TEXT NOT NULL DEFAULT '{}'`;
    }
  }

  private group(row: GroupRow): StoredGroup {
    return {
      id: row.id,
      name: row.name,
      members: JSON.parse(row.members) as string[],
      reply: row.reply,
      order: row.ord,
      rounds: row.rounds,
      icon: row.icon,
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
    this.sql`INSERT INTO grp_groups (id, name, members, reply, ord, rounds, icon, seen, round, at) VALUES (${id}, ${config.name}, ${JSON.stringify(config.members)}, ${config.reply}, ${config.order}, ${config.rounds}, '', '{}', '{}', ${at})`;
    return { ...config, id, at, icon: "" };
  }

  update(id: string, config: GroupConfig): void {
    this.sql`UPDATE grp_groups SET name = ${config.name}, members = ${JSON.stringify(config.members)}, reply = ${config.reply}, ord = ${config.order}, rounds = ${config.rounds} WHERE id = ${id}`;
  }

  /** A new icon (a key in the media store), or none; the old one's key, for the caller to throw away. */
  setIcon(id: string, key: string): string {
    const before = this.get(id)?.icon ?? "";
    this.sql`UPDATE grp_groups SET icon = ${key} WHERE id = ${id}`;
    return before;
  }

  /** Whether `key` is some group's icon, which anyone with its address may see, like a resident's avatar. */
  isIcon(key: string): boolean {
    return Boolean(key) && this.sql<{ id: string }>`SELECT id FROM grp_groups WHERE icon = ${key} LIMIT 1`.length > 0;
  }

  /**
   * A group and everything said in it; what its members heard stays in their own conversations. Returns the keys
   * of its icon and pictures, for the caller to take out of the media store.
   */
  remove(id: string): string[] {
    const keys = [this.get(id)?.icon ?? "", ...this.sql<{ extra: string }>`SELECT extra FROM grp_said WHERE grp = ${id}`.flatMap((row) => (JSON.parse(row.extra || "{}") as Extra).pictures ?? [])];
    this.sql`DELETE FROM grp_said WHERE grp = ${id}`;
    this.sql`DELETE FROM grp_groups WHERE id = ${id}`;
    return keys.filter(Boolean);
  }

  setRound(id: string, round: GroupRound): void {
    this.sql`UPDATE grp_groups SET round = ${JSON.stringify(round)} WHERE id = ${id}`;
  }

  /** The latest line `member` has been handed. */
  setSeen(id: string, member: string, seq: number): void {
    const group = this.get(id);
    if (group) this.sql`UPDATE grp_groups SET seen = ${JSON.stringify({ ...group.seen, [member]: seq })} WHERE id = ${id}`;
  }

  add(grp: string, author: string, text: string, kind: GroupLine["kind"] = "say", extra: Extra = {}): GroupLine {
    const at = Date.now();
    const kept = JSON.stringify({ ...(extra.pictures?.length ? { pictures: extra.pictures } : {}), ...(extra.stickers?.length ? { stickers: extra.stickers } : {}) });
    const [row] = this.sql<{ seq: number }>`INSERT INTO grp_said (grp, author, text, at, kind, extra) VALUES (${grp}, ${author}, ${text}, ${at}, ${kind}, ${kept}) RETURNING seq`;
    return lineOf({ seq: row.seq, author, text, at, kind, extra: kept });
  }

  /** The keys of a line's pictures. */
  pictures(grp: string, seq: number): string[] {
    const [row] = this.sql<{ extra: string }>`SELECT extra FROM grp_said WHERE grp = ${grp} AND seq = ${seq}`;
    return row ? ((JSON.parse(row.extra || "{}") as Extra).pictures ?? []) : [];
  }

  /** Lines after the one the page has, oldest first. */
  after(grp: string, seq: number): GroupLine[] {
    return this.sql<LineRow>`SELECT seq, author, text, at, kind, extra FROM grp_said WHERE grp = ${grp} AND seq > ${seq} ORDER BY seq LIMIT ${GROUP_PAGE}`.map(lineOf);
  }

  /** The latest lines, or the ones before `before`, oldest first; `more` when there are earlier ones. */
  page(grp: string, before: number | null): { lines: GroupLine[]; more: boolean } {
    const rows = this.sql<LineRow>`SELECT seq, author, text, at, kind, extra FROM grp_said WHERE grp = ${grp} AND seq < ${before ?? Number.MAX_SAFE_INTEGER} ORDER BY seq DESC LIMIT ${GROUP_PAGE + 1}`;
    return { lines: rows.slice(0, GROUP_PAGE).reverse().map(lineOf), more: rows.length > GROUP_PAGE };
  }

  /** The latest line of each group, for the list. */
  latest(): Record<string, GroupLine> {
    const rows = this.sql<LineRow & { grp: string }>`SELECT s.grp, s.seq, s.author, s.text, s.at, s.kind, s.extra FROM grp_said s JOIN (SELECT MAX(seq) AS seq FROM grp_said GROUP BY grp) m ON s.seq = m.seq`;
    return Object.fromEntries(rows.map(({ grp, ...line }) => [grp, lineOf(line)]));
  }

  /**
   * What `member` has not heard: the things others said after line `since` (not the group's notes), the latest
   * HEARD_MAX of them; `cut` when earlier ones are left out; `last` is the group's latest line.
   */
  unheard(grp: string, member: string, since: number): { lines: GroupLine[]; cut: boolean; last: number } {
    const rows = this.sql<LineRow>`SELECT seq, author, text, at, kind, extra FROM grp_said WHERE grp = ${grp} AND seq > ${since} AND kind = 'say' AND author != ${member} ORDER BY seq DESC LIMIT ${HEARD_MAX + 1}`;
    const [{ last }] = this.sql<{ last: number | null }>`SELECT MAX(seq) AS last FROM grp_said WHERE grp = ${grp}`;
    return { lines: rows.slice(0, HEARD_MAX).reverse().map(lineOf), cut: rows.length > HEARD_MAX, last: last ?? since };
  }

  /** The groups for the web page: each with its members still there (of `ids`), its icon and its latest line. */
  views(ids: readonly string[]): (GroupView & { last: GroupLine | null; running: boolean })[] {
    const latest = this.latest();
    return this.list().map((group) => ({ ...this.settingsOf(group, ids), last: latest[group.id] ?? null, running: group.round.running }));
  }

  /** A group for the web page: its latest lines (or those after `after`, or before `before`), its settings, who speaks. */
  view(id: string, ids: readonly string[], after: number | null, before: number | null): Record<string, unknown> {
    const group = this.get(id);
    if (!group) return { error: "没有这个群" };
    const page = after !== null ? { lines: this.after(id, after), more: false } : this.page(id, before);
    return { ...page, group: this.settingsOf(group, ids), speaking: group.round.speaking, waiting: group.round.queue, running: group.round.running, round: group.round.n };
  }

  private settingsOf(group: StoredGroup, ids: readonly string[]): GroupView {
    return { id: group.id, name: group.name, members: membersOf(group, ids), reply: group.reply, order: group.order, rounds: group.rounds, icon: group.icon ? `/avatar/${group.icon}` : null };
  }

  /** Stop: no one still in line answers, and no new round starts. The one answering now finishes; its answer is already in its own chat. */
  stop(id: string): { ok: true } | { error: string } {
    const group = this.get(id);
    if (!group) return { error: "没有这个群" };
    if (group.round.queue.length || group.round.speaking) {
      this.setRound(id, { ...group.round, queue: [], order: [] });
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
