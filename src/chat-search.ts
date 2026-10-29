// Searching the conversation, from the web page (Resident.webChatSearch) and by the resident itself (search_chat):
// every message on the current branch, the ones a handoff letter folded away included, since their rows stay in
// the session's table. Plain substring
// matching, so Chinese works without word splitting (the session's own full-text index does not split it).

/** The longest search, in characters. */
export const SEARCH_MAX = 50;
/** Hits on one page of results. */
export const SEARCH_PAGE = 30;
/** Rows read for one page at most: the quick filter also matches the JSON around the words. */
export const SEARCH_ROWS = 300;
/** Messages shown on each side of a hit when it is opened. */
export const AROUND = 4;

/** search_chat (the resident's own search, with its threads): hits it gives at once, and words shown of each line around one. */
export const SEARCH_TOOL_HITS = 10;
export const AROUND_SHOWN = 600;

/** search_chat's description: fixed, so the prompt cache holds. */
export const SEARCH_CHAT_DESCRIPTION =
  "Search your conversation with them for exact words, the part a handoff letter folded away included: their " +
  "messages and yours that contain the words, newest first, with when each was said. Use it when they bring up " +
  "something said before that you no longer see. A few words work best, written as they would have been said. Pass " +
  "a hit's id as around to read the messages around it.";

/** A message as the search shows it. */
export type ChatLine = { id: string; role: "user" | "assistant"; text: string; at: number; hit?: true };

export type ChatHit = {
  id: string;
  role: "user" | "assistant";
  at: number;
  /** The words around the hit, on one line: what comes before it, the hit itself, what comes after. */
  before: string;
  match: string;
  after: string;
};

/** Why this cannot be searched for, or the search itself, with its spaces folded. */
export function searchQuery(raw: string): { query: string } | { error: string } {
  const query = raw.trim().replace(/\s+/g, " ");
  if (!query) return { error: "要搜什么？" };
  if ([...query].length > SEARCH_MAX) return { error: `最多搜 ${SEARCH_MAX} 个字` };
  return { query };
}

/**
 * A LIKE pattern that finds the words inside a message's stored JSON: escaped the way JSON.stringify writes them
 * (a quote, a backslash or a line break would not match otherwise), with LIKE's own wildcards taken literally.
 */
export function storedLike(query: string): string {
  return `%${JSON.stringify(query).slice(1, -1).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Where the words are in a message's text, as a hit with some text on either side; null when they are not. */
export function hitIn(line: ChatLine, query: string): ChatHit | null {
  const flat = line.text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return null;
  const end = at + query.length;
  const from = Math.max(0, at - 40);
  const to = Math.min(flat.length, end + 80);
  return {
    id: line.id,
    role: line.role,
    at: line.at,
    before: (from > 0 ? "…" : "") + flat.slice(from, at),
    match: flat.slice(at, end),
    after: flat.slice(end, to) + (to < flat.length ? "…" : "")
  };
}
