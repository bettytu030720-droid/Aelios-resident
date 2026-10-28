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
    body: JSON.stringify({
      model: "claude-opus-5-5",
      stream: true,
      system: [text("人设"), text("规矩")],
      messages,
      tools: [
        { name: "memory_recall", description: "Search.", input_schema: { type: "object", properties: {} }, cache_control: { type: "ephemeral" } },
        { type: "web_search_20250305", name: "web_search" }
      ]
    })
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const sse = await response.text();
  assert.match(sse, /^event: message_start\ndata: /);
  assert.equal((sse.match(/^event: /gm) ?? []).length, events.length);
  assert.equal(sent.token, "sk-ant-oat01-x");
  assert.equal(sent.model, "claude-opus-5-5");
  assert.equal(sent.system, "人设\n\n规矩");
  assert.deepEqual(sent.tools, [{ name: "memory_recall", description: "Search.", input_schema: { type: "object", properties: {} } }], "her own tools, without cache marks or the provider's");
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
  assert.equal(sent.system, "");
  assert.deepEqual(sent.tools, []);
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
  response = await call({ token: "t", send: async () => Response.json({ error: code.NO_BOX }, { status: 501 }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.message, code.NO_BOX);
  response = await call({ token: "t", send: async () => Response.json({ error: "the box key does not match" }, { status: 401 }) });
  assert.equal(response.status, 400, "not worth trying again");
  assert.match((await response.json()).error.message, /不认这把钥匙/);
  response = await call({ token: "t", send: async () => new Response("Bad gateway", { status: 502 }) });
  assert.equal(response.status, 503, "a box restarting can be tried again");
  assert.match((await response.json()).error.message, /Claude 盒子没接这一轮（502）/);
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

await step("a failed turn ends with its error alone: no message_stop says the reply finished", async () => {
  const sent = [];
  const stream = box.replyStream((e) => sent.push(e));
  stream.event({ type: "message_start", message: { id: "1" } });
  stream.event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  stream.event({ type: "message_delta", usage: { output_tokens: 1 } });
  assert.deepEqual(box.lastLine(stream, "API Error: 529 overloaded", []), { error: "API Error: 529 overloaded" });
  assert.deepEqual(sent.map((e) => e.type), ["message_start", "content_block_start"], "the reply left open");
  assert.deepEqual(box.lastLine(box.replyStream(() => {}), null, []), { error: "Claude Code answered nothing" });
  const done = box.lastLine(stream, null, [{ type: "user", uuid: "u", message: { role: "user", content: "hi" } }, { type: "assistant", uuid: "a" }]);
  assert.deepEqual(sent.slice(-2).map((e) => e.type), ["message_delta", "message_stop"], "a turn that answered closes the reply first");
  assert.deepEqual(done.done.reply.map((e) => e.uuid), ["a"]);
});

await step("her turn as the box gets it: results as tool_result blocks, the rest as for a message it never saw", async () => {
  assert.deepEqual(code.promptBlocks([text("看", { cache_control: { type: "ephemeral" } })]), [text("看")]);
  assert.deepEqual(
    code.promptBlocks([
      { type: "tool_result", tool_use_id: "t1", content: "好了", cache_control: { type: "ephemeral" } },
      { type: "tool_result", tool_use_id: "t2", content: [text("坏了", { cache_control: { type: "ephemeral" } })], is_error: true }
    ]),
    [
      { type: "tool_result", tool_use_id: "t1", content: [text("好了")] },
      { type: "tool_result", tool_use_id: "t2", content: [text("坏了")], is_error: true }
    ]
  );
});

await step("a reply that calls tools comes together with its calls' input, from the pieces of JSON", async () => {
  const message = code.messageOf([
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "memory_notebook", input: {}, caller: { type: "direct" } } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"action":"app' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'end","name":"测试"}' } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t2", name: "list_alarms", input: {} } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } }
  ]);
  assert.deepEqual(message.content, [
    { type: "tool_use", id: "t1", name: "memory_notebook", input: { action: "append", name: "测试" }, caller: { type: "direct" } },
    { type: "tool_use", id: "t2", name: "list_alarms", input: {} }
  ]);
  assert.equal(message.stop_reason, "tool_use");
});

