// Unit tests for Web Push sent by the Worker (src/web-push.ts): the RFC 8291 example byte for byte, a round trip
// through a decryptor written here with node:crypto, the VAPID header, checking a subscription, and sending one.
// Usage: node test/web-push.mjs
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-web-push-"));
const out = join(dir, "web-push.mjs");
await build({ entryPoints: ["src/web-push.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const { PUSH_PAYLOAD_MAX, makePushKeys, pushTargetOf, encryptPush, vapidAuthorization, sendPush } = await import(pathToFileURL(join(process.cwd(), out)).href);
rmSync(dir, { recursive: true, force: true });

let failed = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error.stack ?? error}`);
  }
}

const b64 = (text) => Buffer.from(text.replace(/\s+/g, ""), "base64url");
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const ENDPOINT = "https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV";
const SUBJECT = "mailto:resident@example.com";

/** A browser: its ECDH key pair and auth secret, and the subscription it would hand over. */
function browser(endpoint = ENDPOINT) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, target: { endpoint, keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) } } };
}

/** The browser's side of RFC 8291, written apart from src/web-push.ts with node:crypto. */
function decrypt(body, ecdh, auth) {
  body = Buffer.from(body);
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  assert.equal(rs, 4096, "record size");
  assert.equal(idlen, 65, "key id is the server's public key");
  assert.ok(record.length <= rs, "one record");
  const uaPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(-16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, -16)), decipher.final()]);
  // Padding is zeros after the delimiter; the last record's delimiter is 0x02.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  assert.equal(padded[end], 0x02, "padding delimiter");
  return padded.subarray(0, end);
}

// RFC 8291 §5 and Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: b64("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"),
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"),
  salt: b64("DGv6ra1nlYgDCS1FRnbzlw"),
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  header: b64("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8"),
  ciphertext: b64("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ"),
  body: b64(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
    mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
    pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`)
};

await step("RFC 8291 Appendix A: the example body, byte for byte", async () => {
  assert.deepEqual(Buffer.concat([RFC.header, RFC.ciphertext]), RFC.body, "the RFC's header and ciphertext make its body");
  const serverPrivateKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: b64url(RFC.asPublic.subarray(1, 33)), y: b64url(RFC.asPublic.subarray(33)), d: RFC.asPrivate },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
  const target = { endpoint: ENDPOINT, keys: { p256dh: RFC.uaPublic, auth: RFC.auth } };
  const body = await encryptPush(target, new TextEncoder().encode(RFC.plaintext), { salt: RFC.salt, serverPrivateKey, serverPublicKey: RFC.asPublic });
  assert.ok(body instanceof Uint8Array);
  assert.equal(body.length, 144);
  assert.deepEqual(Buffer.from(body), RFC.body);
});

await step("the decryptor written here reads the RFC's body with the RFC's user agent key", () => {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(RFC.uaPrivate);
  assert.equal(b64url(ecdh.getPublicKey()), RFC.uaPublic);
  assert.equal(decrypt(RFC.body, ecdh, b64(RFC.auth)).toString(), RFC.plaintext);
});

await step("round trip: a new salt and server key each time, the browser gets the payload back", async () => {
  const { ecdh, auth, target } = browser();
  for (const text of ["", "hi", "你好，我在。", "x".repeat(PUSH_PAYLOAD_MAX)]) {
    const payload = new TextEncoder().encode(text);
    const body = await encryptPush(target, payload);
    assert.equal(body.length, 86 + payload.length + 1 + 16, `body for ${payload.length} bytes`);
    assert.ok(body.length <= 4096);
    assert.equal(decrypt(body, ecdh, auth).toString(), text);
  }
  assert.equal(PUSH_PAYLOAD_MAX, 3993);
  const one = Buffer.from(await encryptPush(target, new TextEncoder().encode("same")));
  const two = Buffer.from(await encryptPush(target, new TextEncoder().encode("same")));
  assert.notDeepEqual(one.subarray(0, 16), two.subarray(0, 16), "a new salt");
  assert.notDeepEqual(one.subarray(21, 86), two.subarray(21, 86), "a new server key");
  await assert.rejects(encryptPush(target, new Uint8Array(PUSH_PAYLOAD_MAX + 1)), RangeError);
  await assert.rejects(encryptPush({ endpoint: ENDPOINT, keys: { p256dh: "AAAA", auth: target.keys.auth } }, new Uint8Array(1)));
});

