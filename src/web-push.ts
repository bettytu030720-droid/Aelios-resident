// Web Push sent by the Worker itself, with no library. The page subscribes in the browser (PushManager) and hands
// over its PushSubscription; each push is encrypted for that one browser (RFC 8291: aes128gcm from RFC 8188) and
// signed with the server's VAPID key (RFC 8292), all with WebCrypto, which workerd and Node both have.
//
// The VAPID key pair is made once and kept by the caller. The browser subscribes with its public half (the page's
// applicationServerKey), so a new pair ends every subscription. A push service that answers 404 or 410 is saying
// the subscription is gone: the caller deletes it.

/**
 * The server's VAPID key pair, kept by the caller (the Durable Object stores it). Both halves are base64url without
 * padding: publicKey is the 65-byte uncompressed P-256 point (0x04 || x || y), privateKey the 32-byte private
 * scalar, the "d" of its JWK.
 */
export type PushKeys = { publicKey: string; privateKey: string };

/** What the browser's PushSubscription.toJSON() gives, checked; the keys are base64url without padding. */
export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string } };

export type PushUrgency = "very-low" | "low" | "normal" | "high";
export type PushResult = { ok: true } | { gone: true } | { error: string };

/** One record of at most 4096 bytes, the size every push service must take. */
const RECORD_SIZE = 4096;
/** The header in front of the record: salt (16), record size (4), key id length (1), the server's public key (65). */
const HEADER_SIZE = 86;
/** The most plaintext one push carries: 4096 less the header, the AES-GCM tag (16) and the padding delimiter (1). */
export const PUSH_PAYLOAD_MAX = RECORD_SIZE - HEADER_SIZE - 16 - 1;
/** How long a VAPID token is good for; RFC 8292 allows at most 24 hours. */
const VAPID_SECONDS = 12 * 60 * 60;
const ENDPOINT_MAX = 1024;
const SEND_TIMEOUT_MS = 10_000;
const DEFAULT_TTL_SECONDS = 86_400;
const URGENCIES: readonly string[] = ["very-low", "low", "normal", "high"];

const encoder = new TextEncoder();

/** A fresh VAPID key pair. */
export async function makePushKeys(): Promise<PushKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const point = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const { d } = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  if (!d) throw new Error("the new VAPID key has no private half");
  return { publicKey: base64url(point), privateKey: d };
}

/**
 * A subscription the page sent, checked, or null: an https endpoint (a real URL of at most 1024 characters, with no
 * user or password in it), p256dh a 65-byte uncompressed P-256 point and auth 16 bytes, in base64url with or
 * without padding. Only those fields are kept.
 */
export function pushTargetOf(value: unknown): PushTarget | null {
  if (!value || typeof value !== "object") return null;
  const { endpoint, keys } = value as { endpoint?: unknown; keys?: unknown };
  if (typeof endpoint !== "string" || endpoint.length > ENDPOINT_MAX || !keys || typeof keys !== "object") return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.href.length > ENDPOINT_MAX) return null;
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  const point = typeof p256dh === "string" ? fromBase64url(p256dh) : null;
  const secret = typeof auth === "string" ? fromBase64url(auth) : null;
  if (point?.length !== 65 || point[0] !== 0x04 || secret?.length !== 16) return null;
  return { endpoint: url.href, keys: { p256dh: base64url(point), auth: base64url(secret) } };
}

/**
 * The aes128gcm body of one push (RFC 8291 §3.3–3.4): a single record, record size 4096, padding delimiter 0x02 and
 * no padding. Each call makes a new salt and a new key pair of the server's for this one message; `test` fixes them,
 * to check against the example in RFC 8291 Appendix A (serverPrivateKey is an ECDH P-256 key with "deriveBits",
 * serverPublicKey its 65-byte point).
 */
export async function encryptPush(
  target: PushTarget,
  payload: Uint8Array,
  test?: { salt: Uint8Array; serverPrivateKey: CryptoKey; serverPublicKey: Uint8Array }
): Promise<Uint8Array> {
  if (payload.length > PUSH_PAYLOAD_MAX) throw new RangeError(`a push carries at most ${PUSH_PAYLOAD_MAX} bytes`);
  const uaPublic = fromBase64url(target.keys.p256dh);
  const authSecret = fromBase64url(target.keys.auth);
  if (uaPublic?.length !== 65 || uaPublic[0] !== 0x04 || authSecret?.length !== 16) throw new Error("not a push subscription");

  const salt = test ? bytes(test.salt) : crypto.getRandomValues(new Uint8Array(16));
  let asPrivate: CryptoKey;
  let asPublic: Uint8Array<ArrayBuffer>;
  if (test) {
    asPrivate = test.serverPrivateKey;
    asPublic = bytes(test.serverPublicKey);
  } else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  }
  if (salt.length !== 16 || asPublic.length !== 65) throw new Error("a salt is 16 bytes and a server key 65");

  // The shared secret with the browser's key, mixed with its auth secret and both public keys into the IKM.
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // workers-types names this field $public; the runtime reads public.
  const ecdh = { name: "ECDH", public: uaKey };
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, asPrivate, 256));
  const ikm = await hkdf(authSecret, ecdhSecret, joined(encoder.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  // Then the content key and nonce, from the IKM and the salt (RFC 8188 §2.2–2.3).
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  // The last (and only) record ends with the delimiter 0x02.
  const record = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, joined(payload, Uint8Array.of(0x02))));

  const header = new Uint8Array(HEADER_SIZE);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return joined(header, record);
}

