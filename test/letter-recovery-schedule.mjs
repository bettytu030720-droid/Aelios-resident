// Real agents@0.29 Scheduler + Lifecycle job queue on in-memory node:sqlite.
// Usage (Node 22+): node test/letter-recovery-schedule.mjs
// No Resident import, Worker, network, generated files, or real five-second wait.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const sdkPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.resolve("agents")), "utf8"));
assert.equal(sdkPackage.version, "0.29.0", "re-review the real SDK fixture before changing its version");

// Bundle the installed SDK unchanged. Lifecycle's cloudflare:workers import is
// side-effect-only in 0.29; Node has no such module. Remove only that runtime
// import, not Scheduler, Lifecycle, JobQueue, callback dispatch, or alarm policy.
const compiled = await build({
  stdin: {
    contents: 'export { Lifecycle } from "agents/lifecycle"; export { Scheduler } from "agents/schedules";',
    resolveDir: root,
    sourcefile: "letter-recovery-schedule-sdk.mjs",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "error",
  plugins: [{
    name: "node-durable-object-boundary",
    setup(build) {
      build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "cloudflare:workers", namespace: "node-boundary" }));
      build.onLoad({ filter: /.*/, namespace: "node-boundary" }, () => ({ contents: "export {};", loader: "js" }));
    },
  }],
});
const { Lifecycle, Scheduler } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`
);

// Extract only the awaited schedule expression in performResumeLetter's
// no-summary/retry branch, never another resumeLetter schedule (e.g. onStart).
// These regexes locate source; the regression assertions below execute it
// against real SDK storage/dispatch rather than comparing a source snapshot.
const source = await readFile(new URL("../src/resident.ts", import.meta.url), "utf8");
const methods = [...source.matchAll(/private\s+async\s+performResumeLetter\(\)\s*:\s*Promise<void>\s*\{([\s\S]*?)\n  \}/g)];
assert.equal(methods.length, 1, "locate exactly one performResumeLetter implementation");
const noSummary = methods[0][1].match(/if\s*\(!job\.summary\)\s*\{([\s\S]*?)\n\s*\}\s*else\s*\{/);
assert.ok(noSummary, "locate the no-summary branch before its timeout else");
const expressions = [...noSummary[1].matchAll(/await\s+this\.schedule\([\s\S]*?\);/g)];
assert.equal(expressions.length, 1, "extract exactly one no-summary schedule expression");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const actualRetry = new AsyncFunction("job", expressions[0][0]);
const legacyRetry = new AsyncFunction("job", 'await this.schedule(5, "resumeLetter", {}, { idempotent: true });');
const START = Date.UTC(2026, 0, 1);

/** Adapt only DO storage/context; the SDK creates and drives its own job table. */
async function fixture(t, retry) {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const kv = new Map(); // SDK schema-version metadata, not the job queue.
  let alarm = null;
  const storage = {
    get: async (key) => kv.get(key),
    put: async (key, value) => { kv.set(key, value); },
    delete: async (key) => kv.delete(key),
    getAlarm: async () => alarm,
    setAlarm: async (time) => { alarm = Number(time); },
    deleteAlarm: async () => { alarm = null; },
    sql: {
      exec(query, ...params) {
        const statement = db.prepare(query);
        const rows = statement.columns().length ? statement.all(...params) : [];
        const rowsWritten = statement.columns().length ? 0 : Number(statement.run(...params).changes);
        return Object.assign(rows, { toArray: () => [...rows], rowsWritten });
      },
    },
  };
  const rows = () => db.prepare("SELECT * FROM cf_agents_jobs ORDER BY time, id").all();
  const job = { promptId: "unfinished-letter-prompt", createdAt: START - 30_000 };
  const calls = [];
  const requests = [];
  const host = {
    ctx: {
      id: { name: "letter-recovery-schedule-test" },
      storage,
      blockConcurrencyWhile: (fn) => fn(),
    },
    // Agent.schedule in agents@0.29 delegates directly to scheduler.set with
    // these four arguments. Record inputs/results, but do not fake scheduling.
    async schedule(...args) {
      const result = await scheduler.set(...args);
      requests.push({ args, result });
      return result;
    },
  };
  const scheduler = new Scheduler({
    callbacks: {
      async resumeLetter(payload, schedule) {
        const call = { at: Date.now(), payload, schedule, before: rows() };
        calls.push(call);
        // Only the expression runs: job is deliberately missing its summary
        // and is still within the ten-minute recovery window in every cycle.
        await retry.call(host, job);
        call.after = rows();
      },
    },
  });
  const lifecycle = new Lifecycle(host);
  lifecycle.use(scheduler);
  t.after(() => lifecycle.dispose());
  await lifecycle.start(); // Real capability binding, schema migration, startup.
  // Same one-second empty-payload wake as Resident.onStart. It is NOT the
  // expression under test; retry executes only while this job is running.
  const initial = await host.schedule(1, "resumeLetter", {}, { idempotent: true });
  return { calls, requests, rows, job, initial, scheduler, lifecycle, storage };
}

test("legacy {} retry deduplicates onto the running one-shot and recovery stops after one call", async (t) => {
  const f = await fixture(t, legacyRetry);
  assert.equal(await f.storage.getAlarm(), START + 1_000);
  t.mock.timers.tick(1_000);
  await f.lifecycle.alarm();

  assert.equal(f.calls.length, 1);
  const [call] = f.calls;
  assert.equal(call.before.length, 1);
  assert.equal(call.before[0].id, f.initial.id);
  assert.equal(call.before[0].running, 1, "Lifecycle marks the job running before the real callback");
  assert.equal(f.requests.length, 2, "one startup schedule plus the callback's attempted retry");
  assert.deepEqual(f.requests[1].args, [5, "resumeLetter", {}, { idempotent: true }]);
  assert.equal(f.requests[1].result.id, f.initial.id, "SDK dedup ignores the changed delay and returns the running job");
  assert.equal(call.after.length, 1, "no successor was inserted during the callback");
  assert.equal(call.after[0].running, 1, "dedup did not clear the original dispatch marker");
  assert.deepEqual(f.rows(), [], "real Lifecycle completion deleted the sole one-shot");
  assert.deepEqual(await f.scheduler.list(), []);
  assert.equal(await f.storage.getAlarm(), null, "there is no durable next wake");

  t.mock.timers.tick(60_000);
  await f.lifecycle.alarm();
  assert.equal(f.calls.length, 1, "even another alarm cannot resume a job that was lost");
  assert.equal(await f.storage.getAlarm(), null);
});

test("actual no-summary source expression resumes repeatedly and preserves the next job AND alarm", async (t) => {
  const f = await fixture(t, actualRetry);
  let previous = f.initial;
  const seenIds = new Set([previous.id]);

  // Three consecutive real callback executions, not duplicate direct calls to
  // retry. Each next wake must come from the preceding running callback.
  for (let cycle = 0; cycle < 3; cycle++) {
    const wake = await f.storage.getAlarm();
    assert.equal(wake, previous.time * 1_000);
    assert.ok(wake > Date.now());
    t.mock.timers.tick(wake - Date.now());
    assert.equal(f.job.summary, undefined);
    assert.ok(Date.now() - f.job.createdAt < 10 * 60_000);
    await f.lifecycle.alarm();

    assert.equal(f.calls.length, cycle + 1, "exactly one real resumeLetter invocation per wake");
    const call = f.calls[cycle];
    assert.equal(call.schedule.id, previous.id);
    assert.deepEqual(call.payload, previous.payload, "Scheduler delivers the preceding wake's persisted payload");
    assert.equal(call.before.length, 1);
    assert.equal(call.before[0].id, previous.id);
    assert.equal(call.before[0].running, 1);
    assert.equal(f.requests.length, cycle + 2);
    const request = f.requests.at(-1);
    const payload = { promptId: f.job.promptId, after: call.at };
    assert.deepEqual(request.args, [5, "resumeLetter", payload, { idempotent: true }]);
    assert.ok(!seenIds.has(request.result.id), "retry must not deduplicate onto any earlier job");
    seenIds.add(request.result.id);
    assert.equal(call.after.length, 2, "running parent and pending successor coexist before completion");
    assert.equal(call.after.find((row) => row.id === previous.id)?.running, 1);
    assert.equal(call.after.find((row) => row.id === request.result.id)?.running, 0);

    const pending = f.rows();
    assert.equal(pending.length, 1, "completion removes the parent, not the successor");
    assert.equal(pending[0].id, request.result.id);
    assert.equal(pending[0].capability, "scheduler");
    assert.equal(pending[0].fn, "resumeLetter");
    assert.equal(pending[0].running, 0);
    assert.equal(pending[0].singleflight, 0, "this is a one-shot, not an interval replacement");
    assert.deepEqual(JSON.parse(pending[0].payload).payload, payload);
    assert.equal(pending[0].time, call.at + 5_000);
    assert.deepEqual(await f.scheduler.list(), [request.result]);
    assert.equal(await f.storage.getAlarm(), pending[0].time, "Lifecycle leaves the physical alarm armed for the successor");
    previous = request.result;
  }
  assert.equal(f.calls.length, 3);
  assert.equal(seenIds.size, 4, "initial wake plus three independently persisted successors");
  assert.equal(f.rows().length, 1, "a fourth recovery wake remains after the third callback");
});
