// Boxes that dial out: the pairing and routing store (src/box-registry.ts), the wire (src/box-protocol.ts), the turns
// in flight (src/box-turns.ts) and the box's side of the socket (acp-box/link.mjs), joined by a fake WebSocket pair.
// No Worker, no real helper. The real Durable Object (hibernation, revoke closing the socket) is the `box` phase of
// test/run.mjs. Usage: node test/box-link.mjs
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "box-link-"));
await build({ entryPoints: ["src/box-registry.ts", "src/box-protocol.ts", "src/box-turns.ts"], bundle: true, platform: "node", format: "esm", outdir: dir, outExtension: { ".js": ".mjs" }, logLevel: "error" });
const at = (path) => import(pathToFileURL(join(process.cwd(), path)).href);
const { BoxRegistry, BoxError } = await at(join(dir, "box-registry.mjs"));
const protocol = await at(join(dir, "box-protocol.mjs"));
const { BoxTurns } = await at(join(dir, "box-turns.mjs"));
const { runLink, REVOKED } = await at("acp-box/link.mjs");
const config = await at("acp-box/config.mjs");
const { createEngines, KIRO_UNREACHABLE } = await at("acp-box/engines.mjs");

let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n${error.stack ?? error}`);
  }
}
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const logRecord = (lines, label) => JSON.parse(lines.find((line) => line.startsWith(label)).slice(label.length));
const refused = (status) => (error) => error instanceof BoxError && error.status === status;

function registry() {
  const db = new DatabaseSync(":memory:");
  const sql = (strings, ...values) => {
    const statement = db.prepare(strings.join("?"));
    return /^\s*SELECT/i.test(strings[0]) ? statement.all(...values) : (statement.run(...values), []);
  };
  const atomic = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  return { db, store: new BoxRegistry(sql, atomic) };
}
async function paired(store, name = "Box") {
  const { code } = await store.code();
  return store.pair({ code, name });
}

await step("pairing: a code works once, only before it expires; the token is kept hashed", async () => {
  const { db, store } = registry();
  const { code } = await store.code();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const first = await store.pair({ code: code.toLowerCase(), name: "Home Mac" });
  assert.match(first.token, /^bt_[0-9a-f]{16}\.[0-9a-f]{64}$/);
  await assert.rejects(store.pair({ code, name: "again" }), refused(403));
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM res_box").all()).includes(first.token.split(".")[1]), "only a hash is kept");
  const late = await store.code();
  db.prepare("UPDATE res_box_code SET expires_at = ?").run(Date.now() - 1);
  await assert.rejects(store.pair({ code: late.code, name: "late" }), refused(403));
  await assert.rejects(store.pair({ code: late.code, name: "x", extra: 1 }), refused(400));
});

await step("wrong codes are counted and turned away after ten", async () => {
  const { store } = registry();
  for (let i = 0; i < 10; i += 1) await assert.rejects(store.pair({ code: "AAAA-BBBB" }), refused(403));
  const { code } = await store.code();
  await assert.rejects(store.pair({ code }), refused(429));
});

await step("a token is known until revoked; a wrong or made-up one is not", async () => {
  const { store } = registry();
  const { boxId, token } = await paired(store, "VPS");
  assert.equal((await store.authenticate(token)).name, "VPS");
  assert.equal(await store.authenticate(`${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`), null);
  assert.equal(await store.authenticate(`bt_${"0".repeat(16)}.${"0".repeat(64)}`), null);
  assert.equal(await store.authenticate("nonsense"), null);
  store.revoke(boxId);
  assert.equal(await store.authenticate(token), null);
  assert.throws(() => store.revoke(boxId), refused(404));
});

await step("plug routing: the newest connected box serves, unless the owner picked one; offline boxes never", async () => {
  const { store } = registry();
  const a = await paired(store, "A");
  const b = await paired(store, "B");
  store.hello(a.boxId, "A", ["kiro", "claude"]);
  await tick(3);
  store.hello(b.boxId, "B", ["kiro"], { claude: "No Claude setup token on this machine" });
  const both = new Set([a.boxId, b.boxId]);
  assert.equal(store.pick("kiro", both).name, "B", "the most recently connected");
  assert.equal(store.pick("claude", both).name, "A", "B is down for claude");
  store.serve("kiro", a.boxId);
  assert.equal(store.pick("kiro", both).name, "A", "the owner's choice");
  assert.equal(store.pick("kiro", new Set([b.boxId])).name, "B", "a chosen box that is offline falls back to the other");
  assert.equal(store.pick("kiro", new Set()), null);
  assert.equal(store.pick("antigravity", both), null);
  assert.throws(() => store.serve("claude", b.boxId), refused(400), "a box cannot serve a plug it does not offer");
  const list = store.list(new Set([a.boxId]));
  assert.deepEqual(list.map((box) => [box.name, box.online, box.serves]), [["A", true, ["kiro", "claude"]], ["B", false, []]]);
  assert.equal(list[1].unavailable.claude, "No Claude setup token on this machine");
  store.revoke(a.boxId);
  assert.equal(store.pick("kiro", both).name, "B", "revoking drops the choice");
});

await step("the wire: only the frames the protocol names, with exactly their fields", () => {
  const id = "a".repeat(32);
  const ok = protocol.parseBoxFrame(JSON.stringify({ t: "hello", proto: "aelios-box/1", name: "Mac\n", plugs: ["kiro", "claude", "kiro"], down: { claude: "no token" } }));
  assert.deepEqual(ok, { t: "hello", proto: "aelios-box/1", name: "Mac", plugs: ["kiro"], down: { claude: "no token" } });
  assert.deepEqual(protocol.parseBoxFrame(JSON.stringify({ t: "line", id, line: { text: "x" } })), { t: "line", id, line: { text: "x" } });
  assert.deepEqual(protocol.parseBoxFrame(JSON.stringify({ t: "end", id })), { t: "end", id });
  const bad = [
    { t: "hello", proto: "aelios-box/2", name: "x", plugs: [] },
    { t: "hello", proto: "aelios-box/1", name: "x", plugs: ["Bad Plug"] },
    { t: "hello", proto: "aelios-box/1", name: "x", plugs: [], token: "sneaky" },
    { t: "line", id, line: { text: "x" }, extra: 1 },
    { t: "line", id: "short", line: {} },
    { t: "line", id, line: [] },
    { t: "end", id, line: {} },
    { t: "turn", id, plug: "kiro", body: {} },
    { t: "nope" }
  ];
  for (const frame of bad) assert.equal(protocol.parseBoxFrame(JSON.stringify(frame)), null, JSON.stringify(frame));
  assert.equal(protocol.parseBoxFrame("not json"), null);
  assert.equal(protocol.parseBoxFrame(new ArrayBuffer(2)), null);
  assert.equal(protocol.plugOfModel("kiro/auto"), "kiro");
  assert.equal(protocol.plugOfModel("claude-code/claude-opus-5-5"), "claude");
  assert.equal(protocol.plugOfModel("anthropic/claude-opus-5-5"), null);
});

// ---- A fake WebSocket pair: the box's link on one end, the hub's side (BoxTurns + the frame parser) on the other ----

/** The hub end of a connection: what box-hub.ts does with a socket, on plain objects. */
function hubSide() {
  const turns = new BoxTurns();
  const state = { sockets: [], hellos: [], seenToken: [] };
  const net = {
    state,
    turns,
    /** The box's WebSocket class. `valid` says whether the token is known (a revoked box is closed with 4401). */
    Socket: class {
      constructor(url, options) {
        this.url = url;
        this.readyState = 0;
        state.seenToken.push(options.headers.authorization);
        this.peer = { send: (data) => this.onmessage?.({ data }), close: (code, reason) => this.#closed(code, reason) };
        state.sockets.push(this);
        queueMicrotask(() => {
          if (net.valid === false) return this.#closed(REVOKED);
          this.readyState = 1;
          this.owner = `box.${state.sockets.length}`;
          this.onopen?.();
        });
      }

      send(data) {
        const frame = protocol.parseBoxFrame(data);
        if (data === "ping") return queueMicrotask(() => this.onmessage?.({ data: "pong" }));
        if (!frame) return this.#closed(4400);
        if (frame.t === "hello") state.hellos.push(frame);
        else if (frame.t === "line") turns.line(this.owner, frame.id, frame.line, this.peer);
        else turns.end(this.owner, frame.id);
      }

      close(code = 1000, reason) {
        this.#closed(code, reason);
      }

      #closed(code, reason = "") {
        if (this.readyState === 3) return;
        this.readyState = 3;
        if (this.owner) turns.lost(this.owner, "the box disconnected");
        queueMicrotask(() => this.onclose?.({ code, reason, wasClean: code !== 1006 }));
      }
    },
    /** The resident sends a turn down the live socket. */
    turn(plug, body) {
      const live = state.sockets.findLast((socket) => socket.readyState === 1);
      return turns.start(live.owner, live.peer, plug, body);
    }
  };
  return net;
}

const read = async (response) => (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const FAST = { min: 5, max: 20 };

await step("a fake box over a socket pair: hello, a streamed turn, and the plug it was sent to", async () => {
  const net = hubSide();
  const seen = [];
  const engines = { kiro: { check: async () => null, turn: async (body, write) => (seen.push(body), write({ text: "Hello " }), write({ text: "there" }), write({ done: { credits: 0.2 } })) },
    claude: { check: async () => "No Claude setup token on this machine", turn: async () => assert.fail("a plug that is down never runs") } };
  const link = runLink({ url: "wss://r.example/box/v1/link", token: "bt_x", name: "Mac", engines, WebSocketImpl: net.Socket, backoff: FAST });
  await tick(20);
  assert.equal(net.state.seenToken[0], "Bearer bt_x");
  assert.deepEqual(net.state.hellos[0], { t: "hello", proto: "aelios-box/1", name: "Mac", plugs: ["kiro"], down: { claude: "No Claude setup token on this machine" } });
  const lines = await read(net.turn("kiro", { model: "auto", messages: [] }));
  assert.deepEqual(lines, [{ text: "Hello " }, { text: "there" }, { done: { credits: 0.2 } }]);
  assert.deepEqual(seen, [{ model: "auto", messages: [] }]);
  link.stop();
});

await step("a plug that is down answers a turn with an error line, never runs", async () => {
  const net = hubSide();
  const engines = { claude: { check: async () => "down", turn: async () => assert.fail("never") } };
  const link = runLink({ url: "wss://r/box/v1/link", token: "t", name: "M", engines, WebSocketImpl: net.Socket, backoff: FAST });
  await tick(20);
  assert.deepEqual(net.state.hellos[0].plugs, []);
  const lines = await read(net.turn("claude", { model: "x" }));
  assert.equal(lines.length, 1);
  assert.match(lines[0].error, /cannot serve claude now: down/);
  link.stop();
});

await step("the reader stopping sends cancel, and the box's turn is aborted", async () => {
  const net = hubSide();
  let aborted = false;
  const engines = { kiro: { check: async () => null, turn: (body, write, signal) => new Promise((resolve) => (write({ text: "start" }), signal.addEventListener("abort", () => ((aborted = true), resolve()), { once: true }))) } };
  const link = runLink({ url: "wss://r/box/v1/link", token: "t", name: "M", engines, WebSocketImpl: net.Socket, backoff: FAST });
  await tick(20);
  const reader = net.turn("kiro", { model: "auto" }).body.getReader();
  assert.deepEqual(JSON.parse(new TextDecoder().decode((await reader.read()).value)), { text: "start" });
  await reader.cancel();
  await tick(20);
  assert.equal(aborted, true);
  assert.equal(net.turns.open, 0);
  link.stop();
});

await step("no credential crosses the socket, whatever an engine or a turn says", async () => {
  const net = hubSide();
  const KEY = "ksk_must_not_travel_0123456789";
  const engines = { kiro: { check: async () => null, turn: async (body, write) => write({ error: `401 unauthorized for ${KEY}` }) } };
  const sentByBox = [];
  const Spy = class extends net.Socket {
    send(data) {
      sentByBox.push(data);
      super.send(data);
    }
  };
  const link = runLink({ url: "wss://r/box/v1/link", token: "bt_secret", name: "M", engines, secrets: () => [KEY], WebSocketImpl: Spy, backoff: FAST });
  await tick(20);
  const lines = await read(net.turn("kiro", { model: "auto" }));
  assert.equal(lines[0].error, "401 unauthorized for [key]");
  assert.ok(sentByBox.every((frame) => !frame.includes(KEY) && !frame.includes("bt_secret")), "neither a helper key nor the box's own token is ever sent");
  link.stop();
});

await step("the box's engines use the machine's key; a key or helper in the turn is replaced", async () => {
  const creds = { kiro: "ksk_local_0123456789abcdef" };
  const { createEngines: make } = await at("acp-box/engines.mjs");
  const engines = make(creds, { base: () => "http://127.0.0.1:1" }, { reachable: async () => true });
  // Without a model the turn is turned down before any helper starts, and the line says why.
  const lines = [];
  await engines.kiro.turn({ key: "from-the-wire", helper: "other", system: "", messages: [] }, (line) => lines.push(line), new AbortController().signal);
  assert.deepEqual(lines.map((line) => Object.keys(line)), [["error"]]);
  assert.ok(!JSON.stringify(lines).includes("from-the-wire"));
});

await step("Kiro without IPv4 egress is announced as down with a one-line reason, not tried every turn", async () => {
  const bin = process.env.KIRO_BIN;
  process.env.KIRO_BIN = process.execPath;
  try {
    const unreachable = createEngines({ kiro: "ksk_x" }, { base: () => "" }, { reachable: async () => false });
    assert.equal(await unreachable.kiro.check(), KIRO_UNREACHABLE);
    assert.ok(KIRO_UNREACHABLE.length <= 140 && !KIRO_UNREACHABLE.includes("\n"));
    assert.match(KIRO_UNREACHABLE, /IPv4/);
    const fine = createEngines({ kiro: "ksk_x" }, { base: () => "" }, { reachable: async () => true });
    assert.equal(await fine.kiro.check(), null);
    const keyless = createEngines({}, { base: () => "" }, { reachable: async () => true });
    assert.match(await keyless.kiro.check(), /No Kiro API key/);
    assert.match(await createEngines({}, { base: () => "" }).claude.check(), /No Claude setup token/);
  } finally {
    if (bin === undefined) delete process.env.KIRO_BIN;
    else process.env.KIRO_BIN = bin;
  }
});

await step("a lost box ends its turn with the reason; the box reconnects with backoff; unknown frames are ignored", async () => {
  const net = hubSide();
  const logs = [];
  const engines = { kiro: { check: async () => null, turn: (body, write, signal) => new Promise((resolve) => (write({ text: "half" }), signal.addEventListener("abort", resolve, { once: true }))) } };
  const link = runLink({ url: "wss://r/box/v1/link", token: "bt_test", name: "M", engines, WebSocketImpl: net.Socket, backoff: FAST, log: (line) => logs.push(line) });
  await tick(20);
  const reply = net.turn("kiro", { model: "auto" });
  net.state.sockets[0].peer.send(JSON.stringify({ t: "turn", id: "b".repeat(32), plug: "kiro", body: {}, extra: "refused" }));
  net.state.sockets[0].peer.send(JSON.stringify({ t: "hello" }));
  await tick(5);
  net.state.sockets[0].peer.close(1006);
  const lines = await read(reply);
  assert.deepEqual(lines, [{ text: "half" }, { error: "the box disconnected" }]);
  const closed = logRecord(logs, "disconnected; ");
  assert.deepEqual(closed, { code: 1006, reason: null, wasClean: false, localClose: null, openMs: closed.openMs,
    lastPingAgoMs: null, lastPongAgoMs: null, activeTurns: 1 });
  assert.ok(closed.openMs >= 0);
  await tick(80);
  assert.equal(net.state.hellos.length, 2, "it dialed again and said hello again");
  assert.equal(net.turns.open, 0);
  link.stop();
});

await step("a silent link records its last ping and pong and its local close request", async () => {
  const net = hubSide();
  const logs = [];
  class QuietSocket extends net.Socket {
    send(data) {
      if (data !== "ping") super.send(data);
    }
  }
  mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const link = runLink({ url: "wss://r", token: "bt_test", engines: {}, name: "M", WebSocketImpl: QuietSocket, log: (line) => logs.push(line) });
  try {
    await tick();
    mock.timers.tick(25_000);
    net.state.sockets[0].peer.send("pong");
    for (let i = 0; i < 4; i++) mock.timers.tick(25_000);
    await tick();
    const closed = logRecord(logs, "disconnected; ");
    assert.deepEqual(closed, { code: 4000, reason: "silent", wasClean: true, localClose: "silent",
      openMs: 125_000, lastPingAgoMs: 25_000, lastPongAgoMs: 100_000, activeTurns: 0 });
  } finally {
    link.stop();
    mock.timers.reset();
  }
});

await step("socket errors and peer close reasons stay on one line with credentials removed", async () => {
  const net = hubSide();
  const logs = [];
  const link = runLink({ url: "wss://r", token: "bt_test", engines: {}, name: "M", secrets: () => ["test_key"],
    WebSocketImpl: net.Socket, log: (line) => logs.push(line) });
  try {
    await tick();
    const ws = net.state.sockets[0];
    const cause = Object.assign(new Error("read test_key"), { code: "ECONNRESET" });
    ws.onerror({ error: new Error("failed bt_test\nupgrade", { cause }) });
    ws.peer.close(4000, "replaced bt_test test_key");
    await tick();
    assert.ok(logs.every((line) => !/bt_test|test_key|\n/.test(line)));
    const error = logRecord(logs, "WebSocket error; ");
    assert.deepEqual(error, { message: "failed [key]\nupgrade", code: null, cause: "read [key]", causeCode: "ECONNRESET" });
    const closed = logRecord(logs, "disconnected; ");
    assert.equal(closed.reason, "replaced [key] [key]");
    assert.equal(closed.localClose, null);
  } finally {
    link.stop();
  }
});

await step("a revoked box is closed with 4401 and stops for good, not retrying", async () => {
  const net = hubSide();
  net.valid = false;
  const link = runLink({ url: "wss://r/box/v1/link", token: "t", name: "M", engines: {}, WebSocketImpl: net.Socket, backoff: FAST });
  assert.deepEqual(await link.finished, { revoked: true });
  await tick(60);
  assert.equal(net.state.sockets.length, 1, "no second attempt");
});

await step("config: the token and the helpers' keys are files only their owner can read", async () => {
  const home = mkdtempSync(join(tmpdir(), "box-config-"));
  try {
    const sub = join(home, "cfg");
    await config.saveLink(sub, { resident: "https://r.example", token: "bt_a.b" });
    assert.equal(statSync(join(sub, "box.json")).mode & 0o777, 0o600);
    assert.equal(statSync(sub).mode & 0o777, 0o700);
    assert.deepEqual(await config.loadLink(sub), { resident: "https://r.example", token: "bt_a.b" });
    const asked = [];
    const found = await config.loadCredentials(sub, { env: { KIRO_API_KEY: "from-env" }, ask: async (plug) => (asked.push(plug), plug === "claude" ? "typed-token" : "") });
    assert.deepEqual(found, { kiro: "from-env", claude: "typed-token" });
    assert.deepEqual(asked, ["claude"], "the environment is not asked twice");
    assert.equal(statSync(join(sub, "creds.json")).mode & 0o777, 0o600);
    assert.deepEqual(await config.loadCredentials(sub, { env: {} }), { claude: "typed-token" });
    assert.ok(!readFileSync(join(sub, "creds.json"), "utf8").includes("from-env"), "an environment key is not copied to disk");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

await step("service lifecycle: a revoked box exits 2 and systemd does not restart it", async () => {
  const unit = readFileSync("acp-box/install.sh", "utf8");
  assert.match(unit, /^Restart=always$/m, "it still comes back after a crash");
  assert.match(unit, /^RestartPreventExitStatus=2$/m, "but not after a revoke");
  assert.match(readFileSync("acp-box/main.mjs", "utf8"), /if \(revoked\) process\.exit\(2\);/, "the revoke exit code the unit relies on");
});

rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
process.exit(0);