/**
 * The Authorization header of a push: `vapid t=<JWT>, k=<public key>` (RFC 8292). The JWT is ES256, its claims the
 * endpoint's origin (aud), a time 12 hours on (exp) and who runs the server (sub, a mailto: or https: URL). `now` is
 * in milliseconds.
 */
export async function vapidAuthorization(endpoint: string, keys: PushKeys, subject: string, now = Date.now()): Promise<string> {
  if (!/^(mailto:|https:\/\/)\S+$/.test(subject)) throw new Error("the VAPID subject must be a mailto: or https: URL");
  const header = { typ: "JWT", alg: "ES256" };
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + VAPID_SECONDS, sub: subject };
  const unsigned = `${base64url(encoder.encode(JSON.stringify(header)))}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
  // WebCrypto's ECDSA signature is already r || s, 32 bytes each, which is what JWS wants.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(keys), encoder.encode(unsigned));
  return `vapid t=${unsigned}.${base64url(new Uint8Array(signature))}, k=${keys.publicKey}`;
}

/**
 * Encrypt and send one push. TTL is how many seconds the push service keeps it for a browser that is offline
 * (default a day); a Topic (up to 32 characters of base64url) replaces an earlier push with the same topic that
 * has not been delivered yet. Never throws: { ok } when the push service took it, { gone } when the subscription is
 * dead (404, 410) and should be deleted, { error } for anything else, without sending when the payload is over
 * PUSH_PAYLOAD_MAX bytes. `fetcher` is for tests.
 */
export async function sendPush(
  target: PushTarget,
  payload: string,
  keys: PushKeys,
  subject: string,
  options: { ttl?: number; urgency?: PushUrgency; topic?: string; fetcher?: typeof fetch } = {}
): Promise<PushResult> {
  const plaintext = encoder.encode(payload);
  if (plaintext.length > PUSH_PAYLOAD_MAX) return { error: `the push is ${plaintext.length} bytes, over ${PUSH_PAYLOAD_MAX}` };
  const ttl = options.ttl ?? DEFAULT_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl < 0) return { error: "TTL is a whole number of seconds" };
  const urgency = options.urgency ?? "normal";
  if (!URGENCIES.includes(urgency)) return { error: `urgency is one of ${URGENCIES.join(", ")}` };
  if (options.topic && !/^[A-Za-z0-9_-]{1,32}$/.test(options.topic)) return { error: "a topic is up to 32 characters of A-Z, a-z, 0-9, - and _" };

  let response: Response;
  try {
    const headers: Record<string, string> = {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: urgency,
      Authorization: await vapidAuthorization(target.endpoint, keys, subject)
    };
    if (options.topic) headers.Topic = options.topic;
    const body = await encryptPush(target, plaintext);
    const init: RequestInit = { method: "POST", headers, body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) };
    response = await (options.fetcher ? options.fetcher(target.endpoint, init) : fetch(target.endpoint, init));
  } catch (error) {
    return { error: scrub(`the push did not go out: ${error instanceof Error ? error.message : String(error)}`, keys) };
  }
  if (response.ok) {
    response.body?.cancel().catch(() => {});
    return { ok: true };
  }
  if (response.status === 404 || response.status === 410) {
    response.body?.cancel().catch(() => {});
    return { gone: true };
  }
  const text = (await response.text().catch(() => "")).trim().slice(0, 200);
  return { error: scrub(`the push service answered ${response.status}${text ? `: ${text}` : ""}`, keys) };
}

/** The VAPID private key as a WebCrypto key; its JWK needs x and y too, which come from the public key. */
async function signingKey(keys: PushKeys): Promise<CryptoKey> {
  const point = fromBase64url(keys.publicKey);
  if (point?.length !== 65 || point[0] !== 0x04) throw new Error("the VAPID public key is not a P-256 point");
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", x: base64url(point.subarray(1, 33)), y: base64url(point.subarray(33)), d: keys.privateKey };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** HKDF-SHA-256, extract and expand, `length` bytes. */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** An error never carries the private key, whatever a push service or a runtime put in it. */
function scrub(text: string, keys: PushKeys): string {
  return keys.privateKey ? text.split(keys.privateKey).join("…") : text;
}

function joined(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A copy on its own ArrayBuffer, which is what WebCrypto takes. */
function bytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data);
}

function base64url(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url with or without its = padding; null for anything else. */
function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  const bare = text.replace(/={1,2}$/, "");
  if (!/^[A-Za-z0-9_-]*$/.test(bare) || bare.length % 4 === 1 || (bare !== text && text.length % 4 !== 0)) return null;
  try {
    const binary = atob(bare.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((bare.length + 3) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}