await step("a tool round through boxFetch: the reply stops at the call, the result goes back, her turn is recorded once", async () => {
  const her = user(text("[10-28 21:00] 记一下小本本"));
  const calling = [
    { type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [], usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "我记一下。" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "memory_notebook", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"action":"append","name":"测试","content":"第 30 章"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" }
  ];
  const answering = [
    { type: "message_start", message: { id: "m2", type: "message", role: "assistant", content: [], usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "记好了。" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" }
  ];
  let held = [];
  const sent = [];
  const recalled = [];
  const recorded = [];
  let answer = calling;
  const turn = {
    token: "t",
    async send(body) {
      sent.push(JSON.parse(body));
      const done = { prompt: [{ type: "user", uuid: `p${sent.length}` }], reply: [{ type: "assistant", uuid: `r${sent.length}` }] };
      return new Response([...answer.map((e) => ({ e })), { done }].map((l) => `${JSON.stringify(l)}\n`).join(""));
    },
    segments: { load: () => held, save: (segments) => (held = segments) },
    recall: async (said) => (recalled.push(said), ""),
    record: (said, reply) => recorded.push([said, reply])
  };
  const call = async (messages) => (await code.boxFetch(turn)("u", { body: JSON.stringify({ model: "claude-opus-5-5", stream: true, messages }) })).text();
  await call([her]);
  assert.deepEqual(recorded, [], "not recorded while the reply waits on its call");
  assert.equal(held.length, 2);
  // Think sends the call back as the AI SDK writes it: its input as an object, and the thinking left as it was.
  const asked = assistant({ type: "thinking", thinking: "", signature: "s" }, text("我记一下。"), { type: "tool_use", id: "toolu_1", name: "memory_notebook", input: { action: "append", name: "测试", content: "第 30 章" } });
  assert.equal(held[1].fp, await code.fingerprint("assistant", asked.content), "the reply is kept by what it says and calls");
  answer = answering;
  const result = user({ type: "tool_result", tool_use_id: "toolu_1", content: '{"ok":true}' });
  await call([her, asked, result]);
  assert.deepEqual(sent[1].history, [{ entries: [{ type: "user", uuid: "p1" }] }, { entries: [{ type: "assistant", uuid: "r1" }] }]);
  assert.deepEqual(sent[1].prompt, [{ type: "tool_result", tool_use_id: "toolu_1", content: [text('{"ok":true}')] }]);
  assert.deepEqual(recalled, ["[10-28 21:00] 记一下小本本"], "recalled once, when her turn began");
  assert.deepEqual(recorded, [["[10-28 21:00] 记一下小本本", "我记一下。记好了。"]]);
  assert.equal(held.length, 4);
  assert.equal(held[2].fp, await code.fingerprint("user", result.content));
  assert.deepEqual(held[3].entries, [{ type: "assistant", uuid: "r2" }]);
});

await step("in the box: a call no turn can answer any more, and its result, are told as text", async () => {
  const entries = [
    { type: "user", uuid: "u1", message: { role: "user", content: [text("记一下")] } },
    { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__resident__memory_notebook", input: { action: "list" } }] } },
    { type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [text("[]")] }] } },
    { type: "assistant", uuid: "a2", message: { role: "assistant", content: [text("好"), { type: "tool_use", id: "t2", name: "mcp__resident__set_alarm", input: { at: "8:00" } }] } }
  ];
  const { entries: settled, prompt } = box.settle(entries, [{ type: "tool_result", tool_use_id: "t2", content: "设好了", is_error: true }, text("对了")]);
  assert.deepEqual(settled.slice(0, 3), entries.slice(0, 3), "an answered call stays a call");
  assert.deepEqual(settled[3].message.content, [text("好"), text('[用了工具 set_alarm：{"at":"8:00"}]')]);
  assert.equal(entries[3].message.content[1].type, "tool_use", "the entries sent are not changed");
  assert.deepEqual(prompt, [text("[工具的结果（出错）]\n设好了"), text("对了")]);
});

await step("in the box: the resident's result as the MCP server answers the waiting call", async () => {
  assert.deepEqual(box.callResult({ type: "tool_result", tool_use_id: "t", content: "好" }), { content: [text("好")] });
  assert.deepEqual(box.callResult({ type: "tool_result", tool_use_id: "t", content: [text("坏")], is_error: true }), { content: [text("坏")], isError: true });
  assert.deepEqual(box.callResult({ type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } }] }), {
    content: [{ type: "image", data: "AA", mimeType: "image/png" }]
  });
  assert.deepEqual(box.callResult({ type: "tool_result", tool_use_id: "t" }), { content: [text("")] });
});

