import { markdownPlain } from '../public/markdown.js';
// The web door on the home screen: public/home-screen.js (the card and the settings row), public/sw.js (the page with
// no network) and /manifest.webmanifest (one app per resident).
// Usage:
//   node test/home-screen.mjs          the page's parts, no Worker needed
//   node test/home-screen.mjs worker   also asks the local Worker (mock-server.mjs on :9999, wrangler dev on :8787
//                                      with wrangler.test.jsonc) for the manifests, like test/run.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync("public/index.html", "utf8");
assert.ok(html.includes('<script src="/home-screen.js"></script>'), "the page loads home-screen.js");
assert.ok(html.indexOf("/home-screen.js") < html.indexOf("/vendor/alpine"), "before Alpine starts, so an early prompt is kept");

// ---- the page's part, with a browser made of plain objects ----
function browser({ ua = "Mozilla/5.0 (Linux; Android 14) Chrome/150", standalone = false, touch = true, native = false } = {}) {
  const listeners = {};
  const links = { manifest: { href: "/manifest.webmanifest" }, "apple-touch-icon": { href: "/icon-192.png" } };
  const store = {};
  const document = {
    title: "住户",
    querySelector(selector) {
      const rel = selector.match(/^link\[rel="([^"]+)"\]$/)?.[1];
      const link = rel && links[rel];
      return link ? { setAttribute(name, value) { link[name] = value; } } : null;
    }
  };
  const context = {
    document,
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } },
    navigator: { userAgent: ua, maxTouchPoints: touch ? 5 : 0 },
    matchMedia: (q) => ({ matches: q === "(display-mode: standalone)" ? standalone : q === "(pointer: coarse)" ? touch : false }),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    dispatchEvent: (event) => { for (const fn of listeners[event.type] || []) fn(event); },
    Event: class { constructor(type) { this.type = type; } }
  };
  context.window = context;
  if (native) context.Capacitor = { isNativePlatform: () => true };
  vm.createContext(context);
  vm.runInContext(readFileSync("public/home-screen.js", "utf8"), context);
  const page = Object.assign({ miniApp: false, resident: "default", identity: { name: "小助手", avatar: null }, lines: [1, 2, 3], pushInvite: () => false },
    vm.runInContext("homeScreenPage()", context));
  const prompt = () => {
    const event = { type: "beforeinstallprompt", prevented: false, asked: 0, outcome: "accepted", preventDefault() { this.prevented = true; } };
    event.prompt = async () => { event.asked++; };
    Object.defineProperty(event, "userChoice", { get: () => Promise.resolve({ outcome: event.outcome }) });
    context.dispatchEvent(event);
    return event;
  };
  return { page, prompt, links, document, store, fire: (type) => context.dispatchEvent({ type }) };
}

