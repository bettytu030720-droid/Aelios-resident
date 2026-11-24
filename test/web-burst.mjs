// Messages from the web page answered as one turn (src/web-burst.ts). Run: node test/web-burst.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join(realpathSync("node_modules/.cache"), "burst-"));
let WebBurst;
try {
  await build({ entryPoints: ["src/web-burst.ts"], bundle: true, platform: "node", format: "esm", outdir: dir, outExtension: { ".js": ".mjs" }, logLevel: "error" });
  ({ WebBurst } = await import(pathToFileURL(join(dir, "web-burst.mjs")).href));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const WAIT = 60;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (text) => ({ id: text, role: "user", parts: [{ type: "text", text }] });

/** One turn at a time, like Think's queue: a turn takes its messages when it starts. `hold` keeps a turn running. */
function host({ turnMs = 0, skip = () => false } = {}) {
  const turns = [];
  let queue = Promise.resolve();
  const run = (take) => {
    const turn = queue.then(async () => {
      if (skip()) return { status: "skipped" };
      const messages = take();
      turns.push(messages.map((message) => message.id));
      await sleep(turnMs);
      return { status: "completed" };
    });
    queue = turn.catch(() => {});
    return turn;
  };
  return { turns, burst: new WebBurst(run, () => WAIT) };
}

await test("messages within the quiet time are one turn, and each sender gets that turn's answer", async () => {
  const { turns, burst } = host();
  const said = [burst.add(say("a"))];
  await sleep(WAIT / 2);
  said.push(burst.add(say("b")));
  await sleep(WAIT / 2);
  said.push(burst.add(say("c"))); // more than WAIT after the first, less than WAIT after the one before
  const results = await Promise.all(said);
  assert.deepEqual(turns, [["a", "b", "c"]]);
  assert.deepEqual(results.map((result) => result.status), ["completed", "completed", "completed"]);
});

await test("a pause longer than the quiet time starts another turn", async () => {
  const { turns, burst } = host();
  const first = burst.add(say("a"));
  await sleep(WAIT * 2);
  await Promise.all([first, burst.add(say("b"))]);
  assert.deepEqual(turns, [["a"], ["b"]]);
});

await test("what she sends while a reply is written is answered together in the next turn", async () => {
  const { turns, burst } = host({ turnMs: WAIT * 4 });
  const first = burst.add(say("a"));
  await sleep(WAIT * 2); // "a" is being answered
  const second = burst.add(say("b"));
  await sleep(WAIT * 1.5); // past the quiet time: "b" is sent and waits for its turn
  const third = burst.add(say("c"));
  await Promise.all([first, second, third]);
  assert.deepEqual(turns, [["a"], ["b", "c"]]);
  const after = burst.add(say("d"));
  await after;
  assert.deepEqual(turns.at(-1), ["d"], "a message after that turn started is a burst of its own");
});

await test("a turn that never started takes nothing, and the next message starts afresh", async () => {
  let skipping = true;
  const { turns, burst } = host({ skip: () => skipping });
  assert.equal((await burst.add(say("a"))).status, "skipped");
  skipping = false;
  assert.equal((await burst.add(say("b"))).status, "completed");
  assert.deepEqual(turns, [["b"]]);
});

await test("a failed turn fails every message of its burst", async () => {
  const burst = new WebBurst(async (take) => { take(); throw new Error("model down"); }, () => WAIT);
  const said = [burst.add(say("a")), burst.add(say("b"))];
  for (const result of await Promise.allSettled(said)) assert.equal(result.reason?.message, "model down");
});

await test("a message said on a call starts its turn without the quiet time", async () => {
  const { turns, burst } = host();
  const started = Date.now();
  await burst.add(say("a"), 0);
  assert.ok(Date.now() - started < WAIT, "no quiet time");
  assert.deepEqual(turns, [["a"]]);
});