await step("in the box: the resident's tools listed under their own names, and its calls in the reply under them too", async () => {
  assert.deepEqual(
    box.toolsFor([
      { name: "memory_recall", description: "Search.", input_schema: { type: "object", properties: { query: { type: "string" } } } },
      { name: "memory_recall" },
      { name: "has space" },
      { name: "x".repeat(60) },
      { name: "list_alarms" }
    ]),
    [
      { name: "memory_recall", description: "Search.", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
      { name: "list_alarms", inputSchema: { type: "object", properties: {} } }
    ]
  );
  const sent = [];
  const stream = box.replyStream((e) => sent.push(e));
  stream.event({ type: "message_start", message: { id: "1" } });
  stream.event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "mcp__resident__memory_recall", input: {} } });
  stream.event({ type: "message_delta", delta: { stop_reason: "tool_use" } });
  assert.equal(sent[1].content_block.name, "memory_recall");
  assert.deepEqual(stream.uses, [{ id: "t1", name: "memory_recall" }]);
  assert.equal(stream.calls, true);
});

/** A box answer that sends these lines and then stays open until it is cancelled; `cancelled` says whether it was. */
function openAnswer(...l) {
  const state = { cancelled: false };
  const body = new ReadableStream({
    start(controller) {
      for (const x of l) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(x)}\n`));
    },
    cancel() {
      state.cancelled = true;
    }
  });
  return { state, response: new Response(body, { headers: { "content-type": "application/x-ndjson" } }) };
}
const started = { e: { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], usage: { input_tokens: 1 } } } };
const said = [{ e: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }, { e: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "一半" } } }];
const ask = (stream) => ({ body: JSON.stringify({ model: "claude-opus-5-5", stream, messages: [user(text("[10-28 21:00] 在吗"))] }) });

await step("an answer that stops before the box says it is done is a cut-off turn, not a reply, and nothing is kept", async () => {
  const lines = (...l) => new Response(l.map((x) => `${JSON.stringify(x)}\n`).join(""));
  let saved = null;
  const recorded = [];
  const turn = { token: "t", send: async () => lines(started, ...said), segments: { load: () => [], save: (x) => (saved = x) }, record: (...a) => recorded.push(a) };
  let response = await code.boxFetch(turn)("u", ask(false));
  assert.equal(response.status, 503, "worth trying again");
  assert.match((await response.json()).error.message, /半路断了/);
  response = await code.boxFetch(turn)("u", ask(true));
  const sse = await response.text();
  assert.match(sse, /一半/, "what streamed is passed on");
  assert.match(sse, /event: error\ndata: .*半路断了[^\n]*\n\n$/, "and the stream ends with an error");
  assert.doesNotMatch(sse, /message_stop/);
  assert.equal(saved, null);
  assert.deepEqual(recorded, []);
});

await step("aborted, or no longer read, the call cancels the box's answer, so the box stops the turn", async () => {
  // Streaming, aborted halfway: the box's answer is cancelled and the stream ends.
  let open = openAnswer(started, ...said);
  let controller = new AbortController();
  let response = await code.boxFetch({ token: "t", send: async () => open.response })("u", { ...ask(true), signal: controller.signal });
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /message_start/);
  controller.abort();
  for (let r = await reader.read(); !r.done; r = await reader.read()) assert.doesNotMatch(new TextDecoder().decode(r.value), /半路断了/, "no error for a call nobody waits on");
  assert.equal(open.state.cancelled, true);
  // Streaming, and the reader stops reading.
  open = openAnswer(started, ...said);
  response = await code.boxFetch({ token: "t", send: async () => open.response })("u", ask(true));
  const second = response.body.getReader();
  await second.read();
  await second.cancel();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(open.state.cancelled, true);
  // A call that does not stream fails as fetch does, and cancels the box's answer too.
  open = openAnswer(started, ...said);
  controller = new AbortController();
  const pending = code.boxFetch({ token: "t", send: async () => open.response })("u", { ...ask(false), signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(open.state.cancelled, true);
  // Aborted before the box said anything.
  open = openAnswer();
  controller = new AbortController();
  const early = code.boxFetch({ token: "t", send: async () => open.response })("u", { ...ask(true), signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(early, (error) => error.name === "AbortError");
  assert.equal(open.state.cancelled, true);
});

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
