// Claude's prompt cache holds the request in order: the tools, then the system prompt, then the messages. The
// cache marker sits at the end, so a change anywhere in the tools or the system prompt makes the next turn write
// the whole conversation into the cache again, at twice the input price for the one-hour cache.
//
// Some of what goes there changes by itself, not because she changed a setting: Aelios' boot packet, a sticker the
// resident draws, the tools of an MCP server that has not reconnected yet after the Durable Object slept. Those are
// taken up only when a new cache window opens: when the cache has run out anyway (nothing used it for longer than it
// lasts), or when a handoff letter has just folded the older turns (the messages change anyway). Inside a window the
// prefix stays as it was, so every turn reads it from the cache.

import type { ModelMessage } from "ai";

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

type CacheControl = { type: "ephemeral"; ttl: "5m" | "1h" };

/**
 * The messages of the handoff letter's turn. The conversation is folded right after it, so nothing would ever read
 * what that turn writes into the cache. So no marker goes at the end: it goes where the turn before put its own, on
 * the last message before the letter prompt that was not a tool's result (hers, or a check-in's note). That much is
 * eligible for a cache read; no marker is added for the new suffix, which is charged at the plain input price.
 * A breakpoint is read-or-create, not read-only: if the provider has already expired it, that old prefix may be written.
 * `cache` is null when the cache has run out: then there is nothing to read, and no marker at all.
 */
export function markedForLetter(messages: ModelMessage[], cache: CacheControl | null): ModelMessage[] {
  if (!cache) return messages;
  const prompt = messages.findLastIndex((message) => message.role === "user");
  const before = messages.findLastIndex((message, i) => i < prompt && message.role === "user");
  if (before < 0) return messages;
  return messages.map((message, i) =>
    i === before
      ? ({ ...message, providerOptions: { ...message.providerOptions, anthropic: { ...message.providerOptions?.anthropic, cacheControl: cache } } } as ModelMessage)
      : message
  );
}
