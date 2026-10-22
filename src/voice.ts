// Voice messages on Telegram.
//
// Hearing is always on. Telegram does not turn voice into text for bots, so a voice message (or an audio file) they
// send is transcribed here and goes into their message as "[voice 0:12] what they said": Cloudflare's Whisper does it
// (Workers AI), or ElevenLabs Scribe when ElevenLabs is the voice provider, with Whisper behind it should Scribe fail.
//
// Speaking needs a provider picked on the settings page (VOICE_PROVIDER); until then nothing about sending voice is
// added to the prompt or the tools. ElevenLabs (the voices in your own account too) and Cartesia are called in their own
// formats, and OpenRouter, which puts most other voice models (MiniMax, Gemini, OpenAI…) behind one key, in OpenAI's.
// Requests go through AI Gateway on the AI binding, so a key stored on the gateway (BYOK) is used when VOICE_API_KEY is
// empty. Every one is asked for MP3, which Telegram shows as a voice message.
// Each voice model reads its own marks for laughs, sighs and pauses (dialectOf): the resident is told the ones the
// model in use reads, and only those.

import type { MessengerAttachment, MessengerContext, MessengerEvent, MessengerMessage } from "@cloudflare/think/messengers";
import type { Download } from "./pictures";

/** The Bot API downloads files up to 20 MB. */
export const HEAR_MAX_BYTES = 20 * 1024 * 1024;
const WHISPER = "@cf/openai/whisper-large-v3-turbo";
const SCRIBE = "scribe_v2";
// A longer reply goes out as text: a voice message that long is hard to listen to, and costs more.
export const SPEAK_MAX_CHARS = 2000;
const TIMEOUT_MS = 60_000;

export const VOICE_PROVIDERS = ["off", "elevenlabs", "cartesia", "openrouter"] as const;
export type VoiceProvider = Exclude<(typeof VOICE_PROVIDERS)[number], "off">;
/** mirror: a voice message is answered with one. always: every reply is a voice message. tool: only send_voice. */
export const VOICE_REPLIES = ["mirror", "always", "tool"] as const;
export type VoiceReply = (typeof VOICE_REPLIES)[number];

// Where each one is reached without AI Gateway; endpoints below are the path after this.
const HOSTS: Record<VoiceProvider, string> = {
  openrouter: "https://openrouter.ai/api",
  elevenlabs: "https://api.elevenlabs.io",
  cartesia: "https://api.cartesia.ai"
};
// The AI binding's own origin, for AI Gateway's provider-native endpoints (as agents/models does it).
const GATEWAY_ORIGIN = "https://workers-binding.ai/ai-gateway/gateways";
const DEFAULT_MODELS: Partial<Record<VoiceProvider, string>> = {
  elevenlabs: "eleven_v4",
  cartesia: "sonic-3.6"
};
const CARTESIA_VERSION = "2026-08-14";

// ---- getting there ----

type Send = (provider: VoiceProvider, endpoint: string, init: RequestInit) => Promise<Response>;

/** Whether requests go through AI Gateway, where a key stored on the gateway stands in for VOICE_API_KEY. */
function viaGateway(env: Env): boolean {
  return Boolean(env.AI) && !env.VOICE_BASE_URL?.trim();
}

/** The AI Gateway voice requests go through (AI_GATEWAY_ID, else "default"); null when they go straight there. */
export function voiceGateway(env: Env): string | null {
  return viaGateway(env) ? env.AI_GATEWAY_ID?.trim() || "default" : null;
}

/**
 * The AI Gateway whose stored key (BYOK) voice requests rely on: no VOICE_API_KEY, so none is sent and the gateway
 * puts in the one it holds for the provider under the alias default. null when the key is sent or there is no gateway.
 */
export function keyFromGateway(env: Env): string | null {
  return env.VOICE_API_KEY?.trim() ? null : voiceGateway(env);
}

/**
 * A provider's error. Turned away for want of a key while relying on the gateway's: says which gateway, since the
 * usual cause is the key stored on another one (the one Aelios uses, say).
 */
