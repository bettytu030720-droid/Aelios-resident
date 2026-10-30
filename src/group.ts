// The group chat (多住户二期): she and the residents she picks talk in one room on the web door. The room lives in
// the default resident, which decides who speaks (Resident.groupTurn); each resident answers from its own Durable
// Object, with its own persona and model (Resident.groupReply). The rules follow mist's group chat design
// (docs/design/group-chat-phase-0.md in mist-agent-harness/mist-agent, AGPL like this repository):
// - The room keeps its own log. Nothing said here goes into a resident's own conversation or into Aelios: hearing
//   is not remembering.
// - The room decides who speaks, not the residents: @ calls only those named, otherwise the setting says who.
// - A message of hers starts a round, and a round has a cap on replies, so residents calling each other stop by
//   themselves. Her next message starts a new round; stopping is a separate button that does not wait in line.
// - A resident sees a recent window of the room, cut where it says so, moved in steps so its cache holds.

import type { ModelMessage } from "ai";
import { SKIP } from "./prompts";
import type { Sql } from "./sticker-store";

/** The author of her lines; a resident's id starts with a letter. */
export const HER = "";
export const GROUP_TEXT_MAX = 4000;
export const TURNS_DEFAULT = 6;
export const TURNS_MAX = 20;
/** Lines the page gets at a time. */
export const GROUP_PAGE = 100;
// A resident sees the latest 31 to 60 lines: the window moves 30 lines at a time, so its start, and what is read
// from cache, stays the same for 30 lines.
const WINDOW = 60;
const STEP = 30;
// A line longer than this is cut when a resident is shown it, saying so.
const LINE_MAX = 2000;

export type GroupConfig = {
  /** Who is in the group; null for every resident, new ones included. */
  members: string[] | null;
  /** Who answers a message of hers that names no one: everyone, one of them (whoever spoke least lately), or no one. */
  reply: "all" | "one" | "none";
  /** The order they answer in: the sidebar's, or shuffled each time. */
  order: "list" | "random";
  /** Replies one message of hers can lead to at most, residents calling each other included. */
  turns: number;
};

/** A line in the room: hers, a resident's, or a note from the room itself. */
export type GroupLine = { seq: number; author: string; text: string; at: number; kind: "say" | "note" };

/**
 * The round in progress: the message of hers it answers (root), who is still to speak, the replies so far, who is
 * speaking now. `epoch` changes when she stops it, so a reply that comes back after that is dropped.
 */
export type GroupRound = { root: number; queue: string[]; calls: number; speaking: string; since: number; epoch: number; running: boolean };
export const ROUND_IDLE: GroupRound = { root: 0, queue: [], calls: 0, speaking: "", since: 0, epoch: 0, running: false };

export type Member = { id: string; name: string };

/** The settings as saved, with the defaults for anything missing or out of range. */
export function groupConfig(saved: unknown): GroupConfig {
  const s = (saved && typeof saved === "object" ? saved : {}) as Partial<Record<keyof GroupConfig, unknown>>;
  const turns = Number(s.turns);
  return {
    members: Array.isArray(s.members) ? s.members.filter((id): id is string => typeof id === "string") : null,
    reply: s.reply === "one" || s.reply === "none" ? s.reply : "all",
    order: s.order === "random" ? "random" : "list",
    turns: Number.isInteger(turns) && turns >= 1 && turns <= TURNS_MAX ? turns : TURNS_DEFAULT
  };
}

/** Settings from the web page, checked against the residents there are. */
export function groupConfigFrom(body: Record<string, unknown>, ids: readonly string[]): { config: GroupConfig } | { error: string } {
  const members = body.members === null ? null : Array.isArray(body.members) ? [...new Set(body.members.map(String))] : undefined;
  if (members === undefined) return { error: "群里有谁没说" };
  if (members && (!members.length || members.some((id) => !ids.includes(id)))) return { error: "群里至少要有一个住户，而且得是现有的住户" };
  if (!["all", "one", "none"].includes(String(body.reply))) return { error: "没@人时谁回，没这个选项" };
  if (!["list", "random"].includes(String(body.order))) return { error: "谁先说，没这个选项" };
  const turns = Number(body.turns);
  if (!Number.isInteger(turns) || turns < 1 || turns > TURNS_MAX) return { error: `一条最多引出几句，要 1 到 ${TURNS_MAX}` };
  // Everyone ticked is everyone, new residents included.
  const all = members && ids.every((id) => members.includes(id));
  return { config: { members: all ? null : members, reply: body.reply as GroupConfig["reply"], order: body.order as GroupConfig["order"], turns } };
}

/** The members' ids, in the sidebar's order. */
export function membersOf(config: GroupConfig, ids: readonly string[]): string[] {
  return config.members ? ids.filter((id) => config.members?.includes(id)) : [...ids];
}

/**
 * Whom a message calls with @, in the order they are called: a member's name or id right after an @ (letters in
 * either case). The longest name wins, so @麻薯糖 is not @麻薯; a Latin name has to end there (@mochi2 is not
 * @mochi), and an @ inside a word (an email address) calls no one.
 */
export function mentionsIn(text: string, members: readonly Member[], self = HER): string[] {
  const keys = members
    .filter((member) => member.id !== self)
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
 * answer), or as the settings say. `lastSaid` is each one's latest line; `everyone` every resident there is.
 */
