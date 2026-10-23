// web_fetch: read one page as Markdown. Built into the resident the way
// https://github.com/sakisakisa-design/web-fetch reads pages, with nothing else to deploy:
//
//   1. A plain fetch first, every redirect checked before it is followed.
//   2. A page that comes back nearly empty (built by JavaScript) or is refused is opened in
//      Cloudflare's browser (browser.ts), when the BROWSER binding is there.
//   3. What was read is kept for an hour (PageCache, in the resident's own storage), so asking
//      something else about the same page costs no second fetch.
//   4. A long page is shrunk by a small model before the resident sees it (compress.ts), down to
//      the parts about `query` when one is given, so one page does not fill the conversation.
//   5. A site with a key on the settings page (site-keys.ts) gets it in every request to that site and
//      no other, and is never opened in the browser, which would not carry it.
//
// Private and local addresses are refused at every step.

import { tool } from "ai";
import { z } from "zod";
import { renderInBrowser } from "./browser";
import { compressPage, type Compressor } from "./compress";
import { htmlToMarkdown } from "./html-to-markdown";
import { headersFor, isAccessSignIn, type SiteKey } from "./site-keys";
import { validateUrlWithDns } from "./validate-url";

// What the model gets back at most.
const MAX_CHARS = 12_000;
// What the cache keeps of a page: more than compression ever reads (8 sections of about 6000 tokens).
const CACHE_CHARS = 200_000;
// Bytes read from a response at most; the rest of a huge page is dropped.
const MAX_BYTES = 5_000_000;
// Below this much visible text, the plain fetch most likely got an empty JavaScript shell.
const THIN_CHARS = 500;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;
const BROWSER_TIMEOUT_MS = 20_000;
const TOOL_TIMEOUT_MS = 90_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export type Page = { url: string; title?: string; content: string; browser?: boolean; note?: string };

/** Pages read in the last hour, by the URL that was asked for. */
export type PageCache = { get(url: string): Page | null; put(url: string, page: Page): void };

/** What web_fetch reads with. Missing parts are skipped: no browser, no compression, no cache, no keys. */
export type Reader = { browser?: BrowserRun; compressor: Compressor | null; cache?: PageCache; keys?: readonly SiteKey[] };

/** A refusal the browser must not retry: the address is not allowed, or the page is not there or not text. */
class Final extends Error {}

export function readerFor(env: Env, compressor: Compressor | null, cache?: PageCache, keys?: readonly SiteKey[]): Reader {
  // Undefined when the binding is not configured (the local test config has none).
  return { browser: (env as { BROWSER?: BrowserRun }).BROWSER, compressor, cache, keys };
}

/** How pages are read, for /status. */
export function webFetchVia(reader: Reader): string {
  const browser = reader.browser ? "JS 页面用浏览器" : "没有浏览器绑定";
  const compress = reader.compressor ? `长页用 ${reader.compressor.name} 压` : "长页不压";
  return `自己读（${browser}，${compress}）`;
}

