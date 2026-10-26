// The WeCom relay (relay/wecom/wecom-relay.py) against a fake WeCom: the key, what is passed on and what is not,
// and the media conversions when ffmpeg is here. Needs python3; the conversions are checked only where this
// machine's ffmpeg can do them.
//   node test/wecom-relay.mjs

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const RELAY = fileURLToPath(new URL("../relay/wecom/wecom-relay.py", import.meta.url));
const KEY = "k".repeat(40);

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}\n     ${error?.stack ?? error}`);
  }
}

if (spawnSync("python3", ["--version"]).status !== 0) {
  console.log("skip: no python3 here");
  process.exit(0);
}

// The fake WeCom: says back what reached it.
const seen = [];
const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  seen.push({ method: req.method, url: req.url, headers: req.headers, body });
  if (req.url.startsWith("/cgi-bin/media/get")) {
    res.writeHead(200, { "content-type": "audio/amr", "content-disposition": 'attachment; filename="v.amr"' });
    res.end(Buffer.from("#!AMR\n"));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ errcode: 0, errmsg: "ok", method: req.method, url: req.url, length: body.length }));
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

async function start(port, media) {
  const child = spawn("python3", ["-I", RELAY], {
    env: { ...process.env, WECOM_RELAY_KEY: KEY, WECOM_RELAY_PORT: String(port), WECOM_RELAY_MEDIA: media ? "1" : "0", WECOM_RELAY_UPSTREAM: upstreamUrl },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let log = "";
  child.stderr.on("data", (data) => (log += data));
  for (let i = 0; i < 50; i++) {
    if (log.includes("wecom-relay on")) return { child, log: () => log };
    if (child.exitCode !== null) throw new Error(`relay exited: ${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`relay did not start: ${log}`);
}

const base = 18700 + Math.floor(Math.random() * 500);
const plain = await start(base, false);
const at = (path) => `http://127.0.0.1:${base}${path}`;
const keyed = { "x-relay-key": KEY };

await check("refuses without the key, and with a wrong one", async () => {
  assert.equal((await fetch(at("/ping"))).status, 403);
  assert.equal((await fetch(at("/cgi-bin/gettoken"), { headers: { "x-relay-key": "nope" } })).status, 403);
  assert.equal(seen.length, 0);
});

await check("refuses a key that is only the start of the real one", async () => {
  assert.equal((await fetch(at("/ping"), { headers: { "x-relay-key": KEY.slice(0, 32) } })).status, 403);
});

await check("ping says what it can do", async () => {
  const res = await fetch(at("/ping"), { headers: keyed });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.media, { amr: false, mp3: false, gif: false, png: false });
});

await check("passes a GET on, query and all, without the key", async () => {
  const res = await fetch(at("/cgi-bin/gettoken?corpid=c&corpsecret=s"), { headers: keyed });
  const body = await res.json();
  assert.equal(body.url, "/cgi-bin/gettoken?corpid=c&corpsecret=s");
  const last = seen.at(-1);
  assert.equal(last.headers["x-relay-key"], undefined);
  assert.equal(last.headers["cf-connecting-ip"], undefined);
});

await check("passes a POST body on byte for byte, with its type", async () => {
  const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
  const res = await fetch(at("/cgi-bin/media/upload?access_token=t&type=voice"), {
    method: "POST",
    headers: { ...keyed, "content-type": "multipart/form-data; boundary=xyz", "cf-connecting-ip": "1.2.3.4" },
    body: bytes
  });
  assert.equal((await res.json()).length, bytes.length);
  const last = seen.at(-1);
  assert.equal(last.headers["content-type"], "multipart/form-data; boundary=xyz");
  assert.equal(last.headers["cf-connecting-ip"], undefined);
  assert.deepEqual(new Uint8Array(last.body), bytes);
});

await check("passes a file back with its type and name", async () => {
  const res = await fetch(at("/cgi-bin/media/get?access_token=t&media_id=m"), { headers: keyed });
  assert.equal(res.headers.get("content-type"), "audio/amr");
  assert.match(res.headers.get("content-disposition") ?? "", /v\.amr/);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "#!AMR\n");
});