await step("VAPID: ES256 JWT for the endpoint's origin, 12 hours, the subject; it verifies with the public key", async () => {
  const keys = await makePushKeys();
  const point = b64(keys.publicKey);
  assert.equal(point.length, 65);
  assert.equal(point[0], 0x04);
  assert.equal(b64(keys.privateKey).length, 32, "the private key is the JWK d, 32 bytes");
  assert.doesNotMatch(keys.publicKey + keys.privateKey, /[=+/]/, "base64url without padding");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(b64(keys.privateKey));
  assert.deepEqual(ecdh.getPublicKey(), point, "the two halves belong together");

  const now = Date.parse("2026-10-27T08:00:00Z");
  const value = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc:def?x=1#y", keys, SUBJECT, now);
  const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(value);
  assert.ok(match, value);
  const [, header, claims, signature, k] = match;
  assert.equal(k, keys.publicKey);
  assert.deepEqual(JSON.parse(b64(header).toString()), { typ: "JWT", alg: "ES256" });
  const body = JSON.parse(b64(claims).toString());
  assert.deepEqual(body, { aud: "https://fcm.googleapis.com", exp: now / 1000 + 12 * 3600, sub: SUBJECT });
  assert.ok(body.exp - now / 1000 <= 24 * 3600);
  const raw = b64(signature);
  assert.equal(raw.length, 64, "r || s");
  const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33)) }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, raw), "signature verifies");
  assert.ok(!verify("sha256", Buffer.from(`${header}.${claims}x`), { key: publicKey, dsaEncoding: "ieee-p1363" }, raw), "and only for this token");

  const ported = JSON.parse(b64((await vapidAuthorization("https://push.example.net:8443/p/1", keys, "https://example.com/contact")).split(".")[1]).toString());
  assert.equal(ported.aud, "https://push.example.net:8443");
  assert.equal(ported.sub, "https://example.com/contact");
  const left = ported.exp - Date.now() / 1000;
  assert.ok(left > 12 * 3600 - 60 && left <= 12 * 3600, "exp from now when no time is given");
  for (const bad of ["", "resident@example.com", "http://example.com", "mailto:"]) {
    await assert.rejects(vapidAuthorization(ENDPOINT, keys, bad), /subject/, bad);
  }
});

await step("a subscription is checked: https, a real URL, no credentials, the right key lengths", () => {
  const { target } = browser();
  const good = { ...target, expirationTime: null };
  assert.deepEqual(pushTargetOf(good), target, "only endpoint and keys are kept");
  const padded = { endpoint: ENDPOINT, keys: { p256dh: `${target.keys.p256dh}=`, auth: `${target.keys.auth}==` } };
  assert.deepEqual(pushTargetOf(padded), target, "padding is accepted and dropped");
  assert.deepEqual(pushTargetOf({ ...target, endpoint: "https://web.push.apple.com/QGuQyavXutnMH" })?.endpoint, "https://web.push.apple.com/QGuQyavXutnMH");
  assert.ok(pushTargetOf({ ...target, endpoint: `https://push.example.net/${"a".repeat(999)}` }), "1024 characters is the most");

  const p = b64(target.keys.p256dh);
  const keys = (change) => ({ endpoint: ENDPOINT, keys: { ...target.keys, ...change } });
  const bad = {
    "http endpoint": { ...target, endpoint: "http://push.example.net/x" },
    "ftp endpoint": { ...target, endpoint: "ftp://push.example.net/x" },
    "not a URL": { ...target, endpoint: "push.example.net/x" },
    "empty endpoint": { ...target, endpoint: "" },
    "user and password": { ...target, endpoint: "https://user:pass@push.example.net/x" },
    "user only": { ...target, endpoint: "https://user@push.example.net/x" },
    "1025 characters": { ...target, endpoint: `https://push.example.net/${"a".repeat(1000)}` },
    "absurd length": { ...target, endpoint: `https://push.example.net/${"a".repeat(100_000)}` },
    "endpoint not a string": { ...target, endpoint: 42 },
    "no endpoint": { keys: target.keys },
    "no keys": { endpoint: ENDPOINT },
    "keys not an object": { endpoint: ENDPOINT, keys: "x" },
    "no auth": { endpoint: ENDPOINT, keys: { p256dh: target.keys.p256dh } },
    "no p256dh": { endpoint: ENDPOINT, keys: { auth: target.keys.auth } },
    "auth not a string": keys({ auth: 16 }),
    "bad base64": keys({ p256dh: "!!!!" + target.keys.p256dh.slice(4) }),
    "standard base64 alphabet": keys({ auth: "ab+/" + target.keys.auth.slice(4) }),
    "broken padding": keys({ auth: `${target.keys.auth}=` }),
    "p256dh 64 bytes": keys({ p256dh: b64url(p.subarray(0, 64)) }),
    "p256dh 66 bytes": keys({ p256dh: b64url(Buffer.concat([p, Buffer.of(1)])) }),
    "p256dh compressed": keys({ p256dh: b64url(Buffer.concat([Buffer.of(2), p.subarray(1, 33)])) }),
    "p256dh not starting 0x04": keys({ p256dh: b64url(Buffer.concat([Buffer.of(5), p.subarray(1)])) }),
    "auth 15 bytes": keys({ auth: b64url(randomBytes(15)) }),
    "auth 17 bytes": keys({ auth: b64url(randomBytes(17)) })
  };
  for (const [name, value] of Object.entries(bad)) assert.equal(pushTargetOf(value), null, name);
  for (const value of [null, undefined, "x", 42, [], {}]) assert.equal(pushTargetOf(value), null, JSON.stringify(value));
});

