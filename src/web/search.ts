// web_search: her own search keys first.
//
// Tavily, Brave and Perplexity are not providers of Cloudflare's Web Search (that one offers Ceramic, Exa and
// Linkup), so their keys are Worker secrets and the resident calls them directly, in that order: one that fails
// or has run out of its free quota hands the search to the next. Cloudflare's Web Search, paid from AI Gateway
// credit or from an Exa/Linkup/Ceramic key stored on the gateway, is used when no key of her own is set, or
// after them when WEB_SEARCH names one of its providers.

import {
  createAIWebSearch,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResponse,
  type WebSearchResult,
  type WebSearchSource
} from "agents/websearch";

type Engine = { name: string; search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResponse> };

const CLOUDFLARE_PROVIDERS: readonly string[] = ["ceramic", "exa", "linkup"];

function answer(query: string, items: WebSearchResult[], started: number): WebSearchResponse {
  return { items, metadata: { query, requestId: "", latencyMs: Date.now() - started } };
}

async function getJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

const stripTags = (text: string | undefined) => text?.replace(/<[^>]+>/g, "");

function tavily(key: string): Engine {
  return {
    name: "Tavily",
    async search({ query, limit = 5 }, signal) {
      const started = Date.now();
      const body = await getJson<{ results?: { title?: string; url?: string; content?: string; published_date?: string }[] }>(
        "https://api.tavily.com/search",
        {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ query, max_results: limit, include_published_date: true }),
          signal
        }
      );
      const items = (body.results ?? []).flatMap((r) =>
        r.url ? [{ url: r.url, title: r.title ?? r.url, description: r.content, lastModifiedDate: r.published_date }] : []
      );
      return answer(query, items, started);
    }
  };
}

function brave(key: string): Engine {
  return {
    name: "Brave",
    async search({ query, limit = 5 }, signal) {
      const started = Date.now();
      const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(limit) })}`;
      const body = await getJson<{ web?: { results?: { title?: string; url?: string; description?: string; page_age?: string }[] } }>(
        url,
        { headers: { accept: "application/json", "x-subscription-token": key }, signal }
      );
      const items = (body.web?.results ?? []).flatMap((r) =>
        r.url ? [{ url: r.url, title: stripTags(r.title) ?? r.url, description: stripTags(r.description), lastModifiedDate: r.page_age }] : []
      );
      return answer(query, items, started);
    }
  };
}

function perplexity(key: string): Engine {
  return {
    name: "Perplexity",
    async search({ query, limit = 5 }, signal) {
      const started = Date.now();
      const body = await getJson<{ results?: { title?: string; url?: string; snippet?: string; date?: string; last_updated?: string }[] }>(
        "https://api.perplexity.ai/search",
        {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ query, max_results: limit }),
          signal
        }
      );
      const items = (body.results ?? []).flatMap((r) =>
        r.url ? [{ url: r.url, title: r.title ?? r.url, description: r.snippet, lastModifiedDate: r.date ?? r.last_updated }] : []
      );
      return answer(query, items, started);
    }
  };
}

function engines(env: Env): Engine[] {
  const setting = env.WEB_SEARCH?.trim().toLowerCase() ?? "";
  if (setting === "off") return [];
  const own: Engine[] = [];
  const key = (value: string | undefined) => value?.trim() || "";
  if (key(env.TAVILY_API_KEY)) own.push(tavily(key(env.TAVILY_API_KEY)));
  if (key(env.BRAVE_API_KEY)) own.push(brave(key(env.BRAVE_API_KEY)));
  if (key(env.PERPLEXITY_API_KEY)) own.push(perplexity(key(env.PERPLEXITY_API_KEY)));
  const provider = CLOUDFLARE_PROVIDERS.includes(setting) ? (setting as WebSearchProvider) : undefined;
  // Her own keys cost nothing; Cloudflare's search costs credit, so with keys it only joins when asked for.
  if (!env.AI || (own.length && !provider)) return own;
  const cloudflare = createAIWebSearch({ binding: env.AI, gateway: env.AI_GATEWAY_ID?.trim() || undefined, provider });
  return [...own, { name: `Cloudflare（${provider ?? "ceramic"}）`, search: (request, signal) => cloudflare.search(request, { signal }) }];
}

/** Who searches, in order, for /status. Empty when searching is off or impossible. */
export function searchEngines(env: Env): string[] {
  return engines(env).map((engine) => engine.name);
}

/** One source that tries each engine in turn. Null when there is none. */
export function searchSource(env: Env): WebSearchSource | null {
  const chain = engines(env);
  if (!chain.length) return null;
  return {
    async search(request, options) {
      const failures: string[] = [];
      for (const engine of chain) {
        try {
          return await engine.search(request, options?.signal);
        } catch (error) {
          if (options?.signal?.aborted) throw error;
          failures.push(`${engine.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      throw new Error(`Search failed. ${failures.join("; ")}`);
    }
  };
}
