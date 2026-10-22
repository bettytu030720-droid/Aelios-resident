// Unit tests for voice messages (src/voice.ts): what the local Worker cannot reach, such as AI Gateway on the AI
// binding and Whisper, and the small pieces. Usage: node test/voice.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

mkdirSync("node_modules/.cache", { recursive: true });
const dir = mkdtempSync(join("node_modules/.cache", "resident-voice-"));
const out = join(dir, "voice.mjs");
await build({ entryPoints: ["src/voice.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
const v = await import(pathToFileURL(join(process.cwd(), out)).href);
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

// One second of 128 kbit/s MPEG-1 layer III, behind an ID3 tag of 20 bytes.
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 20, ...new Array(20).fill(0), 0xff, 0xfb, 0x90, 0x64, ...new Array(16000 - 4).fill(0)]);
const mp3Response = () => new Response(MP3, { headers: { "content-type": "audio/mpeg" } });

/** An AI binding that records what reaches AI Gateway and what Whisper is asked. */
function fakeAi({ answer = mp3Response, whisper = "你好" } = {}) {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body instanceof FormData ? Object.fromEntries(init.body) : init.body;
      calls.push({ url, headers, body });
      return answer(url);
    },
    async run(model, input) {
      calls.push({ model, input });
      if (whisper instanceof Error) throw whisper;
      return { text: whisper };
    }
  };
}

await test("an MP3's length comes from its first frame, past an ID3 tag; anything else is 0", () => {
  assert.equal(v.mp3Seconds(MP3), (MP3.length - 30) * 8 / 128000);
  assert.ok(Math.abs(v.mp3Seconds(MP3) - 1) < 0.01);
  // MPEG-2 at 64 kbit/s, no tag.
  assert.ok(Math.abs(v.mp3Seconds(new Uint8Array([0xff, 0xf3, 0x80, 0x64, ...new Array(7996).fill(0)])) - 1) < 0.01);
  assert.equal(v.mp3Seconds(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0])), 0);
});

await test("what is said leaves out links, markdown and emoji, and keeps the voice model's own marks", () => {
  assert.equal(v.speakable("## 好呀 😊\n> 看 **这个** https://a.b/c `代码`"), "好呀\n看 这个 代码");
  assert.equal(v.speakable('[laughs] 你呀 <break time="500ms"/> 真是'), '[laughs] 你呀 <break time="500ms"/> 真是');
  assert.equal(v.clock(75), "1:15");
  assert.equal(v.clock(3.4), "0:03");
});

await test("each provider and model gets its own marks, and the text without them when it goes out as text", () => {
  const dialect = (env) => v.dialectOf(env);
  assert.match(dialect({ VOICE_PROVIDER: "elevenlabs" }).marks, /\[laughs\]/);
  assert.equal(dialect({ VOICE_PROVIDER: "elevenlabs", VOICE_MODEL: "eleven_flash_v2_5" }).marks, "");
  assert.match(dialect({ VOICE_PROVIDER: "cartesia" }).marks, /\[laughter\]/);
  assert.match(dialect({ VOICE_PROVIDER: "openrouter", VOICE_MODEL: "minimax/speech-2.8-hd" }).marks, /\(laughs\)/);
  assert.equal(dialect({ VOICE_PROVIDER: "openrouter", VOICE_MODEL: "minimax/speech-02-hd" }).marks, "");
  const gemini = dialect({ VOICE_PROVIDER: "openrouter", VOICE_MODEL: "google/gemini-3.8-flash-tts" });
  assert.ok(gemini.style && /<laugh>/.test(gemini.marks));
  assert.deepEqual(dialect({ VOICE_PROVIDER: "openrouter", VOICE_MODEL: "openai/gpt-4o-mini-tts" }), { marks: "", style: true });
  assert.match(dialect({ VOICE_PROVIDER: "openrouter", VOICE_MODEL: "elevenlabs/eleven-v4" }).marks, /\[laughs\]/);
  assert.equal(v.unmarked("[laughs] 你呀 [whispers] 过来", dialect({ VOICE_PROVIDER: "elevenlabs" })), "你呀 过来");
  assert.equal(v.unmarked('好 <break time="1s"/> 吧 [laughter]', dialect({ VOICE_PROVIDER: "cartesia" })), "好 吧");
  assert.equal(v.unmarked("嗯 (sighs) 好<#0.5#>吧", dialect({ VOICE_PROVIDER: "openrouter", VOICE_MODEL: "minimax/speech-2.8-hd" })), "嗯 好吧");
  // Square brackets that are no tag stay.
  assert.equal(v.unmarked("第 [1] 条", dialect({ VOICE_PROVIDER: "elevenlabs" })), "第 [1] 条");
});