await step("sending: the request, then ok, gone, errors; nothing sent over the limit; keys never in an error", async () => {
  const keys = await makePushKeys();
  const { ecdh, auth, target } = browser();
  const calls = [];
  const answer = (status, text = "") => async (url, init) => {
    calls.push({ url, init });
    return new Response(text || null, { status });
  };

  assert.deepEqual(await sendPush(target, "她先说话了", keys, SUBJECT, { fetcher: answer(201) }), { ok: true });
  const [{ url, init }] = calls;
  assert.equal(url, ENDPOINT);
  assert.equal(init.method, "POST");
  assert.ok(init.signal instanceof AbortSignal, "a timeout");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("content-encoding"), "aes128gcm");
  assert.equal(headers.get("content-type"), "application/octet-stream");
  assert.equal(headers.get("ttl"), "86400");
  assert.equal(headers.get("urgency"), "normal");
  assert.equal(headers.get("topic"), null);
  assert.match(headers.get("authorization"), new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`));
  const payload = Buffer.from("她先说话了");
  assert.equal(init.body.length, 86 + payload.length + 1 + 16);
  assert.deepEqual(decrypt(init.body, ecdh, auth), payload);

  calls.length = 0;
  assert.deepEqual(await sendPush(target, "{}", keys, SUBJECT, { ttl: 60, urgency: "high", topic: "chat-1_A", fetcher: answer(200) }), { ok: true });
  const set = new Headers(calls[0].init.headers);
  assert.deepEqual([set.get("ttl"), set.get("urgency"), set.get("topic")], ["60", "high", "chat-1_A"]);

  assert.deepEqual(await sendPush(target, "x", keys, SUBJECT, { fetcher: answer(404) }), { gone: true });
  assert.deepEqual(await sendPush(target, "x", keys, SUBJECT, { fetcher: answer(410, "expired") }), { gone: true });
  const tooBig = await sendPush(target, "x", keys, SUBJECT, { fetcher: answer(413, "Payload Too Large") });
  assert.match(tooBig.error, /413: Payload Too Large/);
  const broken = await sendPush(target, "x", keys, SUBJECT, { fetcher: answer(500, "e".repeat(5000)) });
  assert.match(broken.error, /500/);
  assert.ok(broken.error.length < 300, "only the start of the body");
  assert.match((await sendPush(target, "x", keys, SUBJECT, { fetcher: answer(429) })).error, /429$/);
  const thrown = await sendPush(target, "x", keys, SUBJECT, {
    fetcher: async () => {
      throw new TypeError("network down");
    }
  });
  assert.match(thrown.error, /network down/);
  const timedOut = await sendPush(target, "x", keys, SUBJECT, {
    fetcher: async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
  });
  assert.match(timedOut.error, /timeout/);

  calls.length = 0;
  const longest = await sendPush(target, "你".repeat(1331), keys, SUBJECT, { fetcher: answer(201) });
  assert.deepEqual(longest, { ok: true }, "3993 bytes go");
  assert.ok(calls[0].init.body.length <= 4096);
  calls.length = 0;
  for (const text of ["x".repeat(4000), "你".repeat(1332)]) {
    const over = await sendPush(target, text, keys, SUBJECT, { fetcher: answer(201) });
    assert.match(over.error, /3993/);
  }
  assert.match((await sendPush(target, "x", keys, SUBJECT, { topic: "has space", fetcher: answer(201) })).error, /topic/);
  assert.match((await sendPush(target, "x", keys, SUBJECT, { topic: "a".repeat(33), fetcher: answer(201) })).error, /topic/);
  assert.match((await sendPush(target, "x", keys, SUBJECT, { ttl: -1, fetcher: answer(201) })).error, /TTL/);
  assert.match((await sendPush(target, "x", keys, SUBJECT, { urgency: "urgent", fetcher: answer(201) })).error, /urgency/);
  assert.match((await sendPush(target, "x", keys, "nobody", { fetcher: answer(201) })).error, /subject/);
  assert.equal(calls.length, 0, "none of those reached the push service");

  // A push service never sees the private key, but whatever ends up in an error, the key does not.
  const leaky = [
    await sendPush(target, "x", keys, SUBJECT, { fetcher: async (_, init) => new Response(`${new Headers(init.headers).get("authorization")} ${keys.privateKey}`, { status: 400 }) }),
    await sendPush(target, "x", keys, SUBJECT, {
      fetcher: async () => {
        throw new Error(`failed with ${keys.privateKey}`);
      }
    }),
    await sendPush(target, "x", { publicKey: keys.publicKey, privateKey: "not-a-key" }, SUBJECT, { fetcher: answer(201) })
  ];
  for (const result of [...leaky, tooBig, broken, thrown]) {
    assert.ok(result.error, JSON.stringify(result));
    assert.ok(!result.error.includes(keys.privateKey), result.error);
  }
});

if (failed) process.exitCode = 1;
