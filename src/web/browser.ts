// Pages that only fill in with JavaScript are opened in Cloudflare's headless Chrome through the BROWSER
// binding's `content` quick action (Browser Rendering; Workers Paid includes 10 browser hours a month).
// It is the browser path web-fetch prefers too, and needs no puppeteer. Pictures, fonts and media are not
// loaded, since reading needs only the text. The browser runs on Cloudflare's network, not the Worker's,
// and where it ended up after redirects is checked like any other address before its page is used.

import { validateUrlWithDns } from "./validate-url";

type Rendered = { html: string; url: string; title?: string };

/** The page's HTML after its scripts have run, its title, and where the browser ended up. */
export async function renderInBrowser(binding: BrowserRun, url: string, userAgent: string, timeoutMs: number): Promise<Rendered> {
  const response = await binding.quickAction("content", {
    url,
    userAgent,
    gotoOptions: { waitUntil: "networkidle2", timeout: timeoutMs },
    rejectResourceTypes: ["image", "media", "font"]
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