await test("what is missing before voice messages can be sent; until then no lines in the prompt", () => {
  const ai = fakeAi();
  assert.equal(v.speakingGap({}), "off");
  assert.equal(v.speakingGap({ VOICE_PROVIDER: "off", VOICE_API_KEY: "k" }), "off");
  assert.equal(v.speakingGap({ VOICE_PROVIDER: "elevenlabs" }), "VOICE_API_KEY");
  assert.equal(v.speakingGap({ VOICE_PROVIDER: "elevenlabs", AI: ai }), "VOICE_ID", "a key on AI Gateway will do");
  assert.equal(v.speakingGap({ VOICE_PROVIDER: "elevenlabs", AI: ai, VOICE_BASE_URL: "https://proxy.example" }), "VOICE_API_KEY", "not through the gateway");
  assert.equal(v.speakingGap({ VOICE_PROVIDER: "openrouter", AI: ai }), "VOICE_MODEL");
  assert.equal(v.speakingGap({ VOICE_PROVIDER: "openrouter", AI: ai, VOICE_MODEL: "minimax/speech-2.8-hd" }), null);
  assert.equal(v.voiceRules({ VOICE_PROVIDER: "elevenlabs", AI: ai }), "");
  assert.equal(v.voiceRules({}), "");
  const set = { VOICE_PROVIDER: "elevenlabs", AI: ai, VOICE_ID: "x" };
  assert.match(v.voiceRules(set), /^- A message of theirs marked \[voice …\].*\[laughs\].*send_voice\.$/);
  assert.match(v.voiceRules({ ...set, VOICE_REPLY: "always" }), /^- Your replies are sent as voice messages/);
  assert.match(v.voiceRules({ ...set, VOICE_REPLY: "tool" }), /^- Your replies are sent as text\. To send a voice message, use send_voice\. In it: /);
  assert.equal(v.replyOf({ VOICE_REPLY: "sometimes" }), "mirror");
});

await test("through AI Gateway on the AI binding: each provider's own endpoint, and no key sent when none is set (BYOK)", async () => {
  const ai = fakeAi();
  await v.speaker({ AI: ai, VOICE_PROVIDER: "elevenlabs", VOICE_ID: "abc" })("你好");
  await v.speaker({ AI: ai, VOICE_PROVIDER: "cartesia", VOICE_ID: "c1", AI_GATEWAY_ID: "mine" })("你好");
  const spoken = await v.speaker({ AI: ai, VOICE_PROVIDER: "openrouter", VOICE_MODEL: "google/gemini-3.8-flash-tts", VOICE_API_KEY: "or-key" })("hi", { style: "sleepy" });
  const [eleven, cartesia, openrouter] = ai.calls;
  assert.equal(eleven.url, "https://workers-binding.ai/ai-gateway/gateways/default/elevenlabs/v1/text-to-speech/abc?output_format=mp3_44100_128");
  assert.equal(eleven.headers["xi-api-key"], undefined);
  assert.deepEqual(eleven.body, { text: "你好", model_id: "eleven_v4" });
  assert.equal(cartesia.url, "https://workers-binding.ai/ai-gateway/gateways/mine/cartesia/tts/bytes");
  assert.equal(cartesia.headers.authorization, undefined);
  assert.equal(cartesia.headers["cartesia-version"], "2026-08-14");
  assert.equal(cartesia.body.language, "zh");
  assert.equal(openrouter.url, "https://workers-binding.ai/ai-gateway/gateways/default/openrouter/v1/audio/speech");
  assert.equal(openrouter.headers.authorization, "Bearer or-key");
  assert.deepEqual(openrouter.body, { model: "google/gemini-3.8-flash-tts", input: "hi", instructions: "sleepy", response_format: "mp3" });
  assert.ok(Math.abs(spoken.seconds - 1) < 0.01);
});