export function speakersFor(
  text: string,
  members: readonly Member[],
  config: GroupConfig,
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

/**
 * What a reply does to the round: in the round it was asked for, the members it calls join the line; a round at
 * its cap with someone still in line ends there, with a note saying so.
 */
export function afterReply(round: GroupRound, reply: { root: number; speaker: string; text: string }, members: readonly Member[], turns: number): { round: GroupRound; note: string } {
  if (round.root !== reply.root) return { round, note: "" };
  const called = mentionsIn(reply.text, members, reply.speaker).filter((id) => !round.queue.includes(id));
  const queue = [...round.queue, ...called];
  if (round.calls >= turns && queue.length) return { round: { ...round, queue: [] }, note: `这一轮说了 ${turns} 句，先停在这里。你再说一句就接着聊。` };
  return { round: { ...round, queue }, note: "" };
}

/** Where the window a resident sees starts, among `count` lines. */
export function windowStart(count: number): number {
  return count <= WINDOW ? 0 : Math.ceil((count - WINDOW) / STEP) * STEP;
}

/** What a resident is told about the group, after its persona. */
export function groupRules(me: string, others: readonly string[]): string {
  return [
    `You are ${me}, in a group chat on the web door with the person you live with${others.length ? ` and ${others.length === 1 ? "another resident" : "other residents"}: ${others.join(", ")}` : ""}.`,
    "Messages from the residents start with their name in brackets, like [name]; a message without a name is from the person you live with.",
    "When you are given the group's messages it is your turn: write only your own next message, as in a group chat, in your own voice, without your name in front and without speaking for anyone else.",
    `If you have nothing to add, reply with just the four letters ${SKIP}. To have another resident answer, write @ and their name.`,
    "This group is not part of your one-to-one conversation with the person you live with."
  ].join("\n");
}

/** The room as resident `me` sees it: its own lines as its turns, everyone else's as messages to it. */
export function groupPrompt(lines: readonly GroupLine[], cut: boolean, me: string, names: Readonly<Record<string, string>>): ModelMessage[] {
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  const put = (role: "user" | "assistant", content: string) => {
    const last = messages.at(-1);
    if (last?.role === role) last.content += `\n\n${content}`;
    else messages.push({ role, content });
  };
  if (cut) put("user", "(Earlier messages of this group are not shown.)");
  for (const line of lines) {
    if (line.kind !== "say") continue;
    const text = line.text.length > LINE_MAX ? `${line.text.slice(0, LINE_MAX)}…(cut here: ${line.text.length} characters in all)` : line.text;
    if (line.author === me) put("assistant", text);
    else put("user", line.author === HER ? text : `[${names[line.author] ?? line.author}] ${text}`);
  }
  if (messages[0]?.role !== "user") messages.unshift({ role: "user", content: "(The group so far.)" });
  // Its own line last only if it is called twice in a row; it still answers what was said.
  if (messages.at(-1)?.role !== "user") messages.push({ role: "user", content: "(Your turn again.)" });
  return messages;
}

/** A resident's reply as it goes into the room: without its name in front; "" when it passes. */
export function cleanReply(text: string, name: string): string {
  const own = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const said = text.trim().replace(new RegExp(`^(\\[${own}\\]|${own}[:：])\\s*`), "").trim();
  return new RegExp(`^${SKIP}[.!。！]?$`, "i").test(said) ? "" : said.slice(0, GROUP_TEXT_MAX);
}

/** The room's lines, in the default resident's SQLite. */
export class GroupStore {
  constructor(private readonly sql: Sql) {
    sql`CREATE TABLE IF NOT EXISTS grp_lines (seq INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL)`;
  }

  add(author: string, text: string, kind: GroupLine["kind"] = "say"): GroupLine {
    const at = Date.now();
    const [row] = this.sql<{ seq: number }>`INSERT INTO grp_lines (author, text, at, kind) VALUES (${author}, ${text}, ${at}, ${kind}) RETURNING seq`;
    return { seq: row.seq, author, text, at, kind };
  }

  /** Lines after the one the page has, oldest first. */
  after(seq: number): GroupLine[] {
    return this.sql<GroupLine>`SELECT seq, author, text, at, kind FROM grp_lines WHERE seq > ${seq} ORDER BY seq LIMIT ${GROUP_PAGE}`;
  }

  /** The latest lines, or the ones before `before`, oldest first; `more` when there are earlier ones. */
  page(before: number | null): { lines: GroupLine[]; more: boolean } {
    const rows = this.sql<GroupLine>`SELECT seq, author, text, at, kind FROM grp_lines WHERE seq < ${before ?? Number.MAX_SAFE_INTEGER} ORDER BY seq DESC LIMIT ${GROUP_PAGE + 1}`;
    return { lines: rows.slice(0, GROUP_PAGE).reverse(), more: rows.length > GROUP_PAGE };
  }

  /** What a resident is shown: the window of things said (not the room's notes), and whether earlier ones are left out. */
  window(): { lines: GroupLine[]; cut: boolean } {
    const [{ count }] = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM grp_lines WHERE kind = 'say'`;
    const start = windowStart(count);
    const lines = this.sql<GroupLine>`SELECT seq, author, text, at, kind FROM grp_lines WHERE kind = 'say' ORDER BY seq LIMIT ${WINDOW} OFFSET ${start}`;
    return { lines, cut: start > 0 };
  }

  /** Each resident's latest line, for whose turn it is when one answers. */
  lastSaid(): Record<string, number> {
    const rows = this.sql<{ author: string; seq: number }>`SELECT author, MAX(seq) AS seq FROM grp_lines WHERE kind = 'say' AND author != '' GROUP BY author`;
    return Object.fromEntries(rows.map((row) => [row.author, row.seq]));
  }
}
