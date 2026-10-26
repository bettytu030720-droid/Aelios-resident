// Unit tests for the WeCom door (src/wecom.ts): opening what WeCom pushes (checked against Node's own AES), the XML,
// what she sent, the text that goes back. Usage: node test/wecom.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-wecom-"));
const out = join(dir, "wecom.mjs");
await build({ entryPoints: ["src/wecom.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const w = await import(pathToFileURL(join(process.cwd(), out)).href);
rmSync(dir, { recursive: true, force: true });

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

const AES = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const CORP = "wwtest0001";

/** What WeCom does, with Node's AES: 16 random bytes, the length, the message, the CorpID, PKCS#7 to 32 bytes. */
function encrypt(text, { corp = CORP, aes = AES } = {}) {
  const key = Buffer.from(`${aes}=`, "base64");
  const message = Buffer.from(text);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.length);
  let plain = Buffer.concat([crypto.randomBytes(16), length, message, Buffer.from(corp)]);
  const pad = 32 - (plain.length % 32);
  plain = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString("base64");
}

const config = { corpId: CORP, agentId: "1000002", secret: "s", token: "tok", aesKey: AES, relay: "http://relay", relayKey: "k".repeat(32), allowed: ["heruser"] };

await test("what WeCom encrypted opens, whatever its length (every padding from 1 to 32 bytes)", async () => {
  for (let size = 0; size < 70; size++) {
    const text = `<xml>${"字a".repeat(size)}</xml>`;
    assert.equal(await w.wecomDecrypt(AES, encrypt(text), CORP), text, `size ${size}`);
  }
});

await test("a message for another enterprise, or under another key, does not open", async () => {
  await assert.rejects(w.wecomDecrypt(AES, encrypt("<xml/>", { corp: "wwother" }), CORP), /CorpID/);
  const otherKey = "ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zyxwvut";
  await assert.rejects(w.wecomDecrypt(AES, encrypt("<xml/>", { aes: otherKey }), CORP));
  await assert.rejects(w.wecomDecrypt(AES, "bm90IGJsb2Nrcw==", CORP), /AES blocks/);
  await assert.rejects(w.wecomDecrypt("short", encrypt("<xml/>"), CORP), /43/);
});

await test("the signature is WeCom's: SHA-1 of the four, sorted", async () => {
  const want = crypto.createHash("sha1").update(["tok", "1700000000", "nonce", "ENC"].sort().join("")).digest("hex");
  assert.equal(await w.wecomSignature("tok", "1700000000", "nonce", "ENC"), want);
});

await test("the address check gives the echo back only when it is signed, fresh and for this enterprise", async () => {
  const echo = encrypt("6234897512");
  const now = String(Math.floor(Date.now() / 1000));
  const query = async (timestamp, token = "tok", value = echo) =>
    new URLSearchParams({ msg_signature: await w.wecomSignature(token, timestamp, "n1", value), timestamp, nonce: "n1", echostr: value });
  assert.deepEqual(await w.wecomVerify(config, await query(now)), { status: 200, body: "6234897512" });
  assert.equal((await w.wecomVerify(config, await query(now, "bad"))).status, 403);
  assert.equal((await w.wecomVerify(config, await query(String(Number(now) - 7200)))).status, 403);
  assert.equal((await w.wecomVerify(null, await query(now))).status, 404);
  // A + that came through unencoded reads as a space: still the same echo.
  const plus = echo.includes("+") ? echo : null;
  if (plus) {
    const params = await query(now);
    params.set("echostr", plus.replace(/\+/g, " "));
    assert.equal((await w.wecomVerify(config, params)).status, 200);
  }
});

await test("the XML's fields, CDATA or not, entities undone, nested ones flat", () => {
  const fields = w.xmlFields(
    "<xml><ToUserName><![CDATA[ww1]]></ToUserName><CreateTime>1348831860</CreateTime><Content><![CDATA[a <b> & c]]></Content>" +
      "<Label>x &amp; y &#20013;</Label><SendLocationInfo><Location_X>23.1</Location_X></SendLocationInfo></xml>"
  );
  assert.deepEqual(fields, { ToUserName: "ww1", CreateTime: "1348831860", Content: "a <b> & c", Label: "x & y 中", Location_X: "23.1" });
});

await test("what she sent: text, a picture, a voice message, a video, a place, a link; events and empty text are not messages", () => {
  assert.deepEqual(w.readPush({ MsgType: "text", Content: "hi" }), { text: "hi", attachments: [] });
  const picture = w.readPush({ MsgType: "image", MediaId: "m1", PicUrl: "http://x" });
  assert.deepEqual([picture.attachments[0].type, picture.attachments[0].mimeType, picture.attachments[0].fetchMetadata.fileId], ["image", "image/jpeg", "m1"]);
  const voice = w.readPush({ MsgType: "voice", MediaId: "v1", Format: "amr" });
  assert.deepEqual([voice.attachments[0].type, voice.attachments[0].mimeType], ["audio", "audio/amr"]);
  assert.equal(w.readPush({ MsgType: "video", MediaId: "x" }).attachments[0].type, "video");
  assert.equal(w.readPush({ MsgType: "location", Location_X: "23.1", Location_Y: "113.3", Label: "广州塔" }).text, "[location] 广州塔 (23.1, 113.3)");
  assert.equal(w.readPush({ MsgType: "link", Title: "T", Description: "D", Url: "https://x" }).text, "[link] T\nD\nhttps://x");
  assert.equal(w.readPush({ MsgType: "event", Event: "enter_agent" }), null);
  assert.equal(w.readPush({ MsgType: "text", Content: "  " }), null);
});

await test("a reply as WeChat shows it: bold, headings, links and fences come off; single * and ` in kaomoji stay", () => {
  assert.equal(w.plainText("**好的**老婆～"), "好的老婆～");
  assert.equal(w.plainText("## 标题\n正文"), "标题\n正文");
  assert.equal(w.plainText("看 [这个](https://example.com/a) 吧"), "看 这个 https://example.com/a 吧");
  assert.equal(w.plainText("https://example.com"), "https://example.com");
  assert.equal(w.plainText("```js\nx = 1\n```"), "x = 1");
  assert.equal(w.plainText("* 一\n* 二"), "- 一\n- 二");
  assert.equal(w.plainText("(*´▽`*) ~~删~~"), "(*´▽`*) 删");
  assert.equal(w.plainText("> 引用"), "引用");
});

await test("long text is cut at 2048 UTF-8 bytes, at a line break or full stop when there is one, nothing lost", () => {
  const chinese = "长".repeat(1500);
  const pieces = w.byteChunks(chinese);
  assert.ok(pieces.every((piece) => Buffer.byteLength(piece) <= 2048));
  assert.equal(pieces.join(""), chinese);
  const lines = `${"一句话。".repeat(150)}\n${"第二段。".repeat(150)}`;
  const cut = w.byteChunks(lines);
  assert.ok(cut.every((piece) => Buffer.byteLength(piece) <= 2048));
  assert.ok(cut[0].endsWith("。"));
  const emoji = "😀".repeat(1000);
  assert.equal(w.byteChunks(emoji).join(""), emoji, "never inside a character");
  assert.deepEqual(w.byteChunks("短的"), ["短的"]);
});

await test("the settings: off when empty, what is missing next, and who is let in", () => {
  assert.equal(w.wecomGap({}), "off");
  assert.equal(w.wecomGap({ WECOM_CORP_ID: CORP }), "WECOM_AGENT_ID");
  assert.equal(w.wecomConfig({ WECOM_CORP_ID: CORP }), null);
  const opening = w.wecomConfig({ WECOM_CORP_ID: CORP, WECOM_TOKEN: "t", WECOM_AES_KEY: AES });
  assert.ok(opening && !w.canSend(opening), "opens pushes, but cannot answer yet");
  const full = w.wecomConfig({
    WECOM_CORP_ID: CORP, WECOM_AGENT_ID: "1", WECOM_SECRET: "s", WECOM_TOKEN: "t", WECOM_AES_KEY: AES,
    WECOM_RELAY_URL: "https://relay.example.com/", WECOM_RELAY_KEY: "k".repeat(32), WECOM_ALLOWED: "HerUser， Other two"
  });
  assert.ok(w.canSend(full));
  assert.equal(full.relay, "https://relay.example.com");
  assert.deepEqual(full.allowed, ["heruser", "other", "two"]);
  assert.ok(w.isWecomAllowed(full, "HERUSER"));
  assert.ok(!w.isWecomAllowed(full, "stranger"));
  assert.equal(w.userOf("wecom:HerUser"), "HerUser");
  assert.equal(w.userOf("telegram:42"), null);
});

await test("WeCom's errors in words she can act on", () => {
  assert.match(w.wecomProblem(new w.WecomError(60020, "not allow to access from your ip")), /企业可信 IP.*60020/);
  assert.match(w.wecomProblem(new w.WecomError(99999, "something")), /something（99999）/);
  assert.equal(w.wecomProblem(new Error("plain")), "plain");
});
