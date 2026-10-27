// What a web search turned up that stays true, kept in Aelios as world knowledge, so next time it comes back
// with the rest of long-term memory instead of being searched again. After a turn of theirs that searched, the
// model that shrinks web pages (WEB_FETCH_MODEL) reads the question, the results and the reply, and picks at most
// MAX_FACTS facts that will still hold months from now: what something is, how it works, where it is. Weather,
// news, prices, scores, schedules and anything about the two of them are left out, the last because Aelios
// already records the conversation. Each fact is one sentence with the date and the source, saved with Aelios'
// remember under a stable key (world:…), so searching the same thing again replaces it and keeps the old one as
// history. WEB_LEARN=off turns it off. Nothing here holds up the reply: it runs after the turn has finished.

import { generateText, type LanguageModel } from "ai";
import type { StepLike } from "../usage";
import { renderWebSearchResults } from "agents/websearch";
import { callMcpTool } from "../mcp";
import type { AeliosConfig } from "../aelios";

export const MAX_FACTS = 3;
const RESULTS_MAX_CHARS = 12000;
const REPLY_MAX_CHARS = 3000;
/** Tags every fact learned this way, so it can be found (and cleared) in Aelios as a group. */
export const LEARNED_TAG = "搜网";

export type Searched = { query: string; results: string };
export type Fact = { key: string; content: string };

/** One search as the picking model reads it. */
export function searched(input: unknown, output: unknown): Searched {
  const query = typeof (input as { query?: unknown })?.query === "string" ? (input as { query: string }).query : "";
  let results: string;
  try {
    results = renderWebSearchResults(output as Parameters<typeof renderWebSearchResults>[0]);
  } catch {
    results = typeof output === "string" ? output : JSON.stringify(output ?? "");
  }
  return { query, results };
}

const SYSTEM = `You keep a companion's notes of general knowledge. You get what someone asked, what a web search found and the answer they got. Pick the facts from it worth knowing next time without searching again.

Keep only what will still be true months from now: what something is, how it works or is done, where it is, when something that already happened happened, specs and definitions.
Leave out anything that changes: weather, news, prices, stock, scores, rankings, schedules, opening hours, "latest" anything. Leave out anything about the person or the two of them. Leave out what the results do not clearly support.
At most ${MAX_FACTS} facts; none is a fine answer. Each is one self-contained sentence in the language of the conversation, naming its subject so it makes sense on its own, ending with its source's domain in parentheses.
Give each a key: lowercase ASCII words joined by hyphens naming the subject, the same key whenever the same thing is looked up again (e.g. "matcha-vs-sencha", "sydney-opera-house-architect").

Answer with JSON only: {"facts":[{"key":"…","content":"…"}]}`;

export function learnPrompt(asked: string, searches: readonly Searched[], reply: string): string {
  let budget = RESULTS_MAX_CHARS;
  const found = searches
    .map(({ query, results }) => {
      const text = results.slice(0, Math.max(budget, 0));
      budget -= text.length;
      return `Search: ${query}\n${text}`;
    })
    .filter((block) => block.trim())
    .join("\n\n");
  return `They asked:\n${asked}\n\nThe search found:\n${found}\n\nThe answer they got:\n${reply.slice(0, REPLY_MAX_CHARS)}`;
}

/** The facts in the model's answer, cleaned; nothing when it is not the JSON asked for. */
export function parseFacts(text: string): Fact[] {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return [];
  let facts: unknown;
  try {
    facts = (JSON.parse(json) as { facts?: unknown }).facts;
  } catch {
    return [];
  }
  if (!Array.isArray(facts)) return [];
  const seen = new Set<string>();
  const out: Fact[] = [];
  for (const fact of facts) {
    const key = String(fact?.key ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    const content = String(fact?.content ?? "").trim();
    if (!key || !content || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, content: content.slice(0, 400) });
    if (out.length === MAX_FACTS) break;
  }
  return out;
}

/** The sentence as Aelios keeps it: with the day it was looked up, so an old one can be told apart. */
export function asMemory(fact: Fact, day: string): string {
  return `（${day} 搜网）${fact.content}`;
}

/** Picks what lasts from a turn's searches and saves it in Aelios. Returns how many facts were saved. */
export async function learnFromSearch({
  model,
  memory,
  asked,
  searches,
  reply,
  day,
  onStep
}: {
  model: LanguageModel;
  memory: AeliosConfig;
  asked: string;
  searches: readonly Searched[];
  reply: string;
  day: string;
  /** Told the call's tokens (usage.ts). */
  onStep?: (step: StepLike) => void;
}): Promise<number> {
  const { text } = await generateText({
    model,
    system: SYSTEM,
    prompt: learnPrompt(asked, searches, reply),
    // Room for a model that thinks first (Claude 5 always does), so the JSON is not cut off.
    maxOutputTokens: 4000,
    abortSignal: AbortSignal.timeout(60_000),
    onStepEnd: onStep
  });
  let saved = 0;
  for (const fact of parseFacts(text)) {
    try {
      // world_fact is world knowledge in Aelios; an Aelios that does not take that type yet keeps it as a fact.
      await callMcpTool(`${memory.url}/mcp`, memory.key, "remember", {
        content: asMemory(fact, day),
        fact_key: `world:${fact.key}`,
        type: "world_fact",
        tags: [LEARNED_TAG],
        importance: 0.4,
        namespace: memory.namespace
      });
      saved++;
    } catch (error) {
      console.error("learn: could not save a fact", { key: fact.key, error: String(error) });
    }
  }
  return saved;
}
