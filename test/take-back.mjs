// Which messages go when its latest reply is taken back (src/take-back.ts), without a Worker. Usage: node test/take-back.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-take-back-"));
const out = join(dir, "take-back.mjs");
await build({ entryPoints: ["src/take-back.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const { takeBack } = await import(pathToFileURL(join(process.cwd(), out)).href);
rmSync(dir, { recursive: true, force: true });

let failures = 0;
function step(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${error?.stack ?? error}`);
  }
}

const her = (id, text = "[10-30 09:00 周五] 在吗") => ({ id, role: "user", parts: [{ type: "text", text }] });
const its = (id, text = "在呢", more = []) => ({ id, role: "assistant", parts: [{ type: "step-start" }, ...more, { type: "text", text }] });
const heartbeat = (id) => her(id, "(Not from them: a heartbeat; it is now 10-30 10:00.) …");
const task = (id) => her(id, "(Not from them: your cloud task t_0123456789 reported back.) …");
const letter = (id) => ({ id: `compaction_${id}`, role: "assistant", parts: [{ type: "text", text: "交接信" }] });

step("the latest reply goes, and her message can be answered again", () => {
  const path = [her("u1"), its("a1"), her("u2"), its("a2", "我不能完成这个任务。")];
  assert.deepEqual(takeBack(path, "a2"), { ids: ["a2"], again: true });
});

step("a reply in more than one message goes whole, whichever of them is picked", () => {
  const path = [her("u1"), its("a1", "", [{ type: "tool-web_search", toolCallId: "t" }]), its("a2", "搜到了")];
  assert.deepEqual(takeBack(path, "a2"), { ids: ["a1", "a2"], again: true });
  assert.deepEqual(takeBack(path, "a1"), { ids: ["a1", "a2"], again: true });
});

step("check-ins it passed on since go with it; one it said something on makes it no longer the latest", () => {
  const passed = [her("u1"), its("a1", "�����"), heartbeat("h1"), its("s1", "SKIP"), heartbeat("h2"), its("s2", "")];
  assert.deepEqual(takeBack(passed, "a1"), { ids: ["a1", "h1", "s1", "h2", "s2"], again: true });
  const spoke = [her("u1"), its("a1"), heartbeat("h1"), its("s1", "睡了吗")];
  assert.deepEqual(takeBack(spoke, "a1"), { error: "只能收回最后一条" });
  assert.deepEqual(takeBack(spoke, "s1"), { ids: ["s1"], again: false }, "a check-in answers no message of hers");
});

step("only the latest: not an earlier reply, not one with her message after it", () => {
  const path = [her("u1"), its("a1"), her("u2"), its("a2")];
  assert.deepEqual(takeBack(path, "a1"), { error: "只能收回最后一条" });
  assert.deepEqual(takeBack([...path, her("u3")], "a2"), { error: "只能收回最后一条" });
});

step("her message, a letter or a message not on the path cannot be taken back", () => {
  const path = [letter("1"), her("u1"), its("a1")];
  assert.deepEqual(takeBack(path, "u1"), { error: "这条已经不在了" });
  assert.deepEqual(takeBack(path, "compaction_1"), { error: "这条已经不在了" });
  assert.deepEqual(takeBack(path, "gone"), { error: "这条已经不在了" });
});

step("a reply to a thread's report, or right after a letter, can only be deleted", () => {
  assert.deepEqual(takeBack([her("u1"), its("a1"), task("n1"), its("a2", "线程做完了")], "a2"), { ids: ["a2"], again: false });
  assert.deepEqual(takeBack([letter("1"), its("a1")], "a1"), { ids: ["a1"], again: false });
});

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
