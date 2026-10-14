// web_fetch: read one page as Markdown.
//
// With WEB_FETCH_URL and WEB_FETCH_KEY set, pages go through a web-fetch Worker
// (https://github.com/sakisakisa-design/web-fetch): it opens pages that need a real browser,
// caches them, and with a `query` trims a long page down to the part that answers it.
// Without it, the resident fetches the page itself and converts the HTML with that project's
// converter (html-to-markdown.ts). Either way, private and local addresses are refused.

import { tool } from "ai";
import { z } from "zod";
import { htmlToMarkdown } from "./html-to-markdown";
import { validateUrl, validateUrlWithDns } from "./validate-url";

// What the model gets back at most, so one long page does not crowd out the conversation.
const MAX_CHARS = 12000;
const TIMEOUT_MS = 20_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

type Page = { url: string; title?: string; content: string };
type Service = { url: string; key: string };

function service(env: Env): Service | null {
  const url = env.WEB_FETCH_URL?.trim().replace(/\/+$/, "");
  const key = env.WEB_FETCH_KEY?.trim();
  return url && key ? { url, key } : null;
}

/** Which way pages are read, for /status. */
export function webFetchVia(env: Env): string {
  return service(env) ? "web-fetch Worker" : "自己读";
}

export function webFetchTool(env: Env) {
  const via = service(env);
  return tool({
    description:
      "Read one web page (a news article, a post, a link she sent) and get its text as Markdown. " +
      "Use it to open a web_search result or a URL she gives you. " +
      "Pass `query` when you only need part of a long page.",
    inputSchema: z.object({
      url: z.string().describe("The page's full http(s) URL."),
      query: z.string().optional().describe("What you want from the page, in a few words. Optional.")
    }),
    async execute({ url, query }, { abortSignal }) {
      // The web-fetch Worker checks where a name resolves to itself; reading directly, it is checked here.
      const check = via ? validateUrl(url) : await validateUrlWithDns(url);
      if (!check.valid) return `Cannot read this URL: ${check.error}`;
      const signal = abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
      try {
        return render(via ? await throughService(via, url, query, signal) : await directly(url, signal));
      } catch (error) {
        return `Could not read this page: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  });
}

function render(page: Page): string {
  const content = page.content.trim();
  const body = content.length > MAX_CHARS ? `${content.slice(0, MAX_CHARS)}\n\n[cut off here, the page goes on]` : content;
  const head = page.title ? `# ${page.title}\n${page.url}` : page.url;
  return `${head}\n\n${body || "(no readable text on this page)"}`;
}

async function throughService(via: Service, url: string, query: string | undefined, signal: AbortSignal): Promise<Page> {
  const response = await fetch(`${via.url}/fetch`, {
    method: "POST",
    headers: { authorization: `Bearer ${via.key}`, "content-type": "application/json" },
    body: JSON.stringify({ url, ...(query?.trim() ? { query: query.trim() } : {}), max_chars: MAX_CHARS }),
    signal
  });
  const body = (await response.json().catch(() => null)) as { error?: string; url?: string; final_url?: string; title?: string; content?: string } | null;
  if (!response.ok || typeof body?.content !== "string") {
    throw new Error(body?.error || `web-fetch answered HTTP ${response.status}`);
  }
  return { url: body.final_url ?? body.url ?? url, title: body.title, content: body.content };
}

async function directly(url: string, signal: AbortSignal): Promise<Page> {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,text/markdown;q=0.9,text/plain;q=0.8,application/json;q=0.7,*/*;q=0.5",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
    },
    redirect: "follow",
    signal
  });
  if (!response.ok) throw new Error(`the site answered HTTP ${response.status}`);
  const finalUrl = response.url || url;
  if (finalUrl !== url) {
    const check = await validateUrlWithDns(finalUrl);
    if (!check.valid) throw new Error(`redirected somewhere it may not go: ${check.error}`);
  }
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("json") || type.includes("text/plain") || type.includes("text/markdown")) {
    return { url: finalUrl, content: await response.text() };
  }
  if (type && !type.includes("html") && !type.includes("xml")) {
    throw new Error(`it is ${type.split(";")[0]}, not a text page`);
  }
  const { markdown, title } = htmlToMarkdown(await response.text(), finalUrl);
  return { url: finalUrl, title, content: markdown };
}
