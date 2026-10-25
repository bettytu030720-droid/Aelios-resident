// Exercise real listModels + Node fetch against loopback-only HTTP servers.
// Node 22+: node test/via-aelios-redirects.mjs. No external services or models.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../src/via-aelios.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "error",
});
const { listModels } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`);

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("real listModels never follows 3xx, including same-origin paths that would receive the Bearer key", async (t) => {
  const redirects = [];
  const targets = [];
  const other = await listen(t, (req, res) => {
    targets.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
  });
  let status = 302;
  let location;
  const origin = await listen(t, (req, res) => {
    if (req.url !== "/synthetic%20identity/v1/models") {
      targets.push({ url: req.url, auth: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
      return;
    }
    redirects.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(status, location === undefined ? {} : { location });
    res.end("private-response-body synthetic-private-key");
  });
  const memory = { url: origin, key: "synthetic-private-key", identity: "synthetic identity", namespace: "default" };
  for (status of [300, 301, 302, 303, 304, 305, 306, 307, 308, 399]) {
    for (location of ["/capture?private-location", `${origin}/capture?private-location`, `${other}/capture?private-location`, undefined]) {
      const before = redirects.length;
      await assert.rejects(listModels(memory), (error) => {
        assert.equal(error.message, `Aelios answered ${status}`, "only safe status, not Location, key or response body");
        return true;
      });
      assert.equal(redirects.length, before + 1, "exactly one request per call");
      assert.equal(redirects.at(-1).auth, "Bearer synthetic-private-key", "initial authenticated endpoint was actually requested");
      assert.deepEqual(targets, [], `no redirect target requested for ${status} ${location}`);
    }
  }
});

test("real listModels still reads curated/upstream 2xx and rejects non-redirect HTTP failures", async (t) => {
  let status = 200;
  let curated = true;
  const origin = await listen(t, (req, res) => {
    assert.equal(req.url, "/v1/models");
    assert.equal(req.headers.authorization, "Bearer synthetic-private-key");
    res.writeHead(status, { "content-type": "application/json", ...(curated ? { "x-aelios-models": "list" } : {}) });
    res.end(JSON.stringify({ data: [{ id: "synthetic/model", owned_by: "synthetic", aelios: { main: true } }] }));
  });
  const memory = { url: origin, key: "synthetic-private-key", identity: "", namespace: "default" };
  const models = [{ id: "synthetic/model", owner: "synthetic", main: true }];
  assert.deepEqual(await listModels(memory), { models, curated: true });
  curated = false;
  assert.deepEqual(await listModels(memory), { models, curated: false });
  for (status of [401, 403, 500]) await assert.rejects(listModels(memory), { message: `Aelios answered ${status}` });
});

test("listModels passes manual redirect mode and the caller's abort signal to fetch", async (t) => {
  const controller = new AbortController();
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, "manual");
    assert.equal(init.signal, controller.signal);
    return new Response("private response body", { status: 302, headers: { location: "https://never-requested.invalid/private" } });
  });
  await assert.rejects(listModels({ url: "https://synthetic.invalid", key: "synthetic-private-key", identity: "", namespace: "default" }, controller.signal), { message: "Aelios answered 302" });
  assert.equal(calls.length, 1);
});

test("every request that carries the Aelios key refuses 3xx: memory, boot, ingest, pin and the model proxy", async (t) => {
  const aelios = await build({
    entryPoints: [fileURLToPath(new URL("../src/aelios.ts", import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false, logLevel: "error",
  });
  const { recall, ingest, fetchBoot, pin } = await import(`data:text/javascript;base64,${Buffer.from(aelios.outputFiles[0].contents).toString("base64")}`);
  const { aeliosModel } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`);
  const targets = [];
  const other = await listen(t, (req, res) => {
    targets.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const asked = [];
  const origin = await listen(t, (req, res) => {
    asked.push(req.url);
    res.writeHead(307, { location: `${other}/capture` }).end();
  });
  const memory = { url: origin, key: "synthetic-private-key", identity: "", namespace: "default" };
  t.mock.method(console, "error", () => {});
  await assert.rejects(recall(memory, "q", 3));
  assert.equal(await ingest(memory, [{ role: "user", content: "hi" }], "test"), false);
  assert.equal(await fetchBoot(memory), null);
  assert.equal(await pin(memory, "line"), false);
  const prompt = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
  for (const id of ["openai/gpt-synthetic", "anthropic/claude-synthetic"]) {
    await assert.rejects(aeliosModel(memory, id).doGenerate({ prompt }));
  }
  assert.equal(asked.length, 6, "each call reached Aelios once");
  assert.deepEqual(targets, [], "no redirect target was requested with or without the key");
});