await test("audio that is not MP3 is refused, so it never reaches Telegram as a file", async () => {
  const ai = fakeAi({ answer: () => new Response(new Uint8Array(8), { headers: { "content-type": "audio/wav" } }) });
  await assert.rejects(v.speaker({ AI: ai, VOICE_PROVIDER: "cartesia", VOICE_ID: "c1" })("hi"), /audio\/wav, not MP3/);
  const failing = fakeAi({ answer: () => new Response("quota", { status: 429 }) });
  await assert.rejects(v.speaker({ AI: failing, VOICE_PROVIDER: "elevenlabs", VOICE_ID: "a" })("hi"), /ElevenLabs 429: quota/);
});

await test("hearing: Whisper on the AI binding; ElevenLabs Scribe when ElevenLabs is picked, with Whisper behind it", async () => {
  assert.equal(v.hearing({}), null);
  assert.equal(v.hearsBy({ VOICE_PROVIDER: "elevenlabs" }), null, "no key and no binding: nothing hears");
  const ai = fakeAi({ whisper: "听到了" });
  assert.equal(v.hearsBy({ AI: ai }), "whisper");
  assert.equal(await v.hearing({ AI: ai })(new Uint8Array([1, 2, 3]), "audio/ogg"), "听到了");
  assert.deepEqual(ai.calls.at(-1), { model: "@cf/openai/whisper-large-v3-turbo", input: { audio: "AQID" } });
  const scribe = fakeAi({ answer: () => Response.json({ text: "Scribe 听到了" }) });
  assert.equal(v.hearsBy({ AI: scribe, VOICE_PROVIDER: "elevenlabs" }), "scribe");
  assert.equal(await v.hearing({ AI: scribe, VOICE_PROVIDER: "elevenlabs" })(new Uint8Array([1]), "audio/ogg"), "Scribe 听到了");
  assert.equal(scribe.calls[0].url, "https://workers-binding.ai/ai-gateway/gateways/default/elevenlabs/v1/speech-to-text");
  assert.equal(scribe.calls[0].body.model_id, "scribe_v2");
  const down = fakeAi({ answer: () => new Response("busy", { status: 503 }), whisper: "Whisper 接住了" });
  assert.equal(await v.hearing({ AI: down, VOICE_PROVIDER: "elevenlabs" })(new Uint8Array([1]), "audio/ogg"), "Whisper 接住了");
});

await test("a heard voice message joins her text with its length; the attachment is gone; one not heard says so", async () => {
  const voice = (id) => ({ mediaType: "audio/ogg", fetchMetadata: { fileId: id, duration: "12" }, size: 100 });
  const photo = { mediaType: "image/jpeg", fetchMetadata: { fileId: "p" } };
  const context = {
    message: { text: "[10-22 周四 09:00]", attachments: [voice("a"), photo] },
    skipped: [{ text: "[10-22 周四 08:59] 先打个字", attachments: [voice("bad")] }]
  };
  const download = async (id) => (id === "bad" ? new Uint8Array() : new Uint8Array([1]));
  const got = await v.heard(context, download, async () => "  今天\n好累  ");
  assert.equal(got.message.text, "[10-22 周四 09:00] [voice 0:12] 今天 好累");
  assert.deepEqual(got.message.attachments, [photo]);
  assert.equal(got.skipped[0].text, "[10-22 周四 08:59] 先打个字\n[voice 0:12, could not be heard]");
  assert.equal(await v.heard({ message: { text: "hi", attachments: [photo] } }, download, null), null);
  const deaf = await v.heard({ message: { text: "", attachments: [voice("a")] } }, download, null);
  assert.equal(deaf.message.text, "[voice 0:12, could not be heard]");
});

await test("Telegram's length of a voice message is kept on its attachment", () => {
  const event = {
    message: { raw: { voice: { file_id: "f1", duration: 7 } }, attachments: [{ mediaType: "audio/ogg", fetchMetadata: { fileId: "f1" } }] },
    skipped: [{ raw: { audio: { file_id: "f2", duration: 61 } }, attachments: [{ mediaType: "audio/mpeg", fetchMetadata: { fileId: "f2" } }] }]
  };
  v.noteVoiceLengths(event);
  assert.equal(event.message.attachments[0].fetchMetadata.duration, "7");
  assert.equal(event.skipped[0].attachments[0].fetchMetadata.duration, "61");
});