await check("nothing outside /cgi-bin goes on", async () => {
  const before = seen.length;
  assert.equal((await fetch(at("/other"), { headers: keyed })).status, 404);
  assert.equal((await fetch(at("/cgi-bin/../x"), { headers: keyed })).status, 404);
  assert.equal(seen.length, before);
});

await check("media is off unless it is turned on", async () => {
  const res = await fetch(at("/media/mp3"), { method: "POST", headers: keyed, body: new Uint8Array([1, 2, 3]) });
  assert.equal(res.status, 501);
});

await check("the access token stays out of the log", async () => {
  assert.doesNotMatch(plain.log(), /access_token|corpsecret/);
  assert.match(plain.log(), /GET \/cgi-bin\/gettoken/);
});

plain.child.kill();

// One second of AMR-NB at 12.2 kbit/s: 50 frames of a header byte and 31 bytes of sound.
function amrSecond() {
  const frames = [Buffer.from("#!AMR\n")];
  for (let i = 0; i < 50; i++) frames.push(Buffer.from([0x3c, ...Array.from({ length: 31 }, (_, j) => (i * 31 + j) % 256)]));
  return Buffer.concat(frames);
}

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
if (!hasFfmpeg) {
  console.log("skip: no ffmpeg here, media conversions not checked");
} else {
  const port = base + 1;
  const media = await start(port, true);
  const mat = (path) => `http://127.0.0.1:${port}${path}`;
  const abilities = (await (await fetch(mat("/ping"), { headers: keyed })).json()).media;
  console.log(`     this ffmpeg converts to: ${Object.keys(abilities).filter((name) => abilities[name]).join(", ") || "nothing"}`);

  if (abilities.mp3) {
    await check("a voice message she sent (AMR) comes back as MP3", async () => {
      const res = await fetch(mat("/media/mp3"), { method: "POST", headers: keyed, body: amrSecond() });
      assert.equal(res.status, 200, await res.clone().text());
      assert.equal(res.headers.get("content-type"), "audio/mpeg");
      const out = Buffer.from(await res.arrayBuffer());
      assert.ok(out.length > 1000);
    });
  }

  if (abilities.amr) {
    await check("a voice message to send comes back as AMR", async () => {
      const mp3 = await (await fetch(mat("/media/mp3"), { method: "POST", headers: keyed, body: amrSecond() })).arrayBuffer();
      const res = await fetch(mat("/media/amr"), { method: "POST", headers: keyed, body: mp3 });
      assert.equal(res.status, 200, await res.clone().text());
      assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 6).toString(), "#!AMR\n");
    });
  } else {
    await check("no AMR encoder: says so instead of failing quietly", async () => {
      const res = await fetch(mat("/media/amr"), { method: "POST", headers: keyed, body: amrSecond() });
      assert.equal(res.status, 501);
    });
  }

  const webm = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=128x128:rate=10:duration=1", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-f", "webm", "pipe:1"], { maxBuffer: 10 * 1024 * 1024 });
  if (abilities.gif && webm.status === 0 && webm.stdout.length) {
    await check("a video sticker (WebM) comes back as a GIF", async () => {
      const res = await fetch(mat("/media/gif"), { method: "POST", headers: keyed, body: webm.stdout });
      assert.equal(res.status, 200, await res.clone().text());
      assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 3).toString(), "GIF");
    });
  }

  const webp = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=1:duration=1", "-frames:v", "1", "-c:v", "libwebp", "-f", "webp", "pipe:1"], { maxBuffer: 10 * 1024 * 1024 });
  if (abilities.png && webp.status === 0 && webp.stdout.length) {
    await check("a still sticker (WebP) comes back as a PNG", async () => {
      const res = await fetch(mat("/media/png"), { method: "POST", headers: keyed, body: webp.stdout });
      assert.equal(res.status, 200, await res.clone().text());
      assert.deepEqual([...Buffer.from(await res.arrayBuffer()).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    });
  }

  await check("something ffmpeg cannot read is an error, not a crash", async () => {
    const res = await fetch(mat("/media/mp3"), { method: "POST", headers: keyed, body: Buffer.from("not audio at all") });
    assert.equal(res.status, 422);
    assert.equal((await fetch(mat("/ping"), { headers: keyed })).status, 200);
  });

  media.child.kill();
}

upstream.close();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