async function failed(name: string, response: Response, gateway: string | null): Promise<never> {
  const said = (await response.text()).slice(0, 200);
  const hint =
    gateway && (response.status === 401 || response.status === 403)
      ? ` (no key was sent: AI Gateway "${gateway}" has none stored for ${name} under the alias default, or that key is wrong)`
      : "";
  // The hint goes first: what is kept of an error (/status, the tool's answer) is cut at 300 characters.
  throw new Error(`${name} ${response.status}${hint}: ${said}`);
}

/**
 * Sends one request to a voice provider: through AI Gateway (AI_GATEWAY_ID, else "default") on the AI binding, or
 * straight to the provider without the binding. VOICE_BASE_URL sends it straight there instead (a proxy, the tests).
 */
function sender(env: Env): Send {
  const base = env.VOICE_BASE_URL?.trim().replace(/\/+$/, "");
  const ai = env.AI as unknown as { fetch(url: string, init: RequestInit): Promise<Response> } | undefined;
  const gateway = encodeURIComponent(env.AI_GATEWAY_ID?.trim() || "default");
  return (provider, endpoint, init) => {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    if (base) return fetch(`${base}/${endpoint}`, { ...init, signal });
    if (ai) return ai.fetch(`${GATEWAY_ORIGIN}/${gateway}/${provider}/${endpoint}`, { ...init, signal });
    return fetch(`${HOSTS[provider]}/${endpoint}`, { ...init, signal });
  };
}

// ---- hearing ----

/** Turns one voice message into text. */
export type Hear = (audio: Uint8Array, mediaType: string) => Promise<string>;

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

async function whisper(ai: Ai, audio: Uint8Array): Promise<string> {
  const result = (await ai.run(WHISPER as never, { audio: base64(audio) } as never)) as { text?: string };
  return result.text ?? "";
}

async function scribe(send: Send, key: string, gateway: string | null, audio: Uint8Array, mediaType: string): Promise<string> {
  const form = new FormData();
  form.append("model_id", SCRIBE);
  form.append("file", new Blob([audio], { type: mediaType }), "voice");
  const response = await send("elevenlabs", "v1/speech-to-text", { method: "POST", headers: key ? { "xi-api-key": key } : {}, body: form });
  if (!response.ok) return failed("ElevenLabs", response, gateway);
  return ((await response.json()) as { text?: string }).text ?? "";
}

/** What hears voice messages with these settings: ElevenLabs Scribe (Whisper behind it), Whisper, or nothing. */
export function hearsBy(env: Env): "scribe" | "whisper" | null {
  if (providerOf(env) === "elevenlabs" && (env.VOICE_API_KEY?.trim() || viaGateway(env))) return "scribe";
  return env.AI ? "whisper" : null;
}

/** How voice messages are heard with these settings; null when nothing can hear them (no AI binding, no Scribe). */
export function hearing(env: Env): Hear | null {
  const ai = env.AI;
  const viaWhisper = ai ? (audio: Uint8Array) => whisper(ai, audio) : null;
  if (hearsBy(env) !== "scribe") return viaWhisper;
  const key = env.VOICE_API_KEY?.trim() ?? "";
  const gateway = keyFromGateway(env);
  const send = sender(env);
  return async (audio, mediaType) => {
    try {
      return await scribe(send, key, gateway, audio, mediaType);
    } catch (error) {
      if (!viaWhisper) throw error;
      console.error("voice: Scribe failed, Whisper instead", { error: String(error) });
      return viaWhisper(audio);
    }
  };
}

function isVoice(attachment: MessengerAttachment): boolean {
  return Boolean(attachment.mediaType?.startsWith("audio/") && attachment.fetchMetadata?.fileId) && (attachment.size ?? 0) <= HEAR_MAX_BYTES;
}

/** 75 → "1:15". */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The mark a voice message leaves in their text: "[voice 0:12]", "[voice]" or "[voice 0:12, could not be heard]". */
export const VOICE_MARK = /\[voice(?: (\d+:\d\d))?(, could not be heard)?\]/g;