{
  const b = browser();
  b.page.prepareHome();
  assert.equal(b.page.home.can, "", "nothing to offer before the browser says it can install");
  assert.equal(b.page.homeInvite(), false);
  const event = b.prompt();
  assert.equal(event.prevented, true, "the browser's own banner is held back");
  assert.equal(b.page.home.can, "prompt", "the prompt that came is kept for the button");
  assert.equal(b.page.homeInvite(), true, "asked in the chat");
  b.page.pushInvite = () => true;
  assert.equal(b.page.homeInvite(), false, "after the notifications card");
  b.page.pushInvite = () => false;
  b.page.lines = [1];
  assert.equal(b.page.homeInvite(), false, "not on an almost empty chat");
  b.page.lines = [1, 2, 3];
  await b.page.addToHome();
  assert.equal(event.asked, 1, "the button asks with the browser's prompt");
  assert.equal(b.page.home.can, "", "a prompt is good for one ask");
  assert.equal(b.page.home.asked, "no", "added: the card does not come back");
  assert.equal(b.store["resident.home.ask"], "no");
  await b.page.addToHome();
  assert.equal(event.asked, 1, "no second ask with a used prompt");
  console.log("PASS the browser's install prompt: kept, offered once in the chat after the notifications card, used once");
}
{
  const b = browser();
  b.page.prepareHome();
  const event = b.prompt();
  event.outcome = "dismissed";
  await b.page.addToHome();
  assert.equal(b.page.home.asked, "", "turned down in the browser's dialog: the card may ask again with a new prompt");
  b.prompt();
  assert.equal(b.page.home.can, "prompt");
  b.page.dismissHome();
  assert.equal(b.page.homeInvite(), false, "not now: no card");
  assert.equal(b.page.home.can, "prompt", "the settings row still has the button");
  b.fire("appinstalled");
  assert.equal(b.page.home.can, "", "installed some other way: nothing left to offer");
  console.log("PASS not now hides the card for good, the settings row stays; installed elsewhere hides both");
}
{
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
  const b = browser({ ua: iphone });
  b.page.prepareHome();
  assert.equal(b.page.home.can, "ios", "Safari has no prompt: the page says where its button is");
  assert.equal(b.page.homeInvite(), true);
  const ipad = browser({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15" });
  ipad.page.prepareHome();
  assert.equal(ipad.page.home.can, "ios", "an iPad asking for the desktop site");
  const mac = browser({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", touch: false });
  mac.page.prepareHome();
  assert.equal(mac.page.home.can, "", "a Mac is not an iPad");
  for (const [what, opts] of [["opened from the home screen", { ua: iphone, standalone: true }], ["the Android app", { native: true }]]) {
    const other = browser(opts);
    other.page.prepareHome();
    other.prompt();
    assert.equal(other.page.home.can, "", what);
  }
  const mini = browser();
  mini.page.miniApp = true;
  mini.page.prepareHome();
  mini.prompt();
  assert.equal(mini.page.home.can, "", "inside Telegram");
  const desk = browser({ touch: false });
  desk.page.prepareHome();
  desk.prompt();
  assert.equal(desk.page.homeInvite(), false, "a computer gets no card in the chat");
  assert.equal(desk.page.home.can, "prompt", "but the settings row");
  console.log("PASS iPhone and iPad get Safari's steps; nothing offered from the home screen, in the Android app or inside Telegram; no card on a computer");
}
{
  const b = browser();
  b.page.prepareHome();
  assert.deepEqual([b.links.manifest.href, b.links["apple-touch-icon"].href, b.document.title], ["/manifest.webmanifest", "/icon-192.png", "小助手"]);
  b.page.resident = "mochi";
  b.page.identity = { name: "麻薯", avatar: "/r/mochi/avatar/0123456789abcdef0123456789abcdef" };
  b.page.followHome();
  assert.deepEqual([b.links.manifest.href, b.links["apple-touch-icon"].href, b.document.title],
    ["/r/mochi/manifest.webmanifest", "/r/mochi/avatar/0123456789abcdef0123456789abcdef", "麻薯"], "another resident: its own app, icon and name");
  b.page.resident = "default";
  b.page.identity = { name: "住户", avatar: null };
  b.page.followHome();
  assert.deepEqual([b.links.manifest.href, b.links["apple-touch-icon"].href], ["/manifest.webmanifest", "/icon-192.png"], "back to the first one");
  console.log("PASS the home screen's icon, name and app follow the resident on the page");
}

// ---- the service worker: the page itself only, and a note when there is no network ----
{
  const handlers = {};
  const sw = {
    self: { addEventListener: (type, fn) => { handlers[type] = fn; }, registration: {}, clients: {} },
    Response, Promise, fetch: async () => { throw new TypeError("Failed to fetch"); }
  };
  vm.createContext(sw);
  vm.runInContext(readFileSync("public/sw.js", "utf8"), sw);
  let answered = null;
  handlers.fetch({ request: { mode: "cors", url: "/web/messages" }, respondWith: (r) => { answered = r; } });
  assert.equal(answered, null, "the page's API calls do not go through it");
  handlers.fetch({ request: { mode: "navigate", url: "/" }, preloadResponse: Promise.resolve(undefined), respondWith: (r) => { answered = r; } });
  const offline = await answered;
  assert.equal(offline.status, 503);
  assert.match(offline.headers.get("content-type"), /text\/html/);
  const text = await offline.text();
  assert.match(text, /连不上网/);
  assert.match(text, /addEventListener\('online'/, "it opens again by itself");
  const page = new Response("the page");
  handlers.fetch({ request: { mode: "navigate", url: "/" }, preloadResponse: Promise.resolve(page), respondWith: (r) => { answered = r; } });
  assert.equal(await answered, page, "online: the page as the Worker sent it");
  sw.fetch = async () => new Response("fetched");
  handlers.fetch({ request: { mode: "navigate", url: "/" }, preloadResponse: Promise.resolve(undefined), respondWith: (r) => { answered = r; } });
  assert.equal(await (await answered).text(), "fetched", "no preload: fetched as usual");
  console.log("PASS the service worker only answers for the page, and with no network shows a note that reopens it");
}

// ---- which resident an icon opens on: the real app.js start(), opened at the app's start_url ----
async function openedOn(startUrl, remembered) {
  const url = new URL(startUrl, "https://resident.test");
  const store = { "resident.current": remembered };
  const noop = () => {};
  const context = {
    location: { search: url.search, hash: "", origin: url.origin, href: url.href },
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    document: { documentElement: { dataset: {} }, addEventListener: noop, querySelector: () => null, title: "" },
    navigator: { userAgent: "test" },
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    fetch: () => Promise.reject(new Error("offline")),
    addEventListener: noop, dispatchEvent: noop, Event: class {},
    setTimeout, clearTimeout, console, URL, URLSearchParams, Promise
  };
  context.window = context;
  context.telegramReady = Promise.resolve(true);
  vm.createContext(context);
  context.markdownPlain = markdownPlain;
  for (const file of ["public/machine-ask-kind.js", "public/app.js", "public/home-screen.js"]) vm.runInContext(readFileSync(file, "utf8"), context);
  const page = vm.runInContext("resident()", context);
  page.$nextTick = noop;
  await page.start();
  return page.resident;
}
assert.equal(await openedOn("/?r=default", "mochi"), "default", "the first resident's icon opens on it, whoever was opened last");
assert.equal(await openedOn("/?r=mochi", "default"), "mochi", "another resident's icon opens on that one");
assert.equal(await openedOn("/", "mochi"), "mochi", "the plain address still goes back to the one opened last");
console.log("PASS each icon opens on its own resident, not on the one this browser opened last");

// ---- the manifests, from the local Worker ----
if (process.argv[2] === "worker") {
  const WORKER = process.env.WORKER_URL || "http://127.0.0.1:8787";
  const KEY = "test-web-key";
  const post = (path, body) => fetch(WORKER + path, { method: "POST", headers: { "x-web-key": KEY, "content-type": "application/json" }, body: JSON.stringify(body) });
  const first0 = await (await fetch(`${WORKER}/manifest.webmanifest`)).json();
  assert.deepEqual([first0.id, first0.start_url, first0.scope, first0.display], ["/", "/?r=default", "/", "standalone"], "the first resident's app keeps its id and opens on it");
  assert.equal(await openedOn(first0.start_url, "homeapp"), "default", "after another resident was open, its icon still opens on it");
  assert.equal((await fetch(`${WORKER}/r/nobody/manifest.webmanifest`)).status, 404, "no app for a resident that is not there");
  const made = await post("/web/residents", { id: "homeapp", name: "麻薯" });
  assert.equal(made.status, 200, await made.clone().text());
  try {
    const response = await fetch(`${WORKER}/r/homeapp/manifest.webmanifest`);
    assert.match(response.headers.get("content-type"), /manifest\+json/);
    const app = await response.json();
    assert.deepEqual([app.id, app.start_url, app.scope, app.name], ["/?r=homeapp", "/?r=homeapp", "/", "麻薯"], "another resident: an app of its own that opens on it");
    assert.equal(await openedOn(app.start_url, "default"), "homeapp");
    assert.deepEqual(app.icons.map((i) => [i.src, i.type, i.purpose]), [["/icon-192.png", "image/png", "any maskable"], ["/icon-512.png", "image/png", "any maskable"]]);
    // A JPEG avatar: its address has no extension, so the type has to be written out or Chrome will not install.
    const jpeg = new Uint8Array(64);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
    const put = await fetch(`${WORKER}/r/homeapp/web/avatar`, { method: "POST", headers: { "x-web-key": KEY, "content-type": "image/jpeg" }, body: jpeg });
    assert.equal(put.status, 200, await put.clone().text());
    const { avatar } = await put.json();
    const withAvatar = await (await fetch(`${WORKER}/r/homeapp/manifest.webmanifest`)).json();
    assert.deepEqual(withAvatar.icons, [{ src: avatar, sizes: "512x512", type: "image/jpeg", purpose: "any maskable" }],
      "the avatar alone, typed, and maskable so Android shows it rather than the stock icon");
    const first = await (await fetch(`${WORKER}/manifest.webmanifest`)).json();
    assert.equal(first.icons[0].src, "/icon-192.png", "the first resident keeps its own icon");
  } finally {
    const gone = await post("/web/residents/remove", { id: "homeapp" });
    if (gone.status !== 200) console.log("could not remove the test resident:", gone.status, await gone.text());
  }
  console.log("PASS each resident's manifest: the first one keeps its id, each opens on its own resident, none for an unknown one");
}
