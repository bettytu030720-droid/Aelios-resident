// Unit tests for the keys web_fetch carries (src/web/site-keys.ts): how a site and a key are read from the
// settings page, which address gets which key, and the list in SQLite (node:sqlite stands in for the agent's).
// Usage: node test/site-keys.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-sites-"));
const out = join(dir, "site-keys.mjs");
await build({ entryPoints: ["src/web/site-keys.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const k = await import(pathToFileURL(join(process.cwd(), out)).href);
rmSync(dir, { recursive: true, force: true });

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

function store() {
  const db = new DatabaseSync(":memory:");
  const sql = (strings, ...values) => {
    const statement = db.prepare(strings.join("?"));
    return /^\s*SELECT/i.test(strings[0]) ? statement.all(...values) : (statement.run(...values), []);
  };
  return { db, sites: new k.SiteKeyStore(sql) };
}

await test("a site is its https host, typed bare or as any address on it", () => {
  assert.deepEqual(k.siteHost("Example.com"), { host: "example.com" });
  assert.deepEqual(k.siteHost(" https://Docs.Example.com/a/b?c=1 "), { host: "docs.example.com" });
  assert.deepEqual(k.siteHost("example.com:8443"), { host: "example.com:8443" });
  assert.match(k.siteHost("").error, /要填网站/);
  assert.match(k.siteHost("http://example.com").error, /只给 https/);
  assert.match(k.siteHost("https://user:pw@example.com").error, /用户名密码/);
  assert.match(k.siteHost("team.cloudflareaccess.com").error, /登录页/);
  for (const local of ["localhost", "127.0.0.1", "10.0.0.2", "https://192.168.1.1/", "[::1]"]) assert.match(k.siteHost(local).error ?? "", /不能读|认不出/, local);
});

await test("a key: one bare token goes as a bearer token, lines of name: value as those headers", () => {
  assert.deepEqual(k.keyHeaders(" github_pat_abc "), { headers: { Authorization: "Bearer github_pat_abc" } });
  assert.deepEqual(k.keyHeaders("Bearer xyz"), { headers: { Authorization: "Bearer xyz" } });
  assert.deepEqual(k.keyHeaders("Bearer: xyz"), { headers: { Authorization: "Bearer xyz" } });
  assert.deepEqual(k.keyHeaders("bearer   xyz"), { headers: { Authorization: "Bearer xyz" } });
  assert.deepEqual(k.keyHeaders("CF-Access-Client-Id: id.access\r\nCF-Access-Client-Secret:  s3cret \n\n"), {
    headers: { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "s3cret" }
  });
  assert.deepEqual(k.keyHeaders("x-api-key: k1"), { headers: { "x-api-key": "k1" } });
  assert.deepEqual(k.keyHeaders("Accept: application/vnd.github.raw\nAuthorization: Bearer t"), {
    headers: { Accept: "application/vnd.github.raw", Authorization: "Bearer t" }
  });
  assert.match(k.keyHeaders("  ").error, /要填钥匙/);
  assert.match(k.keyHeaders("a: 1\njust words").error, /名字: 值/);
  assert.match(k.keyHeaders("Host: evil.example").error, /Host 不能/);
  assert.match(k.keyHeaders("Cookie: a=1\ncookie: b=2").error, /写了两遍/);
  assert.match(k.keyHeaders(Array.from({ length: 7 }, (_, i) => `X-${i}: v`).join("\n")).error, /最多 6 行/);
  assert.match(k.keyHeaders("x".repeat(5000)).error, /太长/);
  assert.deepEqual(k.keyHeaders("ghp_abc\u3000"), { headers: { Authorization: "Bearer ghp_abc" } }, "a full-width space pasted along is trimmed");
  assert.match(k.keyHeaders("ghp_\u3000abc").error, /发不出去/);
  assert.match(k.keyHeaders("CF-Access-Client-Id: 钥匙").error, /CF-Access-Client-Id 里有发不出去的字/);
  assert.match(k.keyHeaders("ghp_a\tb").error, /发不出去/);
});

await test("an address gets its own site's key over https only, by exact host", () => {
  const keys = [{ host: "gated.example", headers: { A: "1" } }, { host: "raw.githubusercontent.com", headers: { Authorization: "Bearer t" } }];
  assert.deepEqual(k.headersFor(keys, "https://gated.example/a/x"), { A: "1" });
  assert.deepEqual(k.headersFor(keys, "https://GATED.example/"), { A: "1" });
  assert.equal(k.headersFor(keys, "http://gated.example/a/x"), null);
  assert.equal(k.headersFor(keys, "https://evil.gated.example/"), null);
  assert.equal(k.headersFor(keys, "https://gated.example.evil.test/"), null);
  assert.equal(k.headersFor(keys, "https://gated.example:8443/"), null);
  assert.equal(k.headersFor(keys, "not a url"), null);
  assert.ok(k.isAccessSignIn("https://team.cloudflareaccess.com/cdn-cgi/access/login/x"));
  assert.ok(!k.isAccessSignIn("https://cloudflareaccess.com.evil.test/"));
});

await test("the list: saved and replaced by site, shown without the values, at most 10 sites", () => {
  const { sites } = store();
  assert.deepEqual(sites.put("https://gated.example/a/", "CF-Access-Client-Id: i\nCF-Access-Client-Secret: s"), { host: "gated.example" });
  assert.deepEqual(sites.list(), [{ host: "gated.example", names: ["CF-Access-Client-Id", "CF-Access-Client-Secret"] }]);
  assert.ok(!JSON.stringify(sites.list()).includes('"s"') && !JSON.stringify(sites.list()).includes(": s"), "no values in the list");
  sites.put("gated.example", "new-token");
  assert.deepEqual(sites.all(), [{ host: "gated.example", headers: { Authorization: "Bearer new-token" } }]);
  assert.match(sites.put("localhost", "t").error, /不能读/);
  assert.match(sites.put("example.com", "").error, /要填钥匙/);
  for (let i = 1; i < 10; i += 1) assert.ok(!sites.put(`s${i}.example`, "t").error);
  assert.match(sites.put("eleven.example", "t").error, /最多 10 个网站/);
  assert.ok(!sites.put("gated.example", "again").error, "replacing one is fine at the limit");
  sites.remove(" GATED.example ");
  assert.equal(sites.all().length, 9);
  assert.ok(!sites.all().some((key) => key.host === "gated.example"));
});
