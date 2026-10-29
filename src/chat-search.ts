// Searching the conversation from the web page (Resident.webChatSearch): every message on the current branch, the
// ones a handoff letter folded away included, since their rows stay in the session's table. Plain substring
// matching, so Chinese works without word splitting (the session's own full-text index does not split it).
//
// Two steps: a LIKE on each row's stored JSON picks the rows that may hold the words, then the words are looked for
// in the message's text. The LIKE has to let through every message the second step would find (test/chat-search.mjs
// checks it): runs of spaces and line breaks count as one space, and letters match in either case.

/** The longest search, in characters. */
export const SEARCH_MAX = 50;
/** Hits on one page of results. */
export const SEARCH_PAGE = 30;
/** Rows read for one page at most: the quick filter also matches the JSON around the words. */
export const SEARCH_ROWS = 300;
/** Messages shown on each side of a hit when it is opened. */
export const AROUND = 4;

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
 * One character as the search compares it: lowercased on its own, except the few outside ASCII whose lowercase is
 * ASCII (the Kelvin sign, İ), which stay as they are. Every character folds to one character of the same length.
 */
function foldChar(c: string): string {
  const low = c.toLowerCase();
  return c.charCodeAt(0) > 0x7f && low.charCodeAt(0) <= 0x7f ? c : low;
}

/** Text as the search compares it, the same length as the text. */
export function fold(text: string): string {
  let out = "";
  for (const c of text) out += foldChar(c);
  return out;
}

/**
 * A LIKE pattern that every stored message holding the words matches: the words between the spaces in order, with
 * anything between them (a line break is stored as \n). Each is written the way JSON.stringify writes it (a quote
 * or a backslash would not match otherwise) with LIKE's own wildcards taken literally. LIKE matches ASCII letters
 * in either case; a letter outside ASCII that has a case is left to `_`, any one character.
 */
export function storedLike(query: string): string {
  const pieces = query.split(" ").map((piece) => {
    let pattern = "";
    for (const c of piece) {
      if (c.charCodeAt(0) > 0x7f && (c.toLowerCase() !== c || c.toUpperCase() !== c)) pattern += "_";
      else pattern += JSON.stringify(c).slice(1, -1).replace(/[\\%_]/g, (m) => `\\${m}`);
    }
    return pattern;
  });
  return `%${pieces.join("%")}%`;
}

/**
 * The text a message is searched in: its text parts with a line break between them, and the marks only the model
 * reads taken out, each leaving a line break. So the words found are always words stored in one part, in order.
 */
export function searchable(parts: readonly string[], marks: readonly RegExp[]): string {
  let text = parts.join("\n");
  for (const mark of marks) text = text.trimStart().replace(mark, "\n");
  return text;
}

/** Where the words are in a message's text, as a hit with some text on either side; null when they are not. */
export function hitIn(line: ChatLine, search: string, query: string): ChatHit | null {
  const flat = search.replace(/\s+/g, " ").trim();
  const at = fold(flat).indexOf(fold(query));
  if (at < 0) return null;
  const end = at + query.length;
  let from = Math.max(0, at - 40);
  let to = Math.min(flat.length, end + 80);
  // Not half of a character outside the BMP.
  if (from > 0 && isLowSurrogate(flat.charCodeAt(from))) from += 1;
  if (to < flat.length && isLowSurrogate(flat.charCodeAt(to))) to -= 1;
  return {
    id: line.id,
    role: line.role,
    at: line.at,
    before: (from > 0 ? "…" : "") + flat.slice(from, at),
    match: flat.slice(at, end),
    after: flat.slice(end, to) + (to < flat.length ? "…" : "")
  };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
