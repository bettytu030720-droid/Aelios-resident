// The claude-code/… models without a Worker: what goes to the Claude box and what it keeps (src/claude-code.ts),
// and the box's own transcript handling (claude-box/transcript.mjs). Usage: node test/claude-code.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-claude-code-"));
const out = join(dir, "claude-code.mjs");
await build({ entryPoints: ["src/claude-code.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const code = await import(pathToFileURL(join(process.cwd(), out)).href);
rmSync(dir, { recursive: true, force: true });
const box = await import(pathToFileURL(join(process.cwd(), "claude-box/transcript.mjs")).href);

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

const text = (t, extra = {}) => ({ type: "text", text: t, ...extra });
const user = (...content) => ({ role: "user", content });
const assistant = (...content) => ({ role: "assistant", content });

await step("a fingerprint is what a message says: cache marks, thinking and how the text is split do not count", async () => {
  const plain = await code.fingerprint("assistant", [text("你好呀")]);
  assert.equal(await code.fingerprint("assistant", "你好呀"), plain);
  assert.equal(await code.fingerprint("assistant", [{ type: "thinking", thinking: "嗯", signature: "s" }, text("你好"), text("呀")]), plain);
  assert.equal(await code.fingerprint("assistant", [text("你好呀", { cache_control: { type: "ephemeral", ttl: "1h" } })]), plain);
  assert.notEqual(await code.fingerprint("user", [text("你好呀")]), plain, "who said it counts");
  assert.notEqual(await code.fingerprint("assistant", [text("你好")]), plain);
  const picture = (data) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
  assert.notEqual(await code.fingerprint("user", [picture("AAAA")]), await code.fingerprint("user", [picture("BBBB")]), "a different picture");
});

await step("a message the box never saw goes as it is, without what the box cannot take", async () => {
  const picture = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" }, cache_control: { type: "ephemeral" } };
  assert.deepEqual(code.plainBlocks("user", [text("看", { cache_control: { type: "ephemeral" } }), picture]), [
    text("看"),
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }
  ]);
  assert.deepEqual(code.plainBlocks("assistant", [{ type: "thinking", thinking: "嗯", signature: "s" }, text("好"), { type: "tool_use", id: "t1", name: "memory_recall", input: { query: "猫" } }]), [
    text("好"),
    text('[用了工具 memory_recall：{"query":"猫"}]')
  ]);
  assert.deepEqual(code.plainBlocks("user", [{ type: "tool_result", tool_use_id: "t1", content: [text("小橘是楼下的猫")] }]), [text("[工具的结果]\n小橘是楼下的猫")]);
  assert.deepEqual(code.plainBlocks("assistant", [{ type: "thinking", thinking: "嗯", signature: "s" }]), [text("…")], "never empty");
  assert.equal(code.plainBlocks("user", [{ type: "tool_result", tool_use_id: "t", content: "长".repeat(5000) }])[0].text.length, 4001);
});

await step("the history: the box's own entries while they match, as it is from the first message that does not", async () => {
  const messages = [user(text("一")), assistant(text("二")), user(text("三")), assistant(text("四"))];
  const fps = await Promise.all(messages.map((m) => code.fingerprint(m.role, m.content)));
  const held = fps.map((fp, i) => ({ fp, entries: i === 1 ? null : [{ type: "user", uuid: `u${i}` }] }));
  let { history, kept } = await code.historyFor(messages, held);
  assert.deepEqual(history.map((item) => (item.entries ? "entries" : item.role)), ["entries", "assistant", "entries", "entries"], "one kept without entries goes as it is");
  assert.deepEqual(kept, held);
  // The second reply was changed after it was sent (say, a sticker taken out): from there on, as it is.
  const changed = [...messages.slice(0, 3), assistant(text("四！"))];
  ({ history, kept } = await code.historyFor(changed, held));
  assert.deepEqual(history.map((item) => (item.entries ? "entries" : item.role)), ["entries", "assistant", "entries", "assistant"]);
  assert.equal(kept[3].entries, null);
  // A letter folded the start: nothing matches any more.
  ({ history } = await code.historyFor([user(text("[交接信] …")), ...messages.slice(2)], held));
  assert.deepEqual(history.map((item) => (item.entries ? "entries" : item.role)), ["user", "user", "assistant"]);
  // More messages than the box holds.
  ({ history } = await code.historyFor([...messages, user(text("五")), assistant(text("六"))], held));
  assert.deepEqual(history.map((item) => (item.entries ? "entries" : item.role)).slice(4), ["user", "assistant"]);
});

await step("why the box turned a turn down, said simply", async () => {
  assert.equal(code.boxError("Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token is invalid.").status, 401);
  assert.match(code.boxError("Not logged in · Please run /login").message, /setup token 不对或过期/);
  assert.match(code.boxError("Claude AI usage limit reached|1793200000").message, /额度用完了/);
  assert.match(code.boxError("").message, /没回/);
});

await step("a call that does not stream gets the reply as one message", async () => {
  const message = code.messageOf([
    { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], usage: { input_tokens: 3, cache_read_input_tokens: 100 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "o" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "k" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: "message_stop" }
  ]);
  assert.deepEqual(message.content, [{ type: "thinking", thinking: "想", signature: "sig" }, { type: "text", text: "ok" }]);
  assert.equal(message.stop_reason, "end_turn");
  assert.deepEqual(message.usage, { input_tokens: 3, cache_read_input_tokens: 100, output_tokens: 2 });
});

await step("a whole turn through boxFetch: her words with what memory brought up, the box's stream as the Messages API, the turn kept", async () => {
  const messages = [user(text("[10-28 21:00] 第一句")), assistant(text("回一")), user(text("[10-28 21:01] 生日是哪天？", { cache_control: { type: "ephemeral" } }))];
  const held = [{ fp: await code.fingerprint("user", messages[0].content), entries: [{ type: "user", uuid: "a" }] }, { fp: await code.fingerprint("assistant", messages[1].content), entries: [{ type: "assistant", uuid: "b" }] }];
  let sent;
  let saved;
  const recorded = [];
  const events = [
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 900, cache_creation_input_tokens: 30 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "春天" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "。" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" }
  ];
  const turn = {
    token: "sk-ant-oat01-x",
    async send(body) {
      sent = JSON.parse(body);
      const lines = [...events.map((e) => ({ e })), { done: { prompt: [{ type: "user", uuid: "c" }], reply: [{ type: "assistant", uuid: "d" }] } }];
      return new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(""), { headers: { "content-type": "application/x-ndjson" } });
    },
    segments: { load: () => held, save: (segments) => (saved = segments) },
    recall: async (said) => (said.includes("生日") ? "[Aelios 记忆]\n- 她的生日在春天" : ""),
    record: (said, reply) => recorded.push([said, reply])
  };
  const fetcher = code.boxFetch(turn, { effort: "high" });
  const response = await fetcher("https://claude-box.invalid/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "claude-opus-5-5", stream: true, system: [text("人设"), text("规矩")], messages, tools: [{ name: "memory_recall" }] })
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const sse = await response.text();
  assert.match(sse, /^event: message_start\ndata: /);
  assert.equal((sse.match(/^event: /gm) ?? []).length, events.length);
  assert.equal(sent.token, "sk-ant-oat01-x");
  assert.equal(sent.model, "claude-opus-5-5");
  assert.match(sent.system, /^人设\n\n规矩\n\nIn this conversation you have no tools: .+ comes back as the \[Aelios 记忆\] block\.$/, "the tools it was offered are not there");
  assert.equal(sent.effort, "high");
  assert.equal(sent.thinking, "summarized", "Opus 5.5 thinks unasked, so its thinking is asked to be shown");
  assert.deepEqual(sent.history, [{ entries: [{ type: "user", uuid: "a" }] }, { entries: [{ type: "assistant", uuid: "b" }] }]);
  assert.deepEqual(sent.prompt, [text("[10-28 21:01] 生日是哪天？"), text("[Aelios 记忆]\n- 她的生日在春天")], "memory after her words, no cache mark");
  assert.equal(saved.length, 4);
  assert.deepEqual(saved.slice(0, 2), held);
  assert.equal(saved[2].fp, await code.fingerprint("user", messages[2].content), "her turn as Think will send it again, without the memory note");
  assert.deepEqual(saved[2].entries, [{ type: "user", uuid: "c" }]);
  assert.equal(saved[3].fp, await code.fingerprint("assistant", [text("春天。")]));
  assert.deepEqual(recorded, [["[10-28 21:01] 生日是哪天？", "春天。"]]);
});

await step("the system's notes and work outside the conversation are not recalled, recorded or kept", async () => {
  let sent;
  let saved = null;
  const recorded = [];
  const answer = () => new Response(`${JSON.stringify({ e: { type: "message_start", message: { id: "m", type: "message", role: "assistant", usage: { input_tokens: 1 } } } })}\n${JSON.stringify({ e: { type: "message_stop" } })}\n${JSON.stringify({ done: { prompt: [], reply: [] } })}\n`);
  const note = "(Not from them: they have been quiet for a while.) 要不要找她？";
  await (await code.boxFetch({ token: "t", send: async (b) => ((sent = JSON.parse(b)), answer()), segments: { load: () => [], save: (s) => (saved = s) }, recall: async () => "不该有", record: (...a) => recorded.push(a) })(
    "u",
    { body: JSON.stringify({ model: "claude-opus-5-5", stream: true, messages: [user(text(note))] }) }
  )).text();
  assert.deepEqual(sent.prompt, [text(note)], "no memory for a note");
  assert.deepEqual(recorded, []);
  assert.equal(saved.length, 2, "but the conversation keeps the turn");
  // A trial call: one call, nothing kept, no thinking shown when not asked.
  const response = await code.boxFetch({ token: "t", send: async (b) => ((sent = JSON.parse(b)), answer()) })("u", {
    body: JSON.stringify({ model: "claude-opus-5-5", messages: [user(text("Reply with one word: ok"))] })
  });
  assert.equal(sent.thinking, null);
  assert.equal(sent.effort, null);
  assert.equal(sent.system, "", "no tools offered, so nothing is said about them");
  assert.equal((await response.json()).type, "message", "a whole message for a call that does not stream");
});

await step("the box turning a turn down, or not there, is a refused call with the reason", async () => {
  const lines = (...l) => new Response(l.map((x) => `${JSON.stringify(x)}\n`).join(""));
  const call = (turn) => code.boxFetch(turn)("u", { body: JSON.stringify({ model: "claude-opus-5-5", stream: true, messages: [user(text("hi"))] }) });
  let response = await call({ token: "", send: async () => assert.fail("not sent without a token") });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error.message, /还没填 Claude 订阅的 setup token/);
  response = await call({ token: "t", send: async () => lines({ error: "Failed to authenticate. API Error: 401 OAuth access token is invalid." }) });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error.message, /setup token 不对或过期/);
  response = await call({ token: "t", send: async () => Response.json({ error: "这次部署没带 Claude 容器" }, { status: 501 }) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /这次部署没带 Claude 容器/);
  response = await call({ token: "t", send: async () => Response.json({ error: "Claude 容器没起来" }, { status: 503 }) });
  assert.equal(response.status, 503, "a box still starting can be tried again");
  response = await call({ token: "t", send: async () => { throw new Error("network"); } });
  assert.equal(response.status, 503);
  // Cut off after it started: the stream ends with an error event, and nothing is kept.
  let saved = null;
  response = await call({
    token: "t",
    send: async () => lines({ e: { type: "message_start", message: { id: "m", usage: { input_tokens: 1 } } } }, { error: "API Error: 529 overloaded" }),
    segments: { load: () => [], save: (s) => (saved = s) }
  });
  const sse = await response.text();
  assert.match(sse, /event: error\ndata: .*Claude 订阅这一轮出错/);
  assert.equal(saved, null);
});

await step("the box's transcript: its own entries untouched but chained, a message it never saw written in", async () => {
  const history = [
    { entries: [{ type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-10-28T10:00:00.000Z", sessionId: "old", cwd: "/old", message: { role: "user", content: [text("一")] } },
      { type: "attachment", uuid: "a1", parentUuid: "u1", attachment: { type: "date" } }, { type: "last-prompt", lastPrompt: "一" }] },
    { role: "assistant", content: [text("二")] },
    { role: "user", content: [text("三")] }
  ];
  const entries = box.transcript(history, { sessionId: "s", model: "claude-opus-5-5", cwd: "/home/box/chat", now: Date.parse("2026-10-28T12:00:00Z") });
  assert.deepEqual(entries.map((e) => e.type), ["user", "attachment", "assistant", "user"], "bookkeeping lines left out");
  assert.equal(entries[0].parentUuid, null);
  for (let i = 1; i < entries.length; i += 1) assert.equal(entries[i].parentUuid, entries[i - 1].uuid);
  assert.ok(entries.every((e) => e.sessionId === "s" && e.cwd === "/home/box/chat"));
  assert.deepEqual(entries[0].message, history[0].entries[0].message, "its own entry says what it said");
  assert.equal(history[0].entries[0].sessionId, "old", "the entries sent are not changed");
  assert.equal(entries[2].message.role, "assistant");
  assert.equal(entries[2].message.model, "claude-opus-5-5");
  assert.deepEqual(entries[2].message.content, [text("二")]);
  assert.ok(Date.parse(entries[2].timestamp) >= Date.parse(entries[0].timestamp), "times in order");
  assert.notEqual(entries[2].message.id, entries[3].uuid);
});

await step("what a turn wrote: her turn with what Claude Code attached to it, then the reply", async () => {
  const appended = [
    { type: "queue-operation" },
    { type: "user", uuid: "u", message: {} },
    { type: "attachment", uuid: "a", attachment: { type: "date" } },
    { type: "assistant", uuid: "r1", message: {} },
    { type: "assistant", uuid: "r2", message: {} },
    { type: "last-prompt" },
    { type: "cost-state" }
  ];
  const { prompt, reply } = box.turnEntries(appended);
  assert.deepEqual(prompt.map((e) => e.uuid), ["u", "a"]);
  assert.deepEqual(reply.map((e) => e.uuid), ["r1", "r2"]);
});

await step("the reply as one stream, even if Claude Code makes a second request", async () => {
  const sent = [];
  const stream = box.replyStream((e) => sent.push(e));
  for (const e of [
    { type: "message_start", message: { id: "1" } },
    { type: "content_block_start", index: 0 }, { type: "content_block_stop", index: 0 },
    { type: "message_delta", usage: { output_tokens: 1 } }, { type: "message_stop" },
    { type: "message_start", message: { id: "2" } },
    { type: "content_block_start", index: 0 }, { type: "content_block_stop", index: 0 },
    { type: "message_delta", usage: { output_tokens: 5 }, delta: { stop_reason: "end_turn" } }, { type: "message_stop" }
  ]) stream.event(e);
  assert.equal(stream.end(), true);
  assert.deepEqual(sent.map((e) => `${e.type}${e.index ?? ""}`), ["message_start", "content_block_start0", "content_block_stop0", "content_block_start1", "content_block_stop1", "message_delta", "message_stop"]);
  assert.equal(sent.at(-2).usage.output_tokens, 5);
  assert.equal(box.replyStream(() => {}).end(), false, "nothing streamed");
});

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
