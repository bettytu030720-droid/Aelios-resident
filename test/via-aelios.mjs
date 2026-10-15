// Unit tests for how the chat goes out through Aelios (src/via-aelios.ts). Usage: node test/via-aelios.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-via-aelios-"));
const out = join(dir, "via-aelios.mjs");
await build({ entryPoints: ["src/via-aelios.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const { aeliosBase, aeliosName, isAuxiliary, onMessages } = await import(pathToFileURL(join(process.cwd(), out)).href);
rmSync(dir, { recursive: true, force: true });

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

const note = "(Not from them: a scheduled check-in; it is now 10-15 09:00.) If you would like to reach out…";
const hers = "[10-15 09:01 周四] 早";

test("names: a Workers AI id goes under workers-ai/, the rest as written; only anthropic/ is on Messages", () => {
  assert.equal(aeliosName("@cf/zai-org/glm-4.7-flash"), "workers-ai/@cf/zai-org/glm-4.7-flash");
  assert.equal(aeliosName("anthropic/claude-opus-5.5"), "anthropic/claude-opus-5.5");
  assert.equal(aeliosName("custom-nous/hermes"), "custom-nous/hermes");
  assert.equal(onMessages("anthropic/claude-opus-5.5"), true);
  assert.equal(onMessages("Anthropic/claude-opus-5.5"), true);
  assert.equal(onMessages("openai/gpt-5"), false);
  assert.equal(onMessages("@cf/anthropic-ish/model"), false);
});

test("the address: /v1 for the key's first identity, /<identity>/v1 for a named one", () => {
  assert.equal(aeliosBase({ url: "https://a.example", key: "k", namespace: "default", identity: "" }), "https://a.example/v1");
  assert.equal(aeliosBase({ url: "https://a.example", key: "k", namespace: "default", identity: "resident" }), "https://a.example/resident/v1");
});

test("her message is hers, on Messages and on chat completions", () => {
  assert.equal(isAuxiliary({ messages: [{ role: "user", content: [{ type: "text", text: hers }] }] }), false);
  assert.equal(isAuxiliary({ messages: [{ role: "system", content: "persona" }, { role: "user", content: hers }] }), false);
});

test("a check-in or letter turn is auxiliary, also after a tool call within it", () => {
  assert.equal(isAuxiliary({ messages: [{ role: "user", content: [{ type: "text", text: hers }] }, { role: "assistant", content: "嗯" }, { role: "user", content: note }] }), true);
  const toolLoop = [
    { role: "user", content: [{ type: "text", text: note }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "web_search", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "…" }] }
  ];
  assert.equal(isAuxiliary({ messages: toolLoop }), true);
  // The same tool loop in her turn stays hers.
  assert.equal(isAuxiliary({ messages: [{ ...toolLoop[0], content: [{ type: "text", text: hers }] }, ...toolLoop.slice(1)] }), false);
  // Chat completions put tool results under their own role.
  assert.equal(isAuxiliary({ messages: [{ role: "user", content: note }, { role: "assistant", tool_calls: [] }, { role: "tool", content: "…" }] }), true);
});

test("the older Chinese note is recognised too", () => {
  assert.equal(isAuxiliary({ messages: [{ role: "user", content: "（这条不是她发的，是定时提醒）" }] }), true);
});
