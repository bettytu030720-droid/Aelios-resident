/**
 * Claude ("anthropic/…") reaches Anthropic through Cloudflare's run path (env.AI.run), whose input schema
 * takes `system` only as a string. The AI SDK sends the system prompt as a list of text blocks, so every
 * turn with a system prompt failed with "Invalid value at system: Invalid input: expected string, received array".
 * This wraps the binding and joins those blocks back into one string before the call.
 *
 * Prompt caching is unaffected: the request-level cache_control (PROMPT_CACHE) caches the whole prefix,
 * and the system prompt is part of that prefix whether it is a string or blocks.
 */
export function claudeSystemAsText(ai: Ai): Ai {
  return new Proxy(ai, {
    get(target, property) {
      if (property === "run") {
        const run = target.run.bind(target) as (model: unknown, inputs: unknown, options?: unknown) => unknown;
        return (model: unknown, inputs: unknown, options?: unknown) => run(model, systemAsText(model, inputs), options);
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

export function systemAsText(model: unknown, inputs: unknown): unknown {
  if (typeof model !== "string" || !model.startsWith("anthropic/")) return inputs;
  if (!inputs || typeof inputs !== "object") return inputs;
  const { system } = inputs as { system?: unknown };
  if (!Array.isArray(system)) return inputs;
  const text = system
    .map((block: unknown) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
    .filter(Boolean)
    .join("\n\n");
  return { ...inputs, system: text };
}
