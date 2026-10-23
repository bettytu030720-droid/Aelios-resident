// Keys for sites web_fetch reads, like the network secrets of a cloud environment: a key belongs to one site,
// goes out only in requests to that site over https, and the model never sees it. A site behind Cloudflare
// Access takes a service token (two headers); a private GitHub repository's raw files take a token.
//
// A key is written as on the settings page: one `Header-Name: value` per line, or a bare token, which goes
// out as `Authorization: Bearer <token>`.

import type { Sql } from "../sticker-store";
import { validateUrl } from "./validate-url";

export const MAX_SITES = 10;
const MAX_HEADERS = 6;
const MAX_VALUE = 4000;
// Headers a key may not set: they belong to the request itself.
const RESERVED = /^(host|content-length|content-type|connection|transfer-encoding|upgrade|te|trailer|keep-alive|expect|proxy-.*|accept-encoding)$/i;

// What a header value can carry: printable ASCII and spaces. Anything else would make every request to the site fail.
const SENDABLE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

export type SiteKey = { host: string; headers: Record<string, string> };

/** A site's host from what was typed: a bare host, or any https address on it. */
export function siteHost(value: string): { host: string } | { error: string } {
  const text = value.trim().toLowerCase();
  if (!text) return { error: "要填网站，比如 example.com" };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`);
  } catch {
    return { error: "认不出这个网站" };
  }
  if (url.protocol !== "https:") return { error: "只给 https 的网站带钥匙" };
  if (url.username || url.password) return { error: "网站里别带用户名密码，填进钥匙里" };
  if (isAccessSignIn(`https://${url.host}/`)) return { error: "这是 Cloudflare Access 的登录页，钥匙要给被它挡住的那个网站" };
  const check = validateUrl(`https://${url.host}/`);
  if (!check.valid) return { error: `这个网站不能读：${check.error}` };
  return { host: url.host };
}

/** The headers a key goes out as, or why it cannot be used. */
export function keyHeaders(text: string): { headers: Record<string, string> } | { error: string } {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return { error: "要填钥匙" };
  const named = lines.map((line) => line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(\S.*)$/));
  if (lines.length === 1 && (!named[0] || named[0][1].toLowerCase() === "bearer")) {
    // A bare token, `Bearer <token>`, or `Bearer: <token>`.
    const value = (named[0] ? named[0][2] : lines[0]).replace(/^bearer\s+/i, "").trim();
    if (value.length > MAX_VALUE) return { error: "钥匙太长了" };
    if (!SENDABLE.test(value)) return { error: "钥匙里有发不出去的字，比如中文、全角符号或制表符，看看是不是多粘了东西" };
    return { headers: { Authorization: `Bearer ${value}` } };
  }
  if (named.some((match) => !match)) return { error: "好几行时，每行写成「名字: 值」" };
  if (lines.length > MAX_HEADERS) return { error: `最多 ${MAX_HEADERS} 行` };
  const headers: Record<string, string> = {};
  for (const match of named as RegExpMatchArray[]) {
    const [, name, value] = match;
    if (RESERVED.test(name)) return { error: `${name} 不能放进钥匙` };
    if (value.length > MAX_VALUE) return { error: `${name} 太长了` };
    if (!SENDABLE.test(value.trim())) return { error: `${name} 里有发不出去的字，比如中文、全角符号或制表符，看看是不是多粘了东西` };
    if (Object.keys(headers).some((have) => have.toLowerCase() === name.toLowerCase())) return { error: `${name} 写了两遍` };
    headers[name] = value.trim();
  }
  return { headers };
}

/** The key for an address, when it is an https address on a site that has one. */
export function headersFor(keys: readonly SiteKey[], url: string): Record<string, string> | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.host.toLowerCase();
  return keys.find((key) => key.host === host)?.headers ?? null;
}

/** Cloudflare Access sends a visitor without a pass to its sign-in page on this host. */
export function isAccessSignIn(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".cloudflareaccess.com");
  } catch {
    return false;
  }
}

/** The keys, in the resident's own SQLite. Only the hosts and the header names ever leave it. */
export class SiteKeyStore {
  constructor(private readonly sql: Sql) {
    sql`CREATE TABLE IF NOT EXISTS res_site_keys (host TEXT PRIMARY KEY, headers TEXT NOT NULL, at INTEGER NOT NULL)`;
  }

  all(): SiteKey[] {
    return this.sql<{ host: string; headers: string }>`SELECT host, headers FROM res_site_keys ORDER BY at`.map((row) => ({
      host: row.host,
      headers: JSON.parse(row.headers) as Record<string, string>
    }));
  }

  /** The sites as the settings page shows them: the host and which headers the key sets, never their values. */
  list(): { host: string; names: string[] }[] {
    return this.all().map((key) => ({ host: key.host, names: Object.keys(key.headers) }));
  }

  /** Adds a site's key, or replaces it. */
  put(site: string, key: string): { host: string } | { error: string } {
    const host = siteHost(site);
    if ("error" in host) return host;
    const headers = keyHeaders(key);
    if ("error" in headers) return headers;
    const known = this.all().some((have) => have.host === host.host);
    if (!known && this.all().length >= MAX_SITES) return { error: `最多 ${MAX_SITES} 个网站` };
    this.sql`INSERT OR REPLACE INTO res_site_keys (host, headers, at) VALUES (${host.host}, ${JSON.stringify(headers.headers)}, ${Date.now()})`;
    return host;
  }

  remove(host: string): void {
    this.sql`DELETE FROM res_site_keys WHERE host = ${host.trim().toLowerCase()}`;
  }
}
