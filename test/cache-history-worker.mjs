// Real local Worker + mock services; no paid models. Run each phase against the SAME SQLite directory,
// stopping/restarting the Worker between `first` and `restart` (keep the mock server running).
// node test/cache-history-worker.mjs first|restart
import assert from "node:assert/strict";

const WORKER = "http://127.0.0.1:8787";
const MOCK = "http://127.0.0.1:9999";
const phase = process.argv[2] ?? "first";
const headers = { "x-web-key": "test-web-key", "content-type": "application/json" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function say(text) {
  const response = await fetch(`${WORKER}/web/say`, { method: "POST", headers, body: JSON.stringify({ text }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "completed");
}
async function lines() {
  const response = await fetch(`${WORKER}/web/messages`, { headers });
  assert.equal(response.status, 200);
  return (await response.json()).data;
}
async function view() {
  await say("检查历史视图");
  const latest = (await lines()).filter((line) => line.role === "assistant").at(-1)?.text;
  assert.match(latest, /^HISTORY_VIEW:/);
  return JSON.parse(latest.slice("HISTORY_VIEW:".length));
}
async function until(test) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { if (await test()) return; await sleep(200); }
  throw new Error("timed out waiting for photo or handoff");
}
async function step(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}:`, error); process.exitCode = 1; }
}

if (phase === "first") {
  await fetch(`${MOCK}/__reset`);
  await step("a complete notebook result and a >32 KiB photo enter the current window intact", async () => {
    for (let i = 0; i < 3; i++) await say(`交接信测试材料 ${i}：${"文".repeat(3850)}`);
    const update = {
      update_id: 60001,
      message: {
        message_id: 60001, date: Math.floor(Date.now() / 1000), caption: "看图",
        from: { id: 42, is_bot: false, username: "her_test", first_name: "Her" },
        chat: { id: 42, type: "private", username: "her_test" },
        photo: [{ file_id: "cache-large-photo", file_unique_id: "cache-photo", width: 800, height: 800, file_size: 41000 }]
      }
    };
    const response = await fetch(`${WORKER}/messengers/telegram/webhook`, {
      method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "test-secret" },
      body: JSON.stringify(update)
    });
    assert.equal(response.status, 200);
    await until(async () => (await lines()).some((line) => line.role === "assistant" && line.text.includes("看到 1 张图")));
    await say("看小本本");
    const result = await view();
    assert.equal(result.pictures, 1);
    assert.ok(result.results.some((entry) => entry.tool === "memory_notebook" && entry.chars > 500), JSON.stringify(result));
  });
  await step("crossing multiple SDK age boundaries never changes the already-sent prefix, tool result, or photo", async () => {
    for (let n = 0; n < 12; n++) {
      const result = await view();
      assert.equal(result.matchesPrevious, true, `turn ${n}: prefix changed`);
      assert.equal(result.pictures, 1, `turn ${n}: image aged out`);
      assert.ok(result.results.some((entry) => entry.tool === "memory_notebook" && entry.chars > 500), `turn ${n}: tool result aged out`);
    }
  });
} else if (phase === "restart") {
  await step("an actual Worker restart reuses the persisted view instead of recalculating a newer cutoff", async () => {
    const result = await view();
    assert.equal(result.pictures, 1);
    assert.ok(result.results.some((entry) => entry.tool === "memory_notebook" && entry.chars > 500), JSON.stringify(result));
    assert.equal((await view()).matchesPrevious, true);
  });
  await step("handoff still reads the same prefix, then opens a reduced view whose next turn stays stable", async () => {
    const response = await fetch(`${WORKER}/messengers/telegram/webhook`, {
      method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "test-secret" },
      body: JSON.stringify({ update_id: 60002, message: {
        message_id: 60002, date: Math.floor(Date.now() / 1000), text: "/handoff",
        from: { id: 42, is_bot: false, username: "her_test", first_name: "Her" },
        chat: { id: 42, type: "private", username: "her_test" }
      } })
    });
    assert.equal(response.status, 200);
    await until(async () => (await lines()).some((line) => line.kind === "letter"));
    const letter = (await lines()).find((line) => line.kind === "letter");
    assert.match(letter.text, /前文和上一轮一字不差/);
    const result = await view();
    assert.ok(result.results.every((entry) => entry.tool !== "memory_notebook" || entry.chars <= 500), JSON.stringify(result));
    assert.equal((await view()).matchesPrevious, true);
  });
} else throw new Error(`unknown phase ${phase}`);
