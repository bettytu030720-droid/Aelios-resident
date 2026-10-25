// Unit tests for how the chat goes out through Aelios (src/via-aelios.ts). Usage: node test/via-aelios.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-via-aelios-"));
const out = join(dir, "via-aelios.mjs");
await build({ entryPoints: ["src/via-aelios.ts", "src/thinking.ts"], bundle: true, platform: "node", format: "esm", outdir: dir, outExtension: { ".js": ".mjs" }, logLevel: "error" });
const { aeliosBase, aeliosName, isAuxiliary, listModels, modelsOf, onMessages } = await import(pathToFileURL(join(process.cwd(), out)).href);
const { claudeOf, effortOf, withThinking } = await import(pathToFileURL(join(process.cwd(), dir, "thinking.mjs")).href);
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

test("names: a Workers AI id goes under workers-ai/, Anthropic's own with dashes, the rest as written", () => {
  assert.equal(aeliosName("@cf/zai-org/glm-4.7-flash"), "workers-ai/@cf/zai-org/glm-4.7-flash");
  assert.equal(aeliosName("anthropic/claude-opus-5.5"), "anthropic/claude-opus-5-5");
  assert.equal(aeliosName("anthropic/claude-opus-5-5"), "anthropic/claude-opus-5-5");
  assert.equal(aeliosName("anthropic/claude-haiku-4.5-20251001"), "anthropic/claude-haiku-4-5-20251001");
  // Another provider's own spelling is left alone (OpenRouter writes claude-sonnet-4.5).
  assert.equal(aeliosName("custom-relay/anthropic/claude-sonnet-4.5"), "custom-relay/anthropic/claude-sonnet-4.5");
  assert.equal(aeliosName("custom-nous/hermes"), "custom-nous/hermes");
});

test("Messages for anthropic/ and anything with claude in it; chat completions for the rest", () => {
  assert.equal(onMessages("anthropic/claude-opus-5.5"), true);
  assert.equal(onMessages("Anthropic/claude-opus-5.5"), true);
  assert.equal(onMessages("custom-nous/claude-sonnet-5.5"), true);
  assert.equal(onMessages("custom-relay/anthropic/Claude-Opus-5.5"), true);
  assert.equal(onMessages("openai/gpt-5"), false);
  assert.equal(onMessages("custom-nous/hermes"), false);
  assert.equal(onMessages("@cf/zai-org/glm-4.7-flash"), false);
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

test("thinking: read from the model name; older names and other models are not Claude versions", () => {
  assert.deepEqual(claudeOf("anthropic/claude-opus-5-5"), { family: "opus", version: 5.5 });
  assert.deepEqual(claudeOf("custom-relay/anthropic/claude-sonnet-4.5"), { family: "sonnet", version: 4.5 });
  assert.deepEqual(claudeOf("claude-haiku-4-5-20251001"), { family: "haiku", version: 4.5 });
  assert.deepEqual(claudeOf("claude-opus-5-20260101"), { family: "opus", version: 5 });
  assert.equal(claudeOf("claude-3-7-sonnet-20250219"), null);
  assert.equal(claudeOf("anthropic/claude-test"), null);
  assert.equal(effortOf(" High "), "high");
  assert.equal(effortOf("auto"), null);
  assert.equal(effortOf(undefined), null);
});

test("thinking: shown on the models that hide it, effort only where it is taken", () => {
  const shown = { type: "adaptive", display: "summarized" };
  assert.deepEqual(withThinking({ model: "anthropic/claude-opus-5-5" }, null), { model: "anthropic/claude-opus-5-5", thinking: shown });
  assert.deepEqual(withThinking({ model: "claude-haiku-5-5" }, "low"), { model: "claude-haiku-5-5", thinking: shown, output_config: { effort: "low" } });
  // Thinks only when asked: no thinking switched on, but effort is taken.
  assert.deepEqual(withThinking({ model: "claude-opus-4-6" }, "max"), { model: "claude-opus-4-6", output_config: { effort: "max" } });
  // Takes neither.
  assert.deepEqual(withThinking({ model: "claude-sonnet-4-5" }, "high"), { model: "claude-sonnet-4-5" });
  assert.deepEqual(withThinking({ model: "openai/gpt-5" }, "high"), { model: "openai/gpt-5" });
  // What the request already says is kept.
  assert.deepEqual(withThinking({ model: "claude-fable-5-1", thinking: { type: "adaptive", display: "omitted" } }, null).thinking, { type: "adaptive", display: "omitted" });
  assert.deepEqual(withThinking({ model: "claude-opus-5-5", output_config: { format: { type: "json_schema" } } }, "high").output_config, { format: { type: "json_schema" }, effort: "high" });
});

test("Aelios' model list: an id once, who it is from, and whether it gets memory only when Aelios says", () => {
  const body = { object: "list", data: [
    { id: "openai/gpt-5", object: "model", owned_by: "openai", aelios: { main: true } },
    { id: "custom-mine/tiny", owned_by: "custom-mine", aelios: { main: false } },
    { id: "chatgpt/gpt-5", aelios: {} },
    { id: "openai/gpt-5", owned_by: "openai" },
    { id: "has space" }, { id: "" }, { id: 7 }, { nope: true }, null, "text",
    { id: "x".repeat(201) },
    { id: "anthropic/claude-opus-5-5", owned_by: 7, aelios: { main: "yes" } }
  ] };
  assert.deepEqual(modelsOf(body), [
    { id: "openai/gpt-5", owner: "openai", main: true },
    { id: "custom-mine/tiny", owner: "custom-mine", main: false },
    { id: "chatgpt/gpt-5", owner: "" },
    { id: "anthropic/claude-opus-5-5", owner: "" }
  ]);
  for (const nothing of [null, undefined, "x", [], {}, { data: "x" }]) assert.deepEqual(modelsOf(nothing), []);
  assert.equal(modelsOf({ data: Array.from({ length: 6000 }, (_, i) => ({ id: `m/${i}` })) }).length, 5000);
});

test("listModels asks Aelios' model endpoint under the identity with the key, and says whether the owner saved a list", async () => {
  const real = globalThis.fetch;
  const asked = [];
  let answer = () => new Response(JSON.stringify({ data: [{ id: "chatgpt/gpt-5", owned_by: "chatgpt", aelios: { main: true } }] }), { headers: { "x-aelios-models": "list" } });
  globalThis.fetch = async (url, init) => { asked.push({ url: String(url), auth: new Headers(init.headers).get("authorization") }); return answer(); };
  try {
    const named = { url: "https://a.example", key: "k1", namespace: "default", identity: "res" };
    assert.deepEqual(await listModels(named), { models: [{ id: "chatgpt/gpt-5", owner: "chatgpt", main: true }], curated: true });
    assert.deepEqual(asked, [{ url: "https://a.example/res/v1/models", auth: "Bearer k1" }]);
    asked.length = 0;
    answer = () => new Response(JSON.stringify({ data: [{ id: "openai/gpt-5" }] }), { headers: { "x-aelios-models": "upstream" } });
    assert.deepEqual(await listModels({ ...named, identity: "" }), { models: [{ id: "openai/gpt-5", owner: "" }], curated: false });
    assert.equal(asked[0].url, "https://a.example/v1/models");
    answer = () => new Response(JSON.stringify({ data: [] }));
    assert.equal((await listModels(named)).curated, false, "no header, not curated");
    answer = () => new Response("nope", { status: 401 });
    await assert.rejects(listModels(named), /Aelios answered 401/);
    answer = () => new Response("<html>", { status: 200 });
    await assert.rejects(listModels(named));
  } finally { globalThis.fetch = real; }
});
