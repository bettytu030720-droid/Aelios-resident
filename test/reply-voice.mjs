import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const { outputFiles: [bundle] } = await build({
  entryPoints: ["src/web/reply-voice.ts"], bundle: true, platform: "node", format: "esm", write: false
});
const { ReplyVoice } = await import("data:text/javascript;base64," + Buffer.from(bundle.contents).toString("base64"));

function fixture() {
  const calls = [];
  const kept = [];
  const removed = [];
  const tasks = [];
  const job = new ReplyVoice({
    maxBytes: 100,
    speak: (text, { signal }) => new Promise((resolve, reject) => {
      calls.push({ text, signal, reject, resolve: (n) => resolve({ audio: Uint8Array.of(0x49, 0x44, 0x33, n), seconds: n }) });
    }),
    keep: ({ audio }) => {
      const key = String(audio[3]);
      kept.push(key);
      return key;
    },
    release: (key) => removed.push(key),
    changed: () => {},
    waitUntil: (task) => tasks.push(task)
  });
  return { job, calls, kept, removed, tasks };
}

const first = "这段是第一句话，先从这里慢慢读给你听。";
const second = "这一段还要等一会儿才接着念出来，语音任务可以同时合成，浏览器会记住它原本的位置，所以总会在前一段播完以后才播放这一段。";
const third = "然后才是末尾。";

test("first audio can arrive before the model finishes, out-of-order clips stay behind the first one", async () => {
  const { job, calls, tasks } = fixture();
  job.push(first);
  assert.equal(calls[0].text, first);
  job.push(second + third);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].text, second);

  calls[1].resolve(2);
  await tasks[1];
  assert.equal(job.live(), null);
  calls[0].resolve(1);
  await tasks[0];
  assert.deepEqual(job.live(), { key: "1", parts: ["1", "2"], seconds: 3, live: true });

  const done = job.finish(first + second + third);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].text, third);
  calls[2].resolve(3);
  assert.deepEqual(await done, [
    { key: "1", seconds: 1 }, { key: "2", seconds: 2 }, { key: "3", seconds: 3 }
  ]);
});

test("a long reply keeps its live clips and fills only the remaining character budget", async () => {
  const { job, calls, removed, tasks } = fixture();
  job.push(first);
  calls[0].resolve(1);
  await tasks[0];
  const overflow = "这".repeat(2100) + "。";
  job.push(overflow);
  assert.equal(calls[1].text.length + first.length, 2000);
  assert.deepEqual(job.live(), { key: "1", seconds: 1, live: true });

  job.push(third);
  const done = job.finish(first + overflow + third);
  calls[1].resolve(2);
  assert.deepEqual(await done, [{ key: "1", seconds: 1 }, { key: "2", seconds: 2 }]);
  assert.deepEqual(removed, []);
  assert.equal(calls.length, 2);
});

test("an oversized unsegmented tail still leaves a playable prefix when the reply finishes", async () => {
  const { job, calls, removed } = fixture();
  job.push(first);
  const tail = "字".repeat(9000);
  job.push(tail);
  const done = job.finish(first + tail);
  assert.equal(calls[1].text.length, 2000 - first.length);
  calls[0].resolve(1);
  calls[1].resolve(2);
  assert.equal((await done).length, 2);
  assert.deepEqual(removed, []);
});

test("stopping releases ready audio, aborts requests and ignores late results", async () => {
  const { job, calls, kept, removed, tasks } = fixture();
  job.push(first + second);
  calls[0].resolve(1);
  await tasks[0];
  job.cancel();
  assert.ok(calls[1].signal.aborted);
  assert.equal(job.live(), null);
  assert.deepEqual(removed, ["1"]);
  calls[1].resolve(2);
  await tasks[1];
  assert.deepEqual(kept, ["1"]);
  assert.equal(await job.finish(first + second), null);
});

test("a failed clip stops later audio and reports the error when the reply finishes", async () => {
  const { job, calls, removed, tasks } = fixture();
  job.push(first + second);
  calls[0].resolve(1);
  await tasks[0];
  calls[1].reject(new Error("provider busy"));
  await tasks[1];
  assert.equal(job.live(), null);
  assert.deepEqual(removed, ["1"]);
  await assert.rejects(job.finish(first + second), /provider busy/);
});
