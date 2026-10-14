/**
 * Claude ("anthropic/…") reaches Anthropic through Cloudflare's run path (env.AI.run). Two things are fixed
 * up in the request body there, just before the call:
 *
 * 1. The run path's input schema takes `system` only as a string. The AI SDK sends the system prompt as a
 *    list of text blocks, so every turn with a system prompt failed with "Invalid value at system: Invalid
 *    input: expected string, received array". The blocks are joined back into one string.
 *
 * 2. Claude's thinking blocks are signed for the conversation they were written in: the system prompt, the
 *    tools and every message before them. The resident changes that prefix on purpose: a persona saved on
 *    the web, the boot packet refreshed every few hours, a handoff letter that replaces older messages
 *    while keeping the recent ones, a new deploy with other rules or tools. After any of those, sending an
 *    old thinking block back fails the turn with "Invalid `signature` in `thinking` block. The block is
 *    bound to a different conversation", and every turn after it too. So thinking from earlier turns is
 *    left out; only the thinking of the turn in progress (between tool calls) goes back, as Anthropic
 *    requires. Leaving out every block before a point is allowed, because the blocks written after it
 *    were written without them. The replies themselves stay; only the reasoning behind old replies goes.
 *
 * Prompt caching is unaffected: the request-level cache_control (PROMPT_CACHE) caches the whole prefix,
 * the system prompt is part of that prefix whether it is a string or blocks, and an earlier turn is sent
 * the same way on every later turn.
 */
export function claudeOnRunPath(ai: Ai): Ai {
  return new Proxy(ai, {
    get(target, property) {
      if (property === "run") {
        const run = target.run.bind(target) as (model: unknown, inputs: unknown, options?: unknown) => unknown;
        return (model: unknown, inputs: unknown, options?: unknown) =>
          run(model, withoutOldThinking(model, systemAsText(model, inputs)), options);
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function isClaude(model: unknown, inputs: unknown): inputs is Record<string, unknown> {
  return typeof model === "string" && model.startsWith("anthropic/") && !!inputs && typeof inputs === "object";
}

export function systemAsText(model: unknown, inputs: unknown): unknown {
  if (!isClaude(model, inputs)) return inputs;
  const { system } = inputs as { system?: unknown };
  if (!Array.isArray(system)) return inputs;
  const text = system
    .map((block: unknown) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
    .filter(Boolean)
    .join("\n\n");
  return { ...inputs, system: text };
}

type Block = { type?: unknown };
type Message = { role?: unknown; content?: unknown };

const THINKING = new Set(["thinking", "redacted_thinking"]);

/** The request without thinking blocks from before the last message they typed (tool results are not typed). */
export function withoutOldThinking(model: unknown, inputs: unknown): unknown {
  return isClaude(model, inputs) ? withoutOldThinkingIn(inputs) : inputs;
}

/** The same for any Anthropic Messages request body (a provider of your own, custom.ts). */
export function withoutOldThinkingIn(inputs: Record<string, unknown>): Record<string, unknown> {
  const { messages } = inputs as { messages?: unknown };
  if (!Array.isArray(messages)) return inputs;
  const list = messages as Message[];
  let turn = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === "user" && !onlyToolResults(list[i].content)) {
      turn = i;
      break;
    }
  }
  if (turn <= 0) return inputs;
  let changed = false;
  const kept: Message[] = [];
  list.forEach((message, index) => {
    if (index < turn && message?.role === "assistant" && Array.isArray(message.content)) {
      const content = (message.content as Block[]).filter((block) => !THINKING.has(String(block?.type)));
      if (content.length !== message.content.length) {
        changed = true;
        // A reply that was only thinking leaves nothing to send back.
        if (content.length) kept.push({ ...message, content });
        return;
      }
    }
    kept.push(message);
  });
  return changed ? { ...inputs, messages: kept } : inputs;
}

function onlyToolResults(content: unknown): boolean {
  return Array.isArray(content) && content.length > 0 && content.every((block: Block) => block?.type === "tool_result");
}
