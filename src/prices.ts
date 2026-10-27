// Anthropic's list prices for Claude, in US dollars per million tokens, as published on
// https://platform.claude.com/docs/en/about-claude/pricing (copied 2026-10-27). The usage timeline (usage.ts) prices
// each call with them, matched on the model's name, so it is what the call would cost on Anthropic's own API: a
// plan's included credit, a relay with its own rates, a cloud platform's prices or US-only inference can differ.
// A model that is not here has no price, and the page shows its tokens only. Add a row when a new model comes out.

export type Price = {
  input: number;
  /** Writing to the five-minute prompt cache. */
  write5m: number;
  /** Writing to the one-hour prompt cache. */
  write1h: number;
  /** Reading from the prompt cache (a hit, which also refreshes it). */
  read: number;
  output: number;
};

const price = (input: number, write5m: number, write1h: number, read: number, output: number): Price => ({ input, write5m, write1h, read, output });

const OPUS_4 = price(5, 6.25, 10, 0.5, 25);
const OPUS_4_0 = price(15, 18.75, 30, 1.5, 75);
const SONNET_4 = price(3, 3.75, 6, 0.3, 15);

/** By family and version, as priceKey() names them. Cache reads are not always a tenth of the input price. */
const PRICES: Record<string, Price> = {
  "fable-5-1": price(10, 12.5, 20, 0.25, 50),
  "mythos-5-1": price(10, 12.5, 20, 0.25, 50),
  "fable-5": price(10, 12.5, 20, 1, 50),
  "mythos-5": price(10, 12.5, 20, 1, 50),
  "opus-5-5": price(4, 5, 8, 0.2, 20),
  "opus-5": price(5, 6.25, 10, 0.5, 25),
  "opus-4-8": OPUS_4,
  "opus-4-7": OPUS_4,
  "opus-4-6": OPUS_4,
  "opus-4-5": OPUS_4,
  "opus-4-1": OPUS_4_0,
  "opus-4": OPUS_4_0,
  "sonnet-5-5": price(2, 2.5, 4, 0.1, 10),
  "sonnet-5": price(2, 2.5, 4, 0.2, 10),
  "sonnet-4-6": SONNET_4,
  "sonnet-4-5": SONNET_4,
  "sonnet-4": SONNET_4,
  "haiku-5-5": price(0.1, 0.125, 0.2, 0.01, 0.5),
  "haiku-4-5": price(1, 1.25, 2, 0.1, 5),
  "haiku-3-5": price(0.8, 1, 1.6, 0.08, 4)
};

/** Haiku 5.5 costs more for a prompt over 100,000 tokens, counting every input token, cached or not. */
export const LONG_PROMPT = 100_000;
const LONG_PRICES: Record<string, Price> = {
  "haiku-5-5": price(0.5, 0.625, 1, 0.05, 2.5)
};

/**
 * The model a name is, whatever wraps it: anthropic/claude-opus-5.5, claude-opus-5-5, a relay's
 * custom-x/anthropic/claude-opus-5.5, Vertex's claude-opus-5-5@20260101 and a dated claude-opus-4-5-20251101 are
 * all "opus-5-5" or "opus-4-5". Null for anything that is not a Claude.
 */
export function priceKey(model: string): string | null {
  const name = model.toLowerCase().replace(/\./g, "-");
  // A version is one or two digits; a date after it (eight digits) is not part of it.
  const current = name.match(/claude-(fable|mythos|opus|sonnet|haiku)-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?/);
  if (current) return [current[1], current[2], current[3]].filter(Boolean).join("-");
  // Older names put the version first: claude-3-5-haiku-20241022.
  const older = name.match(/claude-(\d)-(\d)-(opus|sonnet|haiku)/);
  return older ? `${older[3]}-${older[1]}-${older[2]}` : null;
}

/** The price of one call to the model, given how long its prompt was; null when the model is not priced. */
export function priceFor(model: string, promptTokens = 0): Price | null {
  const key = priceKey(model);
  if (!key) return null;
  return (promptTokens > LONG_PROMPT ? LONG_PRICES[key] : undefined) ?? PRICES[key] ?? null;
}

export type Tokens = {
  /** Input not read from or written to the cache. */
  input: number;
  cacheRead: number;
  /** All cache writes, of which cacheWrite1h went to the one-hour cache. */
  cacheWrite: number;
  cacheWrite1h: number;
  /** Including any thinking. */
  output: number;
};

/** What the tokens cost in US dollars at that price. */
export function costAt(price: Price, tokens: Tokens): number {
  const write1h = Math.min(tokens.cacheWrite1h, tokens.cacheWrite);
  return (
    (tokens.input * price.input +
      tokens.cacheRead * price.read +
      (tokens.cacheWrite - write1h) * price.write5m +
      write1h * price.write1h +
      tokens.output * price.output) /
    1_000_000
  );
}

/** What one call cost in US dollars at list price; null when the model is not priced. */
export function costOf(model: string, tokens: Tokens): number | null {
  const found = priceFor(model, tokens.input + tokens.cacheRead + tokens.cacheWrite);
  return found ? costAt(found, tokens) : null;
}
