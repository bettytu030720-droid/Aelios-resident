// Claude's prompt cache holds the request in order: the tools, then the system prompt, then the messages. The
// cache marker sits at the end, so a change anywhere in the tools or the system prompt makes the next turn write
// the whole conversation into the cache again, at twice the input price for the one-hour cache.
//
// Some of what goes there changes by itself, not because she changed a setting: Aelios' boot packet, a sticker the
// resident draws, the tools of an MCP server that has not reconnected yet after the Durable Object slept. Those are
// taken up only when a new cache window opens: when the cache has run out anyway (nothing used it for longer than it
// lasts), or when a handoff letter has just folded the older turns (the messages change anyway). Inside a window the
// prefix stays as it was, so every turn reads it from the cache.

export type WindowState = {
  /** When a model call last used the conversation's prefix (and so kept the cache alive). */
  usedAt: number | null;
  /** When the current window opened. */
  openedAt: number | null;
  /** A letter folded the older turns since. */
  folded: boolean;
};

/** How long the prompt cache lasts, in milliseconds (CACHE_TTL: 1h unless 5m). */
export function cacheTtlMs(ttl: string | undefined): number {
  return (ttl?.trim() === "5m" ? 5 : 60) * 60 * 1000;
}

/**
 * Whether a turn starting now opens a new window. `usedAt` is taken when a step ends, a little after the request
 * read the cache, so "longer than the cache lasts" here means the cache has really run out.
 */
export function opensWindow(state: WindowState, now: number, ttlMs: number): boolean {
  if (state.folded || state.usedAt === null || state.openedAt === null) return true;
  return now - state.usedAt > ttlMs;
}