export function webFetchTool(reader: Reader) {
  const keyed = (reader.keys ?? []).map((key) => key.host);
  return tool({
    description:
      "Read one web page (a news article, a post, a link she sent) and get its text as Markdown. " +
      "Use it to open a web_search result or a URL she gives you. " +
      "Pass `query` when you only need part of a long page." +
      (keyed.length ? ` They gave you a key for ${keyed.join(", ")}, so the private pages there open too.` : ""),
    inputSchema: z.object({
      url: z.string().describe("The page's full http(s) URL."),
      query: z.string().optional().describe("What you want from the page, in a few words. Optional.")
    }),
    async execute({ url, query }, { abortSignal }) {
      const check = await validateUrlWithDns(url);
      if (!check.valid) return `Cannot read this URL: ${check.error}`;
      const timeout = AbortSignal.timeout(TOOL_TIMEOUT_MS);
      const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
      try {
        let page = cached(reader, url);
        if (!page) {
          page = await readPage(reader, url, signal);
          remember(reader, url, page);
        }
        // What the model made of this page for this question is kept too, so asking it again costs nothing.
        const asked = `${url}\n${query?.trim() ?? ""}`;
        const done = cached(reader, asked);
        if (done) return render(page, done.content, done.note);
        const shrunk = await compressPage(reader.compressor, page.content, query, signal);
        if (shrunk.content !== page.content && !signal.aborted) remember(reader, asked, { url, content: shrunk.content, note: shrunk.note });
        return render(page, shrunk.content, shrunk.note);
      } catch (error) {
        return `Could not read this page: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  });
}

function cached(reader: Reader, url: string): Page | null {
  try {
    return reader.cache?.get(url) ?? null;
  } catch {
    return null;
  }
}

function remember(reader: Reader, url: string, page: Page): void {
  try {
    reader.cache?.put(url, { ...page, content: page.content.slice(0, CACHE_CHARS) });
  } catch (error) {
    console.error("web_fetch: could not cache the page", { error: String(error) });
  }
}

function render(page: Page, content: string, note?: string): string {
  const head = [page.title ? `# ${page.title}` : "", page.url, page.browser ? "(opened in a browser)" : "", note ? `(${note})` : ""]
    .filter(Boolean)
    .join("\n");
  const body = content.trim();
  const clipped = body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS)}\n\n[cut off here, the page goes on]` : body;
  return `${head}\n\n${clipped || "(no readable text on this page)"}`;
}

/** Read a page: plainly first, in the browser when that comes back empty or refused. */
export async function readPage(reader: Pick<Reader, "browser" | "keys">, url: string, signal: AbortSignal): Promise<Page> {
  const keys = reader.keys ?? [];
  let plain: (Page & { thin: boolean }) | null = null;
  let failure = "";
  try {
    plain = await plainFetch(url, signal, keys);
    if (!plain.thin) return stripThin(plain);
  } catch (error) {
    if (error instanceof Final || signal.aborted) throw error;
    failure = error instanceof Error ? error.message : String(error);
  }
  // The browser would open a keyed page without its key, and might be sent its sign-in page instead.
  if (!reader.browser || headersFor(keys, url)) {
    if (plain) return stripThin(plain);
    throw new Error(failure);
  }
  try {
    const rendered = await renderInBrowser(reader.browser, url, USER_AGENT, BROWSER_TIMEOUT_MS);
    const { markdown, title } = htmlToMarkdown(rendered.html, rendered.url);
    const name = title || rendered.title;
    return { url: rendered.url, ...(name ? { title: name } : {}), content: markdown, browser: true };
  } catch (error) {
    console.error("web_fetch: the browser could not open the page", { error: String(error) });
    if (plain) return stripThin(plain);
    throw new Error(`${failure}, and the browser could not open it either`);
  }
}

function stripThin({ thin: _thin, ...page }: Page & { thin: boolean }): Page {
  return page;
}

/** The request's headers with a key's in place of any of the same name, whatever its case (an Accept in a key wins). */
function withKey(base: Record<string, string>, key: Record<string, string> | null): Headers {
  const headers = new Headers(base);
  for (const [name, value] of Object.entries(key ?? {})) headers.set(name, value);
  return headers;
}

async function plainFetch(url: string, signal: AbortSignal, keys: readonly SiteKey[] = []): Promise<Page & { thin: boolean }> {
  const fetchSignal = AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
  const dns = new Map<string, Promise<string[]>>();
  let current = url;
  let response: Response;
  // The key is looked up again at every hop: it goes to its own site only, never along a redirect elsewhere.
  let key = headersFor(keys, current);
  for (let hop = 0; ; hop++) {
    response = await fetch(current, {
      headers: withKey(
        {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,text/markdown;q=0.9,text/plain;q=0.8,application/json;q=0.7,*/*;q=0.5",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
        },
        key
      ),
      redirect: "manual",
      signal: fetchSignal
    });
    const location = REDIRECTS.has(response.status) ? response.headers.get("location") : null;
    if (!location) break;
    await response.body?.cancel();
    if (hop === MAX_REDIRECTS) throw new Error(`it redirected more than ${MAX_REDIRECTS} times`);
    const next = new URL(location, current).toString();
    if (isAccessSignIn(next)) {
      const host = new URL(current).host;
      throw new Final(
        key
          ? `${host} is behind Cloudflare Access and did not let the key in: the key is wrong or has expired, or the Access application has no Service Auth policy for it`
          : `${host} is behind Cloudflare Access (a sign-in page); they can add a key for ${host} on the settings page`
      );
    }
    const check = await validateUrlWithDns(next, dns);
    if (!check.valid) throw new Final(`it redirected somewhere it may not go: ${check.error}`);
    current = next;
    key = headersFor(keys, current);
  }
  if (!response.ok) {
    await response.body?.cancel();
    const refused = key && (response.status === 401 || response.status === 403) ? ", which refused the key" : "";
    const message = `the site answered HTTP ${response.status}${refused}`;
    throw response.status === 404 || response.status === 410 || refused ? new Final(message) : new Error(message);
  }
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("json") || type.includes("text/plain") || type.includes("text/markdown")) {
    return { url: current, content: await readText(response, type), thin: false };
  }
  if (type && !type.includes("html") && !type.includes("xml")) {
    await response.body?.cancel();
    throw new Final(`it is ${type.split(";")[0]}, not a text page`);
  }
  const { markdown, title, textLength } = htmlToMarkdown(await readText(response, type), current);
  return { url: current, ...(title ? { title } : {}), content: markdown, thin: textLength < THIN_CHARS };
}

/** The body as text, at most MAX_BYTES of it, in the charset the page declares (many Chinese sites still use GBK). */
async function readText(response: Response, type: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const bytes = new Uint8Array(Math.min(size, MAX_BYTES));
  let offset = 0;
  for (const part of parts) {
    const take = part.subarray(0, Math.min(part.byteLength, bytes.byteLength - offset));
    bytes.set(take, offset);
    offset += take.byteLength;
    if (offset === bytes.byteLength) break;
  }
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const declared = /charset=["']?([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  try {
    return new TextDecoder(declared ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