/**
 * Telegram says how long a voice message is, but only in the raw update: kept on the attachment (its fetchMetadata
 * is stored with the turn), for the "[voice 0:12]" mark. Called from the messenger's toEvent.
 */
export function noteVoiceLengths(event: MessengerEvent): MessengerEvent {
  for (const entry of [...(event.skipped ?? []), ...(event.message ? [event.message] : [])]) {
    const raw = entry.raw as { voice?: { file_id?: string; duration?: number }; audio?: { file_id?: string; duration?: number } } | undefined;
    for (const media of [raw?.voice, raw?.audio]) {
      if (!media?.file_id || typeof media.duration !== "number") continue;
      const attachment = entry.attachments.find((item) => item.fetchMetadata?.fileId === media.file_id);
      if (attachment?.fetchMetadata) attachment.fetchMetadata.duration = String(media.duration);
    }
  }
  return event;
}

// Only the time stamp put in front of a message that had no words of its own.
const STAMP_ONLY = /^\[[^\]]*\]$/;

/**
 * The turn's messages with each voice message heard: its text joins the message it came with, and it is no longer
 * listed as an attachment. One that could not be heard says so, so the reply can ask them to say it again.
 * Null when there was no voice message.
 */
export async function heard(context: MessengerContext, download: Download, hear: Hear | null): Promise<MessengerContext | null> {
  let any = false;
  const listen = async (entry: MessengerMessage): Promise<MessengerMessage> => {
    const voices = entry.attachments.filter(isVoice);
    if (!voices.length) return entry;
    any = true;
    const lines: string[] = [];
    for (const voice of voices) {
      const length = voice.fetchMetadata?.duration;
      const mark = length && Number.isFinite(Number(length)) ? `voice ${clock(Number(length))}` : "voice";
      try {
        if (!hear) throw new Error("nothing to hear it with: the Worker has no AI binding");
        const data = await download(voice.fetchMetadata!.fileId);
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (!bytes.length) throw new Error("the file came down empty");
        const text = (await hear(bytes, voice.mediaType!)).trim().replace(/\s+/g, " ");
        lines.push(`[${mark}] ${text || "…"}`);
      } catch (error) {
        console.error("voice: could not hear a voice message", { error: String(error) });
        lines.push(`[${mark}, could not be heard]`);
      }
    }
    const own = entry.text.trim();
    const said = lines.join("\n");
    return {
      ...entry,
      text: !own ? said : STAMP_ONLY.test(own) ? `${own} ${said}` : `${own}\n${said}`,
      attachments: entry.attachments.filter((item) => !voices.includes(item))
    };
  };
  const message = context.message && (await listen(context.message));
  const skipped = context.skipped && (await Promise.all(context.skipped.map(listen)));
  return any ? { ...context, message, skipped } : null;
}

// ---- how each voice model is written for ----

/** The marks a voice model reads for laughs, sighs and pauses. */
export type Dialect = {
  /** For the system prompt: how to write the marks, or "" when the model reads none. */
  marks: string;
  /** The marks, taken out when a reply has to go out as text after all. */
  strip?: RegExp;
  /** send_voice also takes a few words on how to say it (OpenRouter's `instructions`). */
  style?: boolean;
};

