// Unit tests for what the resident fixes in a Claude request on Cloudflare's run path (src/claude-run.ts):
// `system` as one string, and no thinking blocks from earlier turns. Usage: node test/claude-run.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-claude-run-"));
const out = join(dir, "claude-run.mjs");
await build({ entryPoints: ["src/claude-run.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const { claudeOnRunPath } = await import(pathToFileURL(join(process.cwd(), out)).href);
rmSync(dir, { recursive: true, force: true });

const CLAUDE = "anthropic/claude-opus-5.5";
const thinking = (text) => ({ type: "thinking", thinking: text, signature: `sig-${text}` });
const text = (value) => ({ type: "text", text: value });

/** What the binding was asked to run, after the fix-ups. */
function sent(model, inputs, options) {
  const calls = [];
  const ai = claudeOnRunPath({ run: (...args) => (calls.push(args), "answer"), other: () => "other" });
  assert.equal(ai.run(model, inputs, options), "answer");
  assert.equal(ai.other(), "other", "the rest of the binding is untouched");
  return calls[0];
}

let failures = 0;
function step(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n${error.stack ?? error}`);
  }
}

step("the system prompt goes as one string", () => {
  const [, inputs] = sent(CLAUDE, { system: [text("persona"), text("rules")], messages: [{ role: "user", content: [text("hi")] }] });
  assert.equal(inputs.system, "persona\n\nrules");
});

step("thinking from earlier turns is left out, the replies and tool calls stay", () => {
  const options = { gateway: { id: "g" } };
  const [model, inputs, passed] = sent(
    CLAUDE,
    {
      system: "s",
      messages: [
        { role: "user", content: [text("first")] },
        { role: "assistant", content: [thinking("a"), text("reply one"), { type: "tool_use", id: "t1", name: "web_search", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "found" }] },
        { role: "assistant", content: [thinking("b"), { type: "redacted_thinking", data: "x" }, text("reply two")] },
        { role: "assistant", content: [thinking("only thinking")] },
        { role: "user", content: [text("second")] },
        { role: "assistant", content: [thinking("c"), { type: "tool_use", id: "t2", name: "web_fetch", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "page" }] }
      ]
    },
    options
  );
  assert.equal(model, CLAUDE);
  assert.equal(passed, options, "call options are passed through");
  assert.deepEqual(
    inputs.messages.map((m) => m.content.map((b) => b.type)),
    [["text"], ["text", "tool_use"], ["tool_result"], ["text"], ["text"], ["thinking", "tool_use"], ["tool_result"]],
    "the turn in progress keeps its thinking; a reply that was only thinking is gone"
  );
  assert.equal(inputs.messages[5].content[0].signature, "sig-c");
});

step("a first turn, or one with no earlier thinking, is sent as it is", () => {
  const first = { messages: [{ role: "user", content: [text("hi")] }] };
  assert.equal(sent(CLAUDE, first)[1], first);
  const plain = {
    messages: [
      { role: "user", content: [text("hi")] },
      { role: "assistant", content: [text("hello")] },
      { role: "user", content: [text("again")] }
    ]
  };
  assert.equal(sent(CLAUDE, plain)[1], plain);
});

step("other models are not touched", () => {
  const inputs = {
    system: [text("s")],
    messages: [
      { role: "user", content: [text("hi")] },
      { role: "assistant", content: [thinking("a"), text("hello")] },
      { role: "user", content: [text("again")] }
    ]
  };
  assert.equal(sent("@cf/zai-org/glm-4.7-flash", inputs)[1], inputs);
  assert.equal(sent("openai/gpt-5-mini", inputs)[1], inputs);
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
