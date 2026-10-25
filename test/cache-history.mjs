// Synthetic cache-prefix regressions. No private transcript, Worker, model, or network.
// Node 22+: node test/cache-history.mjs
// Compile real helpers in memory; adapt only Resident's DO/clock boundary to Node SQLite.
// This does not exercise the entire beforeTurn/letter compaction/provider pipeline.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertToModelMessages } from "ai";
import { truncateOlderMessages, truncateOlderToolResults } from "agents/chat";

const root = fileURLToPath(new URL("../", import.meta.url));
const residentSource = readFileSync(new URL("../src/resident.ts", import.meta.url), "utf8");
const thinkSource = readFileSync(new URL("./think.js", import.meta.resolve("@cloudflare/think")), "utf8");

async function compile(source, sourcefile) {
  const result = await build({
    stdin: { contents: source, loader: "ts", resolveDir: root, sourcefile },
    bundle: true, platform: "node", target: "node22", format: "esm", write: false, logLevel: "error",
  });
  const code = `${result.outputFiles[0].text}\n//# sourceURL=${sourcefile}.mjs`;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

// Fail loudly if the installed SDK or Resident changes shape. These are complete
// source declarations/methods, not hand-written copies of the algorithms under test.
function sdkFunction(name) {
  const match = thinkSource.match(new RegExp(`^function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(match, `cannot extract actual Think function ${name}`);
  return match[0];
}
function sdkConstant(name) {
  const match = thinkSource.match(new RegExp(`^const ${name} = [^;]+;`, "m"));
  assert.ok(match, `cannot extract actual Think constant ${name}`);
  return match[0];
}
function residentMethod(name) {
  const match = residentSource.match(new RegExp(`^  (?:private |override )*(?:async )?${name}\\([^\\n]*[\\s\\S]*?^  \\}`, "m"));
  assert.ok(match, `cannot extract actual Resident method ${name}`);
  return match[0];
}
function residentField(name) {
  const match = residentSource.match(new RegExp(`^  override ${name} = [^;]+;`, "m"));
  assert.ok(match, `cannot extract actual Resident field ${name}`);
  return match[0].replace("override ", ""); // the harness has no Think superclass
}

const { historyCutoff, historyAnchor, historyForWindow, letterHistoryFits, ResidentWindowHarness, truncationKeepRecent, SDK_STEP } = await compile(`
  import { historyCutoff, historyAnchor, historyForWindow, letterHistoryFits } from "./src/cache-history.ts";
  import { opensWindow, cacheTtlMs } from "./src/cache-window.ts";
  export { historyCutoff, historyAnchor, historyForWindow, letterHistoryFits };
  ${sdkConstant("MODEL_RECENT_WINDOW")}
  ${sdkConstant("MODEL_TRUNCATION_STEP")}
  ${sdkFunction("truncationStepSize")}
  export ${sdkFunction("truncationKeepRecent")}
  export const SDK_STEP = MODEL_TRUNCATION_STEP;
  export class ResidentWindowHarness {
    #letterPromptId: string | null = null;
    #letterReason = "handoff";
    #letterAttempted = false;
    #short = false;
    #drafts = new Map();
    #spoke = null;
    #draftActive = null;
    #outbox = new Map();
    #turnThread = new Map();
    #stickerSent = new Set();
    #turnTasks = new Map();
    #theirTurns = new Set();
    #readOutside = new Set();
    ctx = { storage: { put: async () => {} } };
    failed = null;
    failLetter(error) { this.failed = error; }
    constructor(public sql: any, public cfg: { CACHE_TTL?: string } = {}) {}
    setLetter(active: boolean) { this.#letterPromptId = active ? "synthetic-letter-prompt" : null; }
    ${residentField("truncationStep")}
    ${residentField("mediaEviction")}
    ${["windowHistory", "windowState", "setWindow", "cacheWindow", "letterJob", "saveLetterJob", "deleteLetterJob", "performWriteLetter", "beforeTurn"].map(residentMethod).join("\n")}
  }
`, "cache-history-harness.ts");

const RESULT = "synthetic tool result ".repeat(200).slice(0, 3261);
const LONG_TEXT = "Durable synthetic narrative. ".repeat(700);
const LONG_INPUT = { query: "synthetic lookup", document: "parameter stays whole ".repeat(400), options: { limit: 17 } };
assert.equal(RESULT.length, 3261);
const toolCall = (id) => ({ type: "tool-call", toolCallId: id, toolName: "synthetic_read", input: structuredClone(LONG_INPUT) });
const toolResult = (id, output = { type: "text", value: RESULT }) => ({
  type: "tool-result", toolCallId: id, toolName: "synthetic_read", output,
  providerOptions: { synthetic: { keep: true } },
});
const toolMessage = (id, output) => ({ role: "tool", content: [toolResult(id, output)] });
const mediaUser = (id) => ({ role: "user", content: [
  { type: "text", text: `${id}: ${LONG_TEXT}` },
  { type: "image", image: new Uint8Array([137, 80, 78, 71, 1, 2, 3]), mediaType: "image/png" },
  { type: "file", data: new Uint8Array([37, 80, 68, 70, 4, 5, 6]), mediaType: "application/pdf", filename: "synthetic.pdf" },
], providerOptions: { synthetic: { keep: true } } });
function turn(id) {
  return [
    mediaUser(`user-${id}`),
    { role: "assistant", content: [
      { type: "reasoning", text: "Synthetic reasoning retained as supplied." },
      { type: "text", text: LONG_TEXT }, toolCall(`call-${id}`),
    ] },
    toolMessage(`call-${id}`),
    { role: "assistant", content: LONG_TEXT },
  ];
}
function historyFixture() {
  return [{ role: "system", content: LONG_TEXT }, ...Array.from({ length: 8 }, (_, i) => turn(i)).flat()];
}
function freeze(value) {
  // Typed arrays cannot be frozen on Node. Snapshot checks below also compare their bytes.
  if (value && typeof value === "object" && !ArrayBuffer.isView(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const bytes = (messages) => Buffer.from(JSON.stringify(messages));
const outputOf = (messages, id) => messages.flatMap((message) => message.role === "tool" ? message.content : [])
  .find((part) => part.type === "tool-result" && part.toolCallId === id)?.output;
function unchangedTail(view, source, cutoff) {
  for (let i = cutoff; i < source.length; i++) assert.equal(view[i], source[i], `message ${i} must be passed through, not copied/compacted`);
}
function assertBounded(output) {
  assert.ok(output.type === "text" || output.type === "error-text", `expected bounded text, got ${output.type}`);
  assert.ok(output.value.length <= 500, `tool output exceeds 500 characters: ${output.value.length}`);
}

// A faithful control of the old pipeline: UI-message count selects the boundary;
// convertToModelMessages expands the tool-bearing assistant into model messages.
function oldUiFixture() {
  return Array.from({ length: 35 }, (_, i) => ({
    id: `synthetic-${i}`, role: i % 2 ? "assistant" : "user",
    parts: i === 25 ? [{
      type: "tool-synthetic_read", toolCallId: "sdk-regression", state: "output-available",
      input: structuredClone(LONG_INPUT), output: RESULT,
    }] : [{ type: "text", text: `synthetic message ${i}` }],
  }));
}
const syntheticTools = { synthetic_read: { toModelOutput: ({ output }) => ({ type: "text", value: output }) } };

test("old SDK regression: 35 -> 37 UI messages changes an existing 3261-character result to 500", async () => {
  const first = freeze(oldUiFixture());
  const later = freeze([...first, { id: "next-user", role: "user", parts: [{ type: "text", text: "synthetic next question" }] },
    { id: "next-assistant", role: "assistant", parts: [{ type: "text", text: "synthetic next answer" }] }]);
  const snapshot = structuredClone(later);
  assert.equal(first.length, 35);
  assert.equal(later.length, 37);
  assert.equal(SDK_STEP, 8);
  const beforeKeep = truncationKeepRecent(first.length, SDK_STEP);
  const afterKeep = truncationKeepRecent(later.length, SDK_STEP);
  assert.equal(first.length - beforeKeep, 24);
  assert.equal(later.length - afterKeep, 32);
  const beforeModel = await convertToModelMessages(first, { tools: syntheticTools });
  const afterModel = await convertToModelMessages(later, { tools: syntheticTools });
  const before = truncateOlderToolResults(beforeModel, first, { keepRecent: beforeKeep });
  const after = truncateOlderToolResults(afterModel, later, { keepRecent: afterKeep });
  assert.equal(outputOf(before, "sdk-regression").value.length, 3261);
  assert.equal(outputOf(after, "sdk-regression").value.length, 500);
  assert.match(outputOf(after, "sdk-regression").value, /truncated 3261 chars/);
  assert.notDeepEqual(bytes(after.slice(0, before.length)), bytes(before), "old cached prefix really changes");
  assert.equal(outputOf(afterModel, "sdk-regression").value, RESULT, "SDK projection does not mutate its input either");
  assert.deepEqual(later, snapshot);
});

test("Resident's actual overrides disable both SDK text/tool truncation and media eviction", async () => {
  const resident = new ResidentWindowHarness(() => { throw new Error("SQL not used here"); });
  assert.equal(resident.truncationStep, Infinity);
  assert.equal(resident.mediaEviction, false);
  for (const count of [0, 3, 4, 8, 35, 37, 80]) {
    assert.ok(truncationKeepRecent(count, resident.truncationStep) >= count);
  }
  const ui = oldUiFixture();
  ui[0].parts[0].text = LONG_TEXT;
  const keepRecent = truncationKeepRecent(ui.length, resident.truncationStep);
  assert.equal(truncateOlderMessages(ui, { keepRecent, toolOutputs: false }), ui);
  const model = await convertToModelMessages(ui, { tools: syntheticTools });
  assert.equal(truncateOlderToolResults(model, ui, { keepRecent }), model);
  assert.equal(model[0].content[0].text, LONG_TEXT);
  assert.equal(outputOf(model, "sdk-regression").value.length, 3261);
});

test("beforeTurn source wiring passes ctx.messages through windowHistory and uses that view for letters too", () => {
  // Static wiring guard, not a claim to execute the full DO lifecycle.
  const beforeTurn = residentMethod("beforeTurn");
  assert.match(beforeTurn, /const messages = this\.windowHistory\(ctx\.messages\);/);
  assert.match(beforeTurn, /markedForLetter\(messages, this\.letterCache\(\)\)/);
  assert.match(beforeTurn, /\{ messages, providerOptions: promptCache\(this\.cfg\) \}/);
});

test("fixed cutoff preserves the entire serialized prefix after 8+ appended messages and multiple turns", () => {
  const original = freeze(historyFixture());
  const snapshot = structuredClone(original);
  const cutoff = historyCutoff(original);
  assert.equal(cutoff, original.length - 8);
  const first = historyForWindow(original, cutoff);
  const prefix = bytes(first);
  assert.equal(outputOf(first, "call-0").value.length, 500);
  assert.equal(outputOf(first, "call-6").value.length, 3261);
  let growing = original;
  for (let i = 8; i < 13; i++) {
    growing = freeze([...growing, ...turn(i)]);
    const view = historyForWindow(growing, cutoff);
    assert.deepEqual(bytes(view.slice(0, original.length)), prefix);
    unchangedTail(view, growing, cutoff);
    assert.equal(outputOf(view, "call-6").value.length, 3261, "formerly recent result never ages out in this window");
    assert.equal(outputOf(view, `call-${i}`).value, RESULT);
  }
  assert.ok(growing.length - original.length > 8);
  assert.deepEqual(original, snapshot);
});

test("multi-step tools inside a turn never recut or alter any already-sent prefix", () => {
  const original = freeze(historyFixture());
  const cutoff = historyCutoff(original);
  let growing = freeze([...original, { role: "user", content: "synthetic multi-step task" }]);
  let previous = historyForWindow(growing, cutoff);
  for (let step = 0; step < 7; step++) {
    const id = `in-flight-${step}`;
    growing = freeze([...growing, { role: "assistant", content: [toolCall(id)] }, toolMessage(id)]);
    const snapshot = structuredClone(growing);
    const view = historyForWindow(growing, cutoff);
    assert.deepEqual(bytes(view.slice(0, previous.length)), bytes(previous), `step ${step} changes prefix`);
    unchangedTail(view, growing, cutoff);
    assert.equal(outputOf(view, id).value, RESULT);
    assert.deepEqual(growing, snapshot);
    previous = view;
  }
});

test("only selecting a new window cutoff reduces previously recent/appended results and media", () => {
  const original = freeze(historyFixture());
  const cutoff = historyCutoff(original);
  const growing = freeze([...original, ...turn(8), ...turn(9), ...turn(10)]);
  const oldView = historyForWindow(growing, cutoff);
  const newCutoff = historyCutoff(growing);
  assert.ok(newCutoff > cutoff);
  const newView = historyForWindow(growing, newCutoff);
  for (const id of ["call-6", "call-7", "call-8"]) {
    assert.equal(outputOf(oldView, id).value.length, 3261);
    assert.equal(outputOf(newView, id).value.length, 500);
  }
  assert.equal(oldView[cutoff].content[1].type, "image");
  assert.equal(newView[cutoff].content[1].type, "text");
  unchangedTail(newView, growing, newCutoff);
});

test("long-term system/user/assistant text, reasoning, tool arguments and metadata stay whole", () => {
  const original = freeze(historyFixture());
  const snapshot = structuredClone(original);
  const view = historyForWindow(original, historyCutoff(original));
  assert.equal(view[0], original[0]);
  assert.equal(view[1].content[0], original[1].content[0]);
  assert.equal(view[1].content[0].text, `user-0: ${LONG_TEXT}`);
  assert.equal(view[2], original[2]);
  assert.deepEqual(view[2].content.at(-1).input, LONG_INPUT);
  assert.equal(view[4], original[4]);
  assert.deepEqual(view[1].providerOptions, original[1].providerOptions);
  assert.deepEqual(view[3].content[0].providerOptions, original[3].content[0].providerOptions);
  assert.equal(view[3].content[0].toolCallId, "call-0");
  assert.equal(view[3].content[0].toolName, "synthetic_read");
  assert.deepEqual(original, snapshot);
});

test("old user images/files become text markers only in the view; stored binary, files and recent media are intact", () => {
  const original = freeze(historyFixture());
  const snapshot = structuredClone(original);
  const cutoff = historyCutoff(original);
  const view = historyForWindow(original, cutoff);
  for (const index of [1, 5, 9]) {
    assert.equal(view[index].content[0], original[index].content[0]);
    for (const partIndex of [1, 2]) {
      const marker = view[index].content[partIndex];
      assert.equal(marker.type, "text");
      assert.match(marker.text, /media omitted/i);
      assert.match(marker.text, /original remains/i);
      assert.equal("image" in marker || "data" in marker, false);
    }
  }
  unchangedTail(view, original, cutoff);
  assert.equal(view[cutoff].content[1], original[cutoff].content[1]);
  assert.equal(view[cutoff].content[2], original[cutoff].content[2]);
  assert.deepEqual(original, snapshot);
  assert.equal(original[1].content[1].image.byteLength, 7);
  assert.equal(original[1].content[2].filename, "synthetic.pdf");
});

for (const type of ["text", "error-text"]) {
  test(`${type} outputs respect the exact 500-character bound, including suffix, without changing originals`, () => {
    for (const length of [0, 1, 499, 500, 501, 3261]) {
      const output = freeze({ type, value: "x".repeat(length) });
      const messages = freeze([toolMessage("bound", output)]);
      const view = historyForWindow(messages, 1);
      const compact = outputOf(view, "bound");
      assertBounded(compact);
      assert.equal(compact.type, type);
      assert.equal(compact.value.length, Math.min(length, 500));
      if (length <= 500) assert.equal(compact, output);
      else assert.match(compact.value, new RegExp(`truncated ${length} chars`));
      assert.equal(output.value.length, length);
      assert.equal(historyForWindow(messages, 0)[0], messages[0]);
    }
  });
}

for (const type of ["json", "error-json"]) {
  test(`${type} keeps small structured values but bounds large/deep/wide serialized results`, () => {
    const baseLength = JSON.stringify({ blob: "" }).length;
    const cases = [null, true, 42, { ok: true, rows: [1, 2] }, { blob: "x".repeat(500 - baseLength) },
      { blob: "x".repeat(501 - baseLength) }, { nested: { rows: Array.from({ length: 40 }, (_, i) => ({ i, text: RESULT })) } }];
    for (const value of cases) {
      const output = freeze({ type, value });
      const snapshot = structuredClone(output);
      const messages = freeze([toolMessage("json", output)]);
      const compact = outputOf(historyForWindow(messages, 1), "json");
      const serialized = JSON.stringify(value);
      if (serialized.length <= 500) assert.equal(compact, output);
      else {
        assertBounded(compact);
        assert.equal(compact.type, type === "json" ? "text" : "error-text");
        assert.ok(serialized.startsWith(compact.value.split("... [truncated")[0]));
        assert.match(compact.value, new RegExp(`truncated ${serialized.length} chars`));
      }
      assert.deepEqual(output, snapshot);
      assert.equal(outputOf(historyForWindow(messages, 0), "json"), output);
    }
  });
}

test("content tools bound combined text and replace image/file bytes without serializing their payloads", () => {
  const payload = "SYNTHETIC_BINARY_PAYLOAD_".repeat(1000);
  const cases = [[], [{ type: "text", text: "short" }], [{ type: "text", text: "x".repeat(500) }],
    [{ type: "text", text: "a".repeat(300) }, { type: "text", text: "b".repeat(300) }],
    [{ type: "text", text: RESULT }],
    [{ type: "text", text: "caption" }, { type: "image-data", data: payload, mediaType: "image/png" },
      { type: "file-data", data: payload, mediaType: "application/pdf", filename: "synthetic.pdf" }],
    [{ type: "image-url", url: "https://example.invalid/synthetic.png" }],
  ];
  for (const value of cases) {
    const output = freeze({ type: "content", value });
    const snapshot = structuredClone(output);
    const messages = freeze([toolMessage("content", output)]);
    const compact = outputOf(historyForWindow(messages, 1), "content");
    const onlyShortText = value.every((part) => part.type === "text") && value.map((part) => part.text).join("\n").length <= 500;
    if (onlyShortText) assert.equal(compact, output);
    else {
      assertBounded(compact);
      assert.equal(compact.value.includes("SYNTHETIC_BINARY_PAYLOAD_"), false);
      if (value.some((part) => part.type !== "text")) assert.match(compact.value, /media omitted/i);
    }
    assert.deepEqual(output, snapshot);
    assert.equal(outputOf(historyForWindow(messages, 0), "content"), output);
  }
});

test("empty/small histories keep at least eight messages and align the cutoff to the user exchange", () => {
  for (let count = 0; count <= 16; count++) {
    const messages = freeze(Array.from({ length: count }, (_, i) => i % 3 === 0
      ? { role: "user", content: `synthetic small question ${i}` }
      : i % 3 === 1 ? { role: "assistant", content: [toolCall(`small-${i}`)] } : toolMessage(`small-${i - 1}`)));
    const cutoff = historyCutoff(messages);
    assert.equal(cutoff, Math.floor(Math.max(0, count - 8) / 3) * 3);
    const view = historyForWindow(messages, cutoff);
    assert.equal(view.length, count);
    unchangedTail(view, messages, cutoff);
    for (let i = 0; i < cutoff; i++) {
      if (view[i].role === "tool") assert.equal(view[i].content[0].output.value.length, 500);
    }
  }
});

test("new cutoff does not split an unusually long user exchange or its multi-step tool chain", () => {
  const messages = freeze([...turn("older"), { role: "user", content: "synthetic long task" },
    ...Array.from({ length: 10 }, (_, i) => [
      { role: "assistant", content: [toolCall(`long-step-${i}`)] }, toolMessage(`long-step-${i}`),
    ]).flat(), { role: "assistant", content: "synthetic final answer" }]);
  assert.ok(messages.length - 8 > 4);
  assert.equal(historyCutoff(messages), 4, "roll back to the user, not halfway through tools");
  const view = historyForWindow(messages, 4);
  assert.equal(outputOf(view, "call-older").value.length, 500);
  unchangedTail(view, messages, 4);
});

function sqliteFixture(t, ttl = "1h") {
  const directory = mkdtempSync(join(tmpdir(), "resident-cache-history-"));
  const filename = join(directory, "state.sqlite");
  let db;
  let clock = 1_000_000_000;
  t.mock.method(Date, "now", () => clock);
  const sql = (strings, ...values) => {
    const statement = db.prepare(strings.join("?"));
    if (statement.columns().length) return statement.all(...values);
    statement.run(...values);
    return [];
  };
  function open() {
    db?.close(); // Real close/reopen of a file-backed DB, not merely a new wrapper.
    db = new DatabaseSync(filename);
    return new ResidentWindowHarness(sql, { CACHE_TTL: ttl });
  }
  t.after(() => { db?.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    resident: open(), reopen: open,
    advance(ms) { clock += ms; },
    get now() { return clock; },
    row() { return { ...db.prepare("SELECT * FROM res_cache_history WHERE id = 1").get() }; },
    columns() { return db.prepare("PRAGMA table_info(res_cache_history)").all().map((column) => column.name); },
  };
}

test("actual Resident windowHistory persists only its boundary and retains it after database close/reopen", (t) => {
  const f = sqliteFixture(t);
  const original = freeze(historyFixture());
  const first = f.resident.windowHistory(original);
  const row = f.row();
  assert.deepEqual(f.columns(), ["id", "opened_at", "cutoff", "anchor"], "boundary plus digest, no second copy of transcript/media");
  assert.deepEqual(row, { id: 1, opened_at: f.now, cutoff: historyCutoff(original), anchor: historyAnchor(original, historyCutoff(original)) });
  assert.match(row.anchor, /^[a-f0-9]{64}$/);
  const growing = freeze([...original, ...turn(8), ...turn(9), ...turn(10)]);
  assert.deepEqual(bytes(f.resident.windowHistory(growing).slice(0, original.length)), bytes(first));
  const reopened = f.reopen();
  const view = reopened.windowHistory(growing);
  assert.deepEqual(f.row(), row);
  assert.deepEqual(view, historyForWindow(growing, row.cutoff));
  assert.deepEqual(bytes(view.slice(0, original.length)), bytes(first));
  assert.equal(outputOf(view, "call-6").value.length, 3261);
});

test("warm ongoing use can span hours without reselecting the persisted boundary", (t) => {
  const f = sqliteFixture(t);
  const original = freeze(historyFixture());
  const prefix = bytes(f.resident.windowHistory(original));
  const row = f.row();
  for (let i = 0; i < 12; i++) {
    f.advance(30 * 60_000);
    f.resident.setWindow("used_at", f.now); // onStepFinish's storage boundary
    const growing = freeze([...original, ...turn(8 + i)]);
    assert.deepEqual(bytes(f.resident.windowHistory(growing).slice(0, original.length)), prefix);
    assert.deepEqual(f.row(), row);
  }
  assert.ok(f.now - row.opened_at > 60 * 60_000);
});

for (const [ttl, ttlMs] of [["1h", 60 * 60_000], ["5m", 5 * 60_000]]) {
  test(`actual Resident reselects cutoff after ${ttl} expiry, not while the old window is valid`, (t) => {
    const f = sqliteFixture(t, ttl);
    const original = freeze(historyFixture());
    f.resident.windowHistory(original);
    const row = f.row();
    const growing = freeze([...original, ...turn(8), ...turn(9), ...turn(10)]);
    f.advance(ttlMs);
    assert.equal(outputOf(f.resident.windowHistory(growing), "call-6").value.length, 3261);
    assert.deepEqual(f.row(), row);
    f.advance(1);
    const view = f.resident.windowHistory(growing);
    assert.deepEqual(f.row(), { id: 1, opened_at: f.now, cutoff: historyCutoff(growing), anchor: historyAnchor(growing, historyCutoff(growing)) });
    assert.deepEqual(view, historyForWindow(growing, historyCutoff(growing)));
    assert.equal(outputOf(view, "call-6").value.length, 500);
    unchangedTail(view, growing, historyCutoff(growing));
  });
}

test("letter retains the previous view even after expiry and reopening; fold opens a new window on shortened history", (t) => {
  const f = sqliteFixture(t);
  const original = freeze(historyFixture());
  const first = f.resident.windowHistory(original);
  const row = f.row();
  const growing = freeze([...original, ...turn(8), ...turn(9), ...turn(10)]);
  f.advance(61 * 60_000);
  const resident = f.reopen();
  resident.setLetter(true);
  const letterHistory = freeze([...growing, { role: "user", content: "Synthetic instruction to write a handoff letter." }]);
  const letterView = resident.windowHistory(letterHistory);
  assert.deepEqual(f.row(), row, "expired letter must not open/reselect a window");
  assert.deepEqual(bytes(letterView.slice(0, original.length)), bytes(first));
  assert.deepEqual(letterView, historyForWindow(letterHistory, row.cutoff));
  unchangedTail(letterView, letterHistory, row.cutoff);
  assert.equal(outputOf(letterView, "call-6").value.length, 3261);

  // Model actual post-compaction inputs/flag, not the Sessions compaction engine.
  // performWriteLetter/performResumeLetter set this same persisted folded flag.
  resident.setLetter(false);
  resident.setWindow("used_at", f.now); // keep it warm, so fold (not expiry) causes the new window
  resident.setWindow("folded", 1);
  f.advance(1);
  const folded = freeze([{ role: "user", content: "Synthetic handoff summary." }, ...growing.slice(-16)]);
  const view = resident.windowHistory(folded);
  assert.notEqual(historyCutoff(folded), row.cutoff, "shortened input needs a fresh model-message index");
  assert.deepEqual(f.row(), { id: 1, opened_at: f.now, cutoff: historyCutoff(folded), anchor: historyAnchor(folded, historyCutoff(folded)) });
  assert.equal(resident.windowState().get("folded"), 0);
  assert.deepEqual(view, historyForWindow(folded, historyCutoff(folded)));
  unchangedTail(view, folded, historyCutoff(folded));
  assert.equal(outputOf(view, "call-8").value.length, 500);
  assert.equal(outputOf(view, "call-10").value.length, 3261);
  const reopened = f.reopen();
  assert.deepEqual(reopened.windowHistory(folded), view);
});

test("a persisted zero cutoff stays zero as an initially empty window grows beyond eight messages", (t) => {
  const f = sqliteFixture(t);
  assert.deepEqual(f.resident.windowHistory([]), []);
  const row = f.row();
  assert.equal(row.cutoff, 0);
  const growing = freeze(historyFixture());
  const resident = f.reopen();
  const view = resident.windowHistory(growing);
  assert.deepEqual(f.row(), row);
  unchangedTail(view, growing, 0);
  assert.deepEqual(view, growing);
  f.advance(60 * 60_000 + 1);
  assert.equal(outputOf(resident.windowHistory(growing), "call-0").value.length, 500);
});

test("anchor hashes only the retained prefix, detects byte/text changes, and does not store payloads", () => {
  const messages = freeze(historyFixture());
  const snapshot = structuredClone(messages);
  const cutoff = historyCutoff(messages);
  const anchor = historyAnchor(messages, cutoff);
  assert.match(anchor, /^[a-f0-9]{64}$/);
  assert.equal(historyAnchor([...messages, ...turn("appended")], cutoff), anchor);
  const changedTail = structuredClone(messages);
  changedTail.at(-1).content = "synthetic changed recent tail";
  assert.equal(historyAnchor(changedTail, cutoff), anchor);
  const changedText = structuredClone(messages);
  changedText[0].content += "synthetic branch change";
  assert.notEqual(historyAnchor(changedText, cutoff), anchor);
  const changedBytes = structuredClone(messages);
  changedBytes[1].content[1].image[0] ^= 1;
  assert.notEqual(historyAnchor(changedBytes, cutoff), anchor);
  assert.deepEqual(messages, snapshot);
});

test("non-append history changes invalidate saved coordinates without pretending the old prefix is reusable", (t) => {
  const f = sqliteFixture(t);
  const original = freeze(historyFixture());
  f.resident.windowHistory(original);
  const row = f.row();
  const branch = structuredClone([...original, ...turn(8), ...turn(9), ...turn(10)]);
  branch[0].content = "Synthetic different branch head.";
  freeze(branch);
  const branchView = f.resident.windowHistory(branch);
  assert.equal(f.row().opened_at, row.opened_at, "underlying cache window is still warm");
  assert.notEqual(f.row().anchor, row.anchor);
  assert.equal(f.row().cutoff, historyCutoff(branch));
  assert.deepEqual(branchView, historyForWindow(branch, historyCutoff(branch)));

  const sliding = freeze(branch.slice(-12));
  assert.ok(sliding.length < f.row().cutoff, "old model-message coordinate is out of range");
  const view = f.resident.windowHistory(sliding);
  assert.equal(f.row().cutoff, historyCutoff(sliding));
  assert.equal(f.row().anchor, historyAnchor(sliding, historyCutoff(sliding)));
  assert.deepEqual(view, historyForWindow(sliding, historyCutoff(sliding)));
  unchangedTail(view, sliding, historyCutoff(sliding));
});

test("a persisted in-flight letter keeps cacheWindow old even before beforeTurn restores the letter flag", (t) => {
  const f = sqliteFixture(t);
  const history = freeze(historyFixture());
  const first = f.resident.windowHistory(history);
  const row = f.row();
  f.resident.saveLetterJob({
    promptId: "synthetic-recovery-prompt", reason: "handoff", fromMessageId: "synthetic-start",
    toMessageId: "synthetic-end", summary: null, createdAt: f.now,
  });
  f.advance(61 * 60_000);
  const recovered = f.reopen(); // #letterPromptId is null, but the job is durable
  assert.equal(recovered.cacheWindow(), row.opened_at, "getTools/boot must not preemptively open a new window");
  assert.deepEqual(recovered.windowHistory(history), first);
  assert.deepEqual(f.row(), row);
  recovered.deleteLetterJob("synthetic-recovery-prompt");
  assert.equal(recovered.cacheWindow(), f.now, "ordinary turn can open a window once no letter remains");
});

test("provider-executed tool results retain their native output schema", () => {
  const part = toolResult("native", { type: "json", value: { native: RESULT } });
  const source = freeze([
    { role: "assistant", content: [{ ...toolCall("native"), providerExecuted: true }] },
    { role: "tool", content: [part] },
    { role: "assistant", content: [toolCall("native")] },
    toolMessage("native"),
  ]);
  const view = historyForWindow(source, source.length);
  assert.equal(view[1].content[0], part);
  assert.deepEqual(view.slice(0, 2), source.slice(0, 2));
  assert.equal(view[3].content[0].output.value.length, 500, "a reused ID does not make the next own call native");
});

test("hydration admission reserves prompt space and rejects oversized metadata without loading payloads", () => {
  const budget = 32 * 1024 * 1024;
  assert.equal(letterHistoryFits([{ bytes: budget - 65536 }], budget), true);
  assert.equal(letterHistoryFits([{ bytes: budget - 65535 }], budget), false);
  assert.equal(letterHistoryFits([{ bytes: budget + 1 }], budget, 0), false);
  assert.equal(letterHistoryFits([{ bytes: budget }], budget, 0), true);
});

test("actual letter admission refuses an incomplete-hydration risk before reading or compacting full history", async (t) => {
  const f = sqliteFixture(t);
  f.resident.hydrationByteBudget = 32 * 1024 * 1024;
  let metadataReads = 0;
  f.resident.session = {
    getHistoryRowStats: async () => { metadataReads++; return [{ bytes: 33 * 1024 * 1024 }]; },
    getHistory: async () => { throw new Error("must not load oversized payloads"); },
    compact: async () => { throw new Error("must not fold unseen messages"); },
  };
  const result = await f.resident.performWriteLetter("handoff");
  assert.equal(result.status, "failed");
  assert.match(result.error, /安全装载范围/);
  assert.equal(f.resident.failed, result.error);
  assert.equal(metadataReads, 1);
  assert.equal(f.resident.letterJob(), null);
});

test("actual beforeTurn rechecks after admission, even when a pending letter is not the latest live user message", async (t) => {
  const f = sqliteFixture(t);
  const budget = f.resident.hydrationByteBudget = 32 * 1024 * 1024;
  assert.equal(letterHistoryFits([{ bytes: budget - 65536 }], budget), true, "initial admission can pass");
  const job = { promptId: "synthetic-over-budget", reason: "handoff", fromMessageId: "start", toMessageId: "end", summary: null, createdAt: f.now };
  f.resident.saveLetterJob(job);
  f.resident.userMessageBefore = () => null;
  f.resident.session = { getHistoryRowStats: async () => [{ bytes: budget + 1 }] };
  await assert.rejects(f.resident.beforeTurn({ messages: [], tools: {}, system: "synthetic" }), /safe hydration budget/);
  assert.deepEqual(f.resident.letterJob(), job, "the admission hook does not discard original history or a recovery job");
});

test("a letter without any preceding saved view can initialize a window", (t) => {
  const f = sqliteFixture(t);
  f.resident.setLetter(true);
  const history = freeze(historyFixture());
  assert.deepEqual(f.resident.windowHistory(history), historyForWindow(history, historyCutoff(history)));
  assert.deepEqual(f.row(), { id: 1, opened_at: f.now, cutoff: historyCutoff(history), anchor: historyAnchor(history, historyCutoff(history)) });
});