const SQUARE: Dialect = {
  marks: "Put audio tags in square brackets, in English, before the words they color: [laughs], [whispers], [sighs], [excited], [softly], [teasing]; … makes a pause.",
  strip: /\[[a-z][a-z ,'-]*\]\s*/gi
};
const PARENS: Dialect = {
  marks: "Put sounds in parentheses where they happen: (laughs), (chuckle), (sighs), (breath), (gasps), (sniffs), (emm), (humming); <#0.5#> between words pauses that many seconds.",
  strip: /\((?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|lip-smacking|humming|hissing|emm|sneezes)\)\s*|<#[\d.]+#>/g
};
const ANGLE: Dialect = {
  marks: "Put sounds and pauses in angle brackets, in English, where they happen: <laugh>, <chuckle>, <giggle>, <sigh>, <breath>, <whispers>, <short pause>, <long pause>.",
  strip: /<[a-z][a-z -]*>\s*/gi,
  style: true
};
const CARTESIA: Dialect = {
  marks:
    'Put [laughter] where you laugh and <break time="500ms"/> for a pause; <speed ratio="0.9"/> or <volume ratio="0.8"/> before words said slower or softer; ' +
    'in English only, <emotion value="affectionate"/> (or calm, excited, sad, curious, tired…) before the words it colors.',
  strip: /\[laughter\]\s*|<(?:break|speed|volume|emotion)\b[^>]*\/>\s*|<\/?spell>/g
};
const PLAIN: Dialect = { marks: "" };

export function dialectOf(env: Env): Dialect {
  const provider = providerOf(env);
  const model = modelOf(env, provider).toLowerCase();
  if (provider === "cartesia") return CARTESIA;
  if (provider === "elevenlabs") return /v3|v4/.test(model) ? SQUARE : PLAIN;
  if (model.startsWith("elevenlabs/")) return /v3|v4/.test(model) ? SQUARE : PLAIN;
  if (model.startsWith("minimax/")) return /2\.8/.test(model) ? PARENS : PLAIN;
  if (model.startsWith("google/")) return ANGLE;
  // Models OpenRouter passes `instructions` to.
  if (/^(openai|fish-audio)\//.test(model)) return { marks: "", style: true };
  return PLAIN;
}

// ---- speaking ----

/** A voice message ready to send. */
export type Spoken = { audio: Uint8Array; seconds: number };
export type Speak = (text: string, options?: { style?: string }) => Promise<Spoken>;

export function providerOf(env: Env): VoiceProvider | null {
  const name = env.VOICE_PROVIDER?.trim().toLowerCase();
  return name && name !== "off" && (VOICE_PROVIDERS as readonly string[]).includes(name) ? (name as VoiceProvider) : null;
}

export function replyOf(env: Env): VoiceReply {
  const mode = env.VOICE_REPLY?.trim().toLowerCase();
  return (VOICE_REPLIES as readonly string[]).includes(mode ?? "") ? (mode as VoiceReply) : "mirror";
}

function modelOf(env: Env, provider: VoiceProvider | null): string {
  return env.VOICE_MODEL?.trim() || (provider ? (DEFAULT_MODELS[provider] ?? "") : "");
}

/** The setting still missing before voice messages can be sent: "off", a variable's name, or null when none is. */
export function speakingGap(env: Env): string | null {
  const provider = providerOf(env);
  if (!provider) return "off";
  if (!env.VOICE_API_KEY?.trim() && !viaGateway(env)) return "VOICE_API_KEY";
  // On OpenRouter the model picks the provider; voices there mostly have defaults or plain names.
  if (provider === "openrouter") return modelOf(env, provider) ? null : "VOICE_MODEL";
  return env.VOICE_ID?.trim() ? null : "VOICE_ID";
}

async function audioOf(name: string, response: Response, gateway: string | null): Promise<Uint8Array> {
  if (!response.ok) return failed(name, response, gateway);
  const type = response.headers.get("content-type") ?? "";
  // Audio in another format (PCM, WAV) would reach Telegram as a file, not a voice message.
  if (type && !/audio\/(mpeg|mp3)|octet-stream/.test(type)) throw new Error(`${name} answered ${type}, not MP3`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Cartesia wants the language; read from the script, else left to its default. */
function languageOf(text: string): string | undefined {
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[가-힯]/.test(text)) return "ko";
  if (/\p{Script=Han}/u.test(text)) return "zh";
  return undefined;
}

/** How replies are spoken with these settings; null when voice messages are off or a setting is missing. */
export function speaker(env: Env): Speak | null {
  const provider = providerOf(env);
  if (!provider || speakingGap(env)) return null;
  const key = env.VOICE_API_KEY?.trim() ?? "";
  const voice = env.VOICE_ID?.trim() ?? "";
  const model = modelOf(env, provider);
  const gateway = keyFromGateway(env);
  const send = sender(env);
  const post = (endpoint: string, headers: Record<string, string>, body: unknown) =>
    send(provider, endpoint, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  // Empty: AI Gateway puts in the key stored for this provider.
  const bearer: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};

  const speak: Record<VoiceProvider, (text: string, style?: string) => Promise<Uint8Array>> = {
    async openrouter(text, style) {
      const body = { model, input: text, ...(voice ? { voice } : {}), ...(style ? { instructions: style } : {}), response_format: "mp3" };
      return audioOf("OpenRouter", await post("v1/audio/speech", bearer, body), gateway);
    },
    async elevenlabs(text) {
      const endpoint = `v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`;
      const headers = { accept: "audio/mpeg", ...(key ? { "xi-api-key": key } : {}) };
      return audioOf("ElevenLabs", await post(endpoint, headers, { text, model_id: model }), gateway);
    },
    async cartesia(text) {
      const language = languageOf(text);
      const body = {
        model_id: model,
        transcript: text,
        voice: { mode: "id", id: voice },
        output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
        ...(language ? { language } : {})
      };
      return audioOf("Cartesia", await post("tts/bytes", { ...bearer, "cartesia-version": CARTESIA_VERSION }, body), gateway);
    }
  };
  return async (text, options) => {
    const audio = await speak[provider](text, options?.style?.trim() || undefined);
    if (!audio.length) throw new Error(`${provider} sent back no audio`);
    return { audio, seconds: mp3Seconds(audio) };
  };
}

// MPEG-1 and MPEG-2 layer III bitrates in kbit/s, by the header's index.
const BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
};

/** How long an MP3 plays, from its first frame's bitrate (the providers send constant bitrate). 0 when unknown. */
export function mp3Seconds(bytes: Uint8Array): number {
  let at = 0;
  // An ID3v2 tag in front: "ID3", version, flags, then its size in four 7-bit bytes.
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 && bytes.length > 10) {
    at = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]);
  }
  for (const end = Math.min(bytes.length - 4, at + 4096); at < end; at += 1) {
    if (bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) continue;
    const version = (bytes[at + 1] >> 3) & 3;
    const kbps = BITRATES[version === 3 ? 1 : 2][bytes[at + 2] >> 4];
    if (!kbps || ((bytes[at + 1] >> 1) & 3) !== 1) continue;
    return ((bytes.length - at) * 8) / (kbps * 1000);
  }
  return 0;
}

