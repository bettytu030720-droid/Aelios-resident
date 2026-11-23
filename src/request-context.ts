import type { ModelMessage } from "ai";
import { markedForLetter, type CacheControl } from "./cache-window";

type ContextInput = { stableInstructions: readonly string[] } & (
  | { messages: ModelMessage[]; cache: { chat: CacheControl } | { letter: CacheControl | null } }
  | { input: string }
);

type RequestContext = {
  instructions: string;
  messages: ModelMessage[];
  providerOptions?: { anthropic: { cacheControl: CacheControl } };
};

export function buildContext(context: ContextInput): RequestContext {
  const instructions = context.stableInstructions.filter(Boolean).join("\n\n");
  if ("input" in context) return { instructions, messages: [{ role: "user", content: context.input }] };

  const { messages, cache } = context;
  if ("letter" in cache) return { instructions, messages: markedForLetter(messages, cache.letter) };
  return { instructions, messages, providerOptions: { anthropic: { cacheControl: cache.chat } } };
}
