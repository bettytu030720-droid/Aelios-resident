// Transport and safe status text, without a Worker or network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

async function load(path) {
  const result = await build({ entryPoints: [path], bundle: true, platform: "node", format: "esm", write: false, logLevel: "error" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
}
const { deliverLetter } = await load("src/letter-delivery.ts");
const { letterWriteStatus, letterDeliveryStatus } = await load("src/letter-status.ts");
const config = { url: "https://memory.example", namespace: "default", key: "PRIVATE_KEY", identity: "resident" };
const row = { id: "letter-stable", text: "PRIVATE_LETTER", url: config.url, namespace: config.namespace };
const receipt = () => Response.json({ data: { conversation_id: "default:aelios-resident", message_ids: ["saved-message"] } });

test("a receipt, not just a 2xx status, confirms one letter's delivery", async () => {
  let called = 0;
  const result = await deliverLetter(config, row, async (url, init) => {
    called++;
    assert.equal(url, `${config.url}/v1/memory/ingest`);
    assert.equal(init.headers.authorization, `Bearer ${config.key}`);
    assert.equal(init.headers["x-resident-letter-id"], row.id);
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(init.body), {
      namespace: "default", conversation_id: "default:aelios-resident", source: "aelios-resident:letter",
      messages: [{ role: "assistant", content: `（交接信）${row.text}` }]
    });
    return receipt();
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(called, 1);
});

test("retries reuse the exact id and payload, but may use a rotated current key", async () => {
  const calls = [];
  const send = async (url, init) => (calls.push(init), receipt());
  await deliverLetter(config, row, send);
  await deliverLetter({ ...config, key: "NEW_KEY" }, row, send);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].headers["x-resident-letter-id"], calls[1].headers["x-resident-letter-id"]);
  assert.equal(calls[1].headers.authorization, "Bearer NEW_KEY");
});

test("old letters never go to a different URL or namespace", async () => {
  let called = false;
  const send = async () => (called = true, receipt());
  for (const changed of [{ ...config, url: "https://other.example" }, { ...config, namespace: "other" }]) {
    assert.equal((await deliverLetter(changed, row, send)).ok, false);
  }
  assert.equal(called, false);
});

test("an HTTP error never exposes the upstream response body", async () => {
  const result = await deliverLetter(config, row, async () => new Response("PRIVATE_UPSTREAM_DETAIL", { status: 503 }));
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 503/);
  assert.doesNotMatch(result.error, /PRIVATE/);
});

test("empty, malformed or unconfirmed success responses remain unconfirmed", async () => {
  for (const response of [
    new Response(null, { status: 204 }), Response.json({}, { status: 202 }), Response.json({ data: { message_ids: [] } }),
    Response.json({ data: { message_ids: [""] } }), Response.json({ data: { message_ids: [1] } }),
    new Response("PRIVATE_INVALID_JSON")
  ]) {
    const result = await deliverLetter(config, row, async () => response);
    assert.equal(result.ok, false);
    assert.match(result.error, /未确认/);
    assert.doesNotMatch(result.error, /PRIVATE/);
  }
});

test("network failures and aborts use safe text and disclose duplicate risk", async () => {
  const result = await deliverLetter(config, row, async () => { throw new Error(`${config.key} ${row.text}`); });
  assert.equal(result.ok, false);
  assert.match(result.error, /重试可能产生重复/);
  assert.doesNotMatch(result.error, /PRIVATE/);
  const signal = AbortSignal.abort();
  const aborted = await deliverLetter(config, row, async (_url, init) => { init.signal.throwIfAborted(); return receipt(); }, signal);
  assert.equal(aborted.ok, false);
});

test("write failure, no older chat and pending recovery are distinct user-facing states", () => {
  assert.match(letterWriteStatus({ state: "empty", at: 1 }), /没有.*旧聊天/);
  assert.match(letterWriteStatus({ state: "failed", at: 2, error: "模型失败" }), /写信失败/);
  assert.match(letterWriteStatus({ state: "recovering", at: 3 }), /恢复/);
  assert.match(letterWriteStatus({ state: "writing", at: 4 }), /正在写/);
  assert.match(letterWriteStatus({ state: "written", at: 5 }), /已写好/);
  assert.match(letterWriteStatus(null), /还没/);
});

test("delivery status keeps local success separate from pending remote delivery", () => {
  assert.match(letterDeliveryStatus({ pending: 1, failed: 0, blocked: 0, latest: { status: "pending", lastError: "HTTP 503" } }), /待送达.*HTTP 503/);
  assert.match(letterDeliveryStatus({ pending: 0, failed: 1, blocked: 0, latest: null }), /次数用尽/);
  assert.match(letterDeliveryStatus({ pending: 0, failed: 0, blocked: 1, latest: null }), /配置改变/);
  assert.match(letterDeliveryStatus({ pending: 0, failed: 0, blocked: 0, latest: { status: "sent", lastError: null } }), /已送达/);
});