/** The reply as it is said: no links, markdown or emoji. The voice model's own marks stay. */
export function speakable(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*(?:#{1,6}|>)\s+/gm, "")
    .replace(/[*`~]+/g, "")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** The reply as text, without the voice model's marks: for when it could not be spoken after all. */
export function unmarked(text: string, dialect: Dialect): string {
  return dialect.strip ? text.replace(dialect.strip, "").replace(/[^\S\n]{2,}/g, " ").trim() : text;
}

/** Whether a reply has something only text can carry, so it is posted as text after its voice message. */
export function needsText(text: string): boolean {
  return /https?:\/\//.test(text);
}

/** The lines added to the system prompt; empty while voice messages are off or not set up. */
export function voiceRules(env: Env): string {
  if (!speaker(env)) return "";
  const { marks } = dialectOf(env);
  const say = "write it the way you would say it, with no emoji, links or markdown.";
  switch (replyOf(env)) {
    case "always":
      return `- Your replies are sent as voice messages: ${say}${marks ? ` ${marks}` : ""}`;
    case "tool":
      return `- Your replies are sent as text. To send a voice message, use send_voice.${marks ? ` In it: ${marks}` : ""}`;
    default:
      return `- A message of theirs marked [voice …] was a voice message, and your reply to one is sent as a voice message: ${say}${marks ? ` ${marks}` : ""} At other times you can send one with send_voice.`;
  }
}
