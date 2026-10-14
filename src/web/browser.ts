// Pages that only fill in with JavaScript are opened in Cloudflare's headless Chrome through the BROWSER
// binding's `content` quick action (Browser Rendering; Workers Paid includes 10 browser hours a month).
// It is the browser path web-fetch prefers too, and needs no puppeteer. Pictures, fonts and media are not
// loaded, since reading needs only the text.
//
// The browser runs on Cloudflare's machines, not the Worker's, and a quick action cannot check each request
// the way web-fetch's puppeteer interceptor does. So requests to local and private IP addresses written out
// in the URL are refused up front (rejectRequestPattern), and where the browser ended up is checked after
// the fact; a public name that resolves to a private address is only caught in that last check.

import { validateUrlWithDns } from "./validate-url";

type Rendered = { html: string; url: string; title?: string };

// Local and private addresses as they appear in a URL: localhost, 127/8, 10/8, 0/8, 169.254/16, 192.168/16,
// 172.16/12, 100.64/10 and IPv6 loopback, unique-local and link-local.
const PRIVATE_URLS = [
  String.raw`^[a-z]+://([^/@]*@)?(localhost|[^/@:]*\.localhost)([:/]|$)`,
  String.raw`^[a-z]+://([^/@]*@)?(127|10|0)\.\d+\.\d+\.\d+`,
  String.raw`^[a-z]+://([^/@]*@)?(169\.254|192\.168)\.`,
  String.raw`^[a-z]+://([^/@]*@)?172\.(1[6-9]|2\d|3[01])\.`,
  String.raw`^[a-z]+://([^/@]*@)?100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.`,
  String.raw`^[a-z]+://([^/@]*@)?\[(::1?|f[cd][0-9a-f]*:|fe80:)`
];

/** The page's HTML after its scripts have run, its title, and where the browser ended up. */
export async function renderInBrowser(binding: BrowserRun, url: string, userAgent: string, timeoutMs: number): Promise<Rendered> {
  const response = await binding.quickAction("content", {
    url,
    userAgent,
    gotoOptions: { waitUntil: "networkidle2", timeout: timeoutMs },
    rejectResourceTypes: ["image", "media", "font"],
    rejectRequestPattern: PRIVATE_URLS
  });
  const body = (await response.json().catch(() => null)) as
    | { success: true; result: string; meta?: { status?: number; title?: string; finalUrl?: string } }
    | { success: false; errors?: { message?: string }[] }
    | null;
  if (!body?.success) {
    const reason = body && !body.success ? body.errors?.[0]?.message : undefined;
    throw new Error(`the browser answered HTTP ${response.status}${reason ? `: ${reason}` : ""}`);
  }
  const status = body.meta?.status ?? 200;
  if (status >= 400) throw new Error(`the site answered the browser with HTTP ${status}`);
  const finalUrl = body.meta?.finalUrl || url;
  if (finalUrl !== url) {
    const check = await validateUrlWithDns(finalUrl);
    if (!check.valid) throw new Error(`the browser was sent somewhere it may not go: ${check.error}`);
  }
  return { html: body.result, url: finalUrl, ...(body.meta?.title ? { title: body.meta.title } : {}) };
}
