// Words after tools that add nothing (src/after-tools.ts), without a Worker. Usage: node test/after-tools.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-after-tools-"));
const out = join(dir, "after-tools.mjs");
await build({ entryPoints: ["src/after-tools.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const { addsNothing, quietAfterTools } = await import(pathToFileURL(join(process.cwd(), out)).href);
rmSync(dir, { recursive: true, force: true });

let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${error?.stack ?? error}`);
  }
}

// A step of a turn as stream parts: its thinking, its words (one block each) and its tool calls.
let ids = 0;
function stepOf({ thinking, words = [], tools = [] }) {
  const parts = [{ type: "start-step", request: {}, warnings: [] }];
  if (thinking) {
    const id = `r${ids++}`;
    parts.push({ type: "reasoning-start", id }, { type: "reasoning-delta", id, text: thinking }, { type: "reasoning-end", id });
  }
  for (const text of words) {
    const id = `t${ids++}`;
    parts.push({ type: "text-start", id });
    for (const piece of text.match(/[\s\S]{1,3}/g) ?? []) parts.push({ type: "text-delta", id, text: piece });
    parts.push({ type: "text-end", id });
  }
  for (const name of tools) {
    const id = `c${ids++}`;
    parts.push({ type: "tool-call", toolCallId: id, toolName: name, input: {} });
    parts.push({ type: "tool-result", toolCallId: id, toolName: name, input: {}, output: { ok: true } });
  }
  parts.push({ type: "finish-step", finishReason: tools.length ? "tool-calls" : "stop", usage: {}, response: {} });
  return parts;
}

/** The turn's parts through the transform; what each step then says and thinks. */
async function through(...steps) {
  const parts = steps.flat();
  const stream = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    }
  }).pipeThrough(quietAfterTools()({ tools: {}, stopStream() {} }));
  const got = [];
  for await (const part of stream) got.push(part);
  const said = [];
  const thought = [];
  for (const part of got) {
    if (part.type === "start-step") {
      said.push("");
      thought.push("");
    }
    if (part.type === "text-delta") said[said.length - 1] += part.text;
    if (part.type === "reasoning-delta") thought[thought.length - 1] += part.text;
  }
  return { said, thought, got };
}

const hug = "过来，抱抱你。今天辛苦了，我一直在。";

await step("words, then a sticker, then the same words again: the second time is left out", async () => {
  const { said } = await through(stepOf({ words: [hug], tools: ["send_sticker"] }), stepOf({ words: [hug] }));
  assert.deepEqual(said, [hug, ""]);
});

await step("the same words rewritten a little are left out too", async () => {
  const { said } = await through(stepOf({ words: [hug], tools: ["remember"] }), stepOf({ words: ["过来抱抱你，今天辛苦了，我一直都在。"] }));
  assert.deepEqual(said, [hug, ""]);
});

await step("'No response requested.' and its kind after tools are left out", async () => {
  for (const line of ["No response requested.", "(no response needed)", "*No response requested*", "无需回复。", "  "]) {
    const { said } = await through(stepOf({ words: ["我记下了。"], tools: ["remember"] }), stepOf({ words: [line] }));
    assert.deepEqual(said, ["我记下了。", ""], line);
  }
});

await step("something new after the tools goes out as it is", async () => {
  const { said } = await through(stepOf({ words: ["我查一下明天武汉的天气。"], tools: ["web_search"] }), stepOf({ words: ["明天武汉的天气是晴，22 度。"] }));
  assert.deepEqual(said, ["我查一下明天武汉的天气。", "明天武汉的天气是晴，22 度。"]);
  const after = await through(stepOf({ words: ["我记一下。"], tools: ["memory_notebook"] }), stepOf({ words: ["小本本记好了：今天学完第30章。"] }));
  assert.deepEqual(after.said, ["我记一下。", "小本本记好了：今天学完第30章。"]);
});

await step("a turn that said nothing before its tools is not judged, whatever it says after", async () => {
  const { said } = await through(stepOf({ tools: ["send_sticker"] }), stepOf({ words: ["No response requested."] }));
  assert.deepEqual(said, ["", "No response requested."]);
});

await step("words that are not after tools are never judged", async () => {
  const { said } = await through(stepOf({ words: [hug, hug] }));
  assert.deepEqual(said, [hug + hug]);
});

await step("a step whose words are all left out loses its thinking; one that says something new keeps it, first", async () => {
  const quiet = await through(stepOf({ words: [hug], tools: ["send_sticker"] }), stepOf({ thinking: "没什么要补的。", words: ["No response requested."] }));
  assert.deepEqual(quiet.said, [hug, ""]);
  assert.deepEqual(quiet.thought, ["", ""]);
  const more = await through(stepOf({ words: [hug], tools: ["send_sticker"] }), stepOf({ thinking: "再补一句。", words: ["对了，明天记得带伞。"] }));
  assert.deepEqual(more.thought, ["", "再补一句。"]);
  const second = more.got.findIndex((part, i) => i > 0 && part.type === "start-step");
  const kinds = more.got.slice(second).map((part) => part.type);
  assert.ok(kinds.indexOf("reasoning-start") < kinds.indexOf("text-start"), kinds.join(" "));
});

await step("thinking before another tool call stays with it, in order", async () => {
  const { got, thought } = await through(stepOf({ words: [hug], tools: ["remember"] }), stepOf({ thinking: "再发个表情。", tools: ["send_sticker"] }), stepOf({ words: [hug] }));
  assert.deepEqual(thought, ["", "再发个表情。", ""]);
  const second = got.findIndex((part, i) => i > 0 && part.type === "start-step");
  const kinds = got.slice(second).map((part) => part.type);
  assert.ok(kinds.indexOf("reasoning-end") < kinds.indexOf("tool-call"), kinds.join(" "));
});

await step("every step keeps its start and finish, and the calls and results stay", async () => {
  const { got } = await through(stepOf({ words: [hug], tools: ["send_sticker"] }), stepOf({ words: [hug] }));
  assert.deepEqual(
    got.map((part) => part.type).filter((type) => !type.startsWith("text-")),
    ["start-step", "tool-call", "tool-result", "finish-step", "start-step", "finish-step"]
  );
});

await step("addsNothing: what counts as nothing new", () => {
  assert.equal(addsNothing(hug, hug), true);
  assert.equal(addsNothing(hug, "No response requested."), true);
  assert.equal(addsNothing("", "No response requested."), true);
  assert.equal(addsNothing(hug, "抱抱你"), true, "a piece of what was said");
  assert.equal(addsNothing(hug, "😊"), false, "a reaction is something");
  assert.equal(addsNothing("我查一下明天武汉的天气。", "明天武汉的天气是晴，22 度。"), false);
  assert.equal(addsNothing("I'll note that down.", "Noted: the exam is on the 7th."), false);
});

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
