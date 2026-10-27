// Unit tests for the usage timeline (src/usage.ts) and the price list it uses (src/prices.ts).
// Usage: node test/usage.mjs
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-usage-"));
const out = join(dir, "usage.mjs");
await build({
  stdin: { contents: 'export * from "./src/usage.ts"; export * from "./src/prices.ts"; export { noteKind, checkinPrompt, heartbeatPrompt, letterPrompt, ALARM_PREFIX } from "./src/prompts.ts";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: out,
  logLevel: "error"
});
const u = await import(pathToFileURL(join(process.cwd(), out)).href);
rmSync(dir, { recursive: true, force: true });

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} is not ${expected}`);

// ---- model names ----
for (const [name, key] of [
  ["anthropic/claude-opus-5.5", "opus-5-5"],
  ["anthropic/claude-opus-5-5", "opus-5-5"],
  ["claude-opus-5-5", "opus-5-5"],
  ["custom-nous/anthropic/claude-opus-5.5", "opus-5-5"],
  ["vertex/claude-opus-5-5", "opus-5-5"],
  ["claude-opus-5-5@20260101", "opus-5-5"],
  ["claude-opus-5-5[1m]", "opus-5-5"],
  ["claude-opus-5", "opus-5"],
  ["claude-opus-4-5-20251101", "opus-4-5"],
  ["claude-sonnet-4-20250514", "sonnet-4"],
  ["us.anthropic.claude-sonnet-4-6", "sonnet-4-6"],
  ["claude-fable-5-1", "fable-5-1"],
  ["Claude-Haiku-5.5", "haiku-5-5"],
  ["claude-3-5-haiku-20241022", "haiku-3-5"],
  ["@cf/zai-org/glm-4.7-flash", null],
  ["openai/gpt-5.6-sol", null],
  ["", null]
]) {
  assert.equal(u.priceKey(name), key, name);
}
console.log("PASS a model is priced by its name whatever wraps it, and a dated or prefixed name is the same model");

// ---- prices ----
const opus = u.priceFor("anthropic/claude-opus-5.5");
assert.deepEqual(opus, { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 });
assert.equal(u.priceFor("claude-fable-5-1").read, 0.25);
assert.equal(u.priceFor("claude-sonnet-5-5").read, 0.1);
assert.equal(u.priceFor("claude-sonnet-5").read, 0.2);
assert.equal(u.priceFor("claude-opus-4-8").read, 0.5);
assert.equal(u.priceFor("@cf/zai-org/glm-4.7-flash"), null);
// Haiku 5.5 is dearer over 100,000 prompt tokens, cache reads included.
assert.equal(u.priceFor("claude-haiku-5-5", 100_000).input, 0.1);
assert.equal(u.priceFor("claude-haiku-5-5", 100_001).input, 0.5);
assert.equal(u.priceFor("claude-opus-5-5", 900_000).input, 4);
// 1M input = $4, 1M cache read = $0.20, 1M 5-minute write = $5, 1M 1-hour write = $8, 1M output = $20.
near(u.costOf("claude-opus-5-5", { input: 1_000_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 }), 4);
near(u.costOf("claude-opus-5-5", { input: 0, cacheRead: 1_000_000, cacheWrite: 0, cacheWrite1h: 0, output: 0 }), 0.2);
near(u.costOf("claude-opus-5-5", { input: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: 0, output: 0 }), 5);
near(u.costOf("claude-opus-5-5", { input: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000, output: 0 }), 8);
near(u.costOf("claude-opus-5-5", { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 1_000_000 }), 20);
// A turn as the resident makes it: 12 new, 30,000 read, 400 written for an hour, 250 out.
near(u.costOf("anthropic/claude-opus-5-5", { input: 12, cacheRead: 30_000, cacheWrite: 400, cacheWrite1h: 400, output: 250 }), (12 * 4 + 30_000 * 0.2 + 400 * 8 + 250 * 20) / 1e6);
// A long Haiku 5.5 prompt is priced at the higher rate in full, even the part read from the cache.
near(u.costOf("claude-haiku-5-5", { input: 1_000, cacheRead: 150_000, cacheWrite: 0, cacheWrite1h: 0, output: 1_000 }), (1_000 * 0.5 + 150_000 * 0.05 + 1_000 * 2.5) / 1e6);
assert.equal(u.costOf("@cf/zai-org/glm-4.7-flash", { input: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 1 }), null);
console.log("PASS each call is priced at Anthropic's list price, with each model's own cache-read rate, 5-minute and 1-hour writes, and Haiku 5.5's long-prompt rate");

// ---- turn labels ----
const now = "2026-10-27 12:00";
assert.equal(u.noteKind("[10-27 12:00] 在吗"), null);
assert.equal(u.noteKind(u.checkinPrompt(now)), "checkin");
assert.equal(u.noteKind(u.heartbeatPrompt(now, 30, 1, 3)), "heartbeat");
assert.equal(u.noteKind(`${u.ALARM_PREFIX}: 喝水)`), "alarm");
assert.equal(u.noteKind(u.letterPrompt(now, true)), "letter");
assert.equal(u.noteKind("(Not from them: something else.)"), "note");
assert.deepEqual(u.usageLabel({ asked: "[10-27] hi", letter: false, task: false, proactive: false }), { kind: "chat", via: "web" });
assert.deepEqual(u.usageLabel({ asked: "[10-27] hi", letter: false, task: false, messenger: "telegram", proactive: false }), { kind: "chat", via: "telegram" });
assert.deepEqual(u.usageLabel({ asked: "[10-27] hi", letter: false, task: false, messenger: "wecom", proactive: false }), { kind: "chat", via: "wecom" });
assert.deepEqual(u.usageLabel({ asked: u.checkinPrompt(now), letter: false, task: false, proactive: true }), { kind: "checkin", via: "" });
assert.deepEqual(u.usageLabel({ asked: u.heartbeatPrompt(now, 30, 1, 3), letter: false, task: false, proactive: true }), { kind: "heartbeat", via: "" });
assert.deepEqual(u.usageLabel({ asked: u.letterPrompt(now, false), letter: true, task: false, proactive: false }), { kind: "letter", via: "" });
assert.deepEqual(u.usageLabel({ asked: "(Not from them: a task t_0123456789 reported.)", letter: false, task: true, proactive: true }), { kind: "task", via: "" });
console.log("PASS each turn is labelled by what it answers (theirs, a check-in, a heartbeat, an alarm, the letter, a task) and the door it came in by");

// ---- rows from steps ----
const label = { kind: "chat", via: "telegram" };
const anthropicStep = {
  stepNumber: 1,
  model: { provider: "anthropic.messages", modelId: "anthropic/claude-opus-5-5" },
  usage: {
    inputTokens: 30_412,
    inputTokenDetails: { noCacheTokens: 12, cacheReadTokens: 30_000, cacheWriteTokens: 400 },
    outputTokens: 250,
    outputTokenDetails: { textTokens: 170, reasoningTokens: 80 },
    raw: { input_tokens: 12, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 400, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 300 } }
  },
  toolCalls: [{ toolName: "memory_recall" }, { toolName: "web_search" }, { toolName: "memory_recall" }],
  text: "this is never kept"
};
const entry = u.entryOf(anthropicStep, label, 1000, "1h");
assert.deepEqual(entry, {
  kind: "chat",
  via: "telegram",
  at: 1000,
  model: "anthropic/claude-opus-5-5",
  step: 1,
  input: 12,
  cacheRead: 30_000,
  cacheWrite: 400,
  cacheWrite1h: 300,
  output: 250,
  reasoning: 80,
  tools: ["memory_recall", "web_search"]
});
assert.ok(!JSON.stringify(entry).includes("never kept"));
// A provider that does not split the write: it is taken to be the TTL the resident asked for.
const unsplit = { ...anthropicStep, usage: { ...anthropicStep.usage, raw: undefined } };
assert.equal(u.entryOf(unsplit, label, 1, "1h").cacheWrite1h, 400);
assert.equal(u.entryOf(unsplit, label, 1, "5m").cacheWrite1h, 0);
// An OpenAI-style answer: cached reads only, no breakdown of the rest.
const openai = { model: { modelId: "openai/gpt-5.6-sol" }, usage: { inputTokens: 1_000, inputTokenDetails: { cacheReadTokens: 600 }, outputTokens: 20, outputTokenDetails: {} } };
assert.deepEqual(
  { input: u.entryOf(openai, label, 1, "1h").input, read: u.entryOf(openai, label, 1, "1h").cacheRead, write: u.entryOf(openai, label, 1, "1h").cacheWrite },
  { input: 400, read: 600, write: 0 }
);
// Nothing reported, nothing recorded.
assert.equal(u.entryOf({ usage: { inputTokens: undefined, inputTokenDetails: {}, outputTokens: undefined, outputTokenDetails: {} } }, label, 1, "1h"), null);
assert.equal(u.entryOf({}, label, 1, "1h"), null);
console.log("PASS a row keeps a step's tokens, its 1-hour share of the cache write, its thinking and tool names, and no words");

// ---- the store ----
const db = new DatabaseSync(":memory:");
const sql = (strings, ...values) => {
  const statement = db.prepare(strings.join("?"));
  if (statement.columns().length) return statement.all(...values);
  statement.run(...values);
  return [];
};
const store = new u.UsageStore(sql);
new u.UsageStore(sql); // a second start finds the table already there
const DAY = 86_400_000;
const t0 = Date.parse("2026-10-27T04:00:00Z");
const row = (at, extra = {}) => ({ ...entry, at, ...extra });
store.add(row(t0 - 100 * DAY)); // older than 90 days: gone at the next prune
store.add(row(t0 - 10 * DAY));
store.add(row(t0 - 3 * DAY, { model: "@cf/zai-org/glm-4.7-flash", cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, input: 2_000, tools: [] }));
store.add(row(t0 - 60_000));
store.add(row(t0, { model: "claude-haiku-5-5", input: 1_000, cacheRead: 150_000, cacheWrite: 0, cacheWrite1h: 0, output: 1_000 }));
assert.equal(sql`SELECT COUNT(*) AS n FROM res_usage`[0].n, 4);
const local = { hour: 12, minute: 0 }; // 04:00Z is noon in Shanghai
const spans = u.usageSpans(t0, local);
assert.equal(spans.today, Date.parse("2026-10-26T16:00:00Z"));
assert.equal(spans.week, spans.today - 6 * DAY);
assert.equal(spans.month, spans.today - 29 * DAY);
const today = store.totals(spans.today);
assert.equal(today.calls, 2);
assert.equal(today.unpriced, 0);
near(today.cost, u.costOf("anthropic/claude-opus-5-5", entry) + u.costOf("claude-haiku-5-5", { input: 1_000, cacheRead: 150_000, cacheWrite: 0, cacheWrite1h: 0, output: 1_000 }));
assert.equal(today.cacheRead, 180_000);
const week = store.totals(spans.week);
assert.equal(week.calls, 3);
assert.equal(week.unpriced, 1);
assert.equal(week.input, 12 + 2_000 + 1_000);
assert.equal(store.totals(spans.month).calls, 4);
const first = store.rows(null, 2);
assert.equal(first.rows.length, 2);
assert.equal(first.more, true);
assert.equal(first.rows[0].model, "claude-haiku-5-5");
assert.deepEqual(first.rows[1].tools, ["memory_recall", "web_search"]);
near(first.rows[1].cost, u.costOf("anthropic/claude-opus-5-5", entry));
const next = store.rows(first.rows[1].id, 2);
assert.equal(next.rows.length, 2);
assert.equal(next.more, false);
assert.equal(next.rows[0].cost, null);
assert.deepEqual(next.rows[0].tools, []);
console.log("PASS the store sums today, 7 and 30 days from her midnight, pages back by row, prices on reading, and drops rows older than 90 days");
