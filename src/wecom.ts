// The WeCom (企业微信) door: a self-built app of her own enterprise, whose messages also show in WeChat through
// WeCom's WeChat plug-in (微信插件). Off until its settings are filled in.
//   - WeCom pushes what she sends to POST /messengers/wecom/webhook, signed and AES-encrypted with the app's Token
//     and EncodingAESKey; a GET there is WeCom checking the address once, when the app's message URL is saved.
//   - Everything going back (text, pictures, voice messages, her files coming down) is a WeCom API call, and WeCom
//     takes those only from the app's trusted IPs. A Worker has no fixed address, so they go through the relay
//     (relay/wecom/) on a machine that has one, with the relay key in X-Relay-Key.
//   - WeCom voice messages are AMR, which a Worker cannot make or read: the relay converts them when it was
//     installed with --media. Without that, voice replies go out as text.

import {
  Message,
  parseMarkdown,
  toPlainText,
  type Adapter,
  type AdapterPostableMessage,
  type Attachment,
  type ChatInstance,
  type FetchResult,
  type FormattedContent,
  type RawMessage,
  type ThreadInfo,
  type WebhookOptions
} from "chat";

const API_TIMEOUT_MS = 20_000;
/** WeCom's limit for one text message, in UTF-8 bytes. */
export const TEXT_MAX_BYTES = 2048;
/** Pushes older than this are not taken (a replayed one). */
const PUSH_MAX_AGE_SECONDS = 60 * 60;
const PUSH_MAX_BYTES = 64 * 1024;
/** What comes down from WeCom: pictures and voice messages are far smaller. */
const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
const TOKEN_KEY = "wecom_token";
// An access token that expired or was replaced: fetch a new one and try once more.
const TOKEN_ERRORS = new Set([40001, 40014, 42001]);
const ABILITIES_TTL_MS = 10 * 60_000;

export type WecomConfig = {
  corpId: string;
  agentId: string;
  secret: string;
  token: string;
  aesKey: string;
  relay: string;
  relayKey: string;
  /** Lower-cased UserIDs that may talk to it. Empty lets nobody in. */
  allowed: string[];
};

/** The settings the door needs, in the order the settings page shows them. WECOM_ALLOWED is extra. */
export const WECOM_KEYS = [
  "WECOM_CORP_ID",
  "WECOM_AGENT_ID",
  "WECOM_SECRET",
  "WECOM_RELAY_URL",
  "WECOM_RELAY_KEY",
  "WECOM_TOKEN",
  "WECOM_AES_KEY"
] as const;
/** Enough to open what WeCom pushes, and to answer its check of the address (which comes before the relay works). */
const OPENING_KEYS = ["WECOM_CORP_ID", "WECOM_TOKEN", "WECOM_AES_KEY"] as const;

function allowedOf(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,，\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The door's settings, or null while what opens a push (CorpID, Token, EncodingAESKey) is missing. Sending needs the
 * rest too (canSend).
 */
export function wecomConfig(env: Env): WecomConfig | null {
  const value = (key: (typeof WECOM_KEYS)[number]) => String(env[key] ?? "").trim();
  if (OPENING_KEYS.some((key) => !value(key))) return null;
  return {
    corpId: value("WECOM_CORP_ID"),
    agentId: value("WECOM_AGENT_ID"),
    secret: value("WECOM_SECRET"),
    token: value("WECOM_TOKEN"),
    aesKey: value("WECOM_AES_KEY"),
    relay: value("WECOM_RELAY_URL").replace(/\/+$/, ""),
    relayKey: value("WECOM_RELAY_KEY"),
    allowed: allowedOf(env.WECOM_ALLOWED)
  };
}

/** Whether messages can go out: the app's AgentId and Secret, and the relay. */
export function canSend(config: WecomConfig | null): config is WecomConfig {
  return Boolean(config && config.agentId && config.secret && config.relay && config.relayKey);
}

/** "off" when none of the door's settings is filled in, the first one missing, or null when it is set up. */
export function wecomGap(env: Env): string | null {
  const missing = WECOM_KEYS.filter((key) => !String(env[key] ?? "").trim());
  if (missing.length === WECOM_KEYS.length) return "off";
  return missing[0] ?? null;
}

/** Her UserID in a WeCom thread id ("wecom:ZhangSan"); null for anything else. */
export function userOf(threadId: string): string | null {
  return threadId.match(/^wecom:([^:\s]+)$/)?.[1] ?? null;
}

export function isWecomAllowed(config: WecomConfig, user: string): boolean {
  return config.allowed.includes(user.toLowerCase());
}

// ---- the push: signature, AES, XML ----

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function joined(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Equal, in a time that does not tell how much of it matched. */
function sameText(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) return false;
  let differ = 0;
  for (let i = 0; i < left.length; i++) differ |= left[i] ^ right[i];
  return differ === 0;
}

/** WeCom's msg_signature: SHA-1 of the token, timestamp, nonce and encrypted text, sorted and put together. */
export async function wecomSignature(token: string, timestamp: string, nonce: string, encrypted: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-1", encoder.encode([token, timestamp, nonce, encrypted].sort().join(""))));
}

/**
 * What WeCom encrypted: 16 random bytes, the message's length (4 bytes, big-endian), the message, and the CorpID it
 * is for, padded PKCS#7-style to 32 bytes. Throws when it does not open, or is for another enterprise.
 */
export async function wecomDecrypt(aesKey: string, encrypted: string, corpId: string): Promise<string> {
  let key: Uint8Array;
  try {
    key = fromBase64(`${aesKey}=`);
  } catch {
    key = new Uint8Array(0);
  }
  if (key.length !== 32) throw new Error("the EncodingAESKey is not 43 characters of base64");
  const data = fromBase64(encrypted.replace(/ /g, "+"));
  if (!data.length || data.length % 16) throw new Error("not a whole number of AES blocks");
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
  // WebCrypto only takes off 16-byte padding, and WeCom's is up to 32 bytes. One more block that decrypts to a full
  // block of 16-byte padding goes on the end: WebCrypto takes that off, and WeCom's padding is left for us.
  const extra = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: data.slice(-16) }, cryptoKey, new Uint8Array(16).fill(16))).slice(0, 16);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: key.slice(0, 16) }, cryptoKey, joined(data, extra)));
  const pad = plain[plain.length - 1];
  if (!pad || pad > 32 || pad > plain.length - 20) throw new Error("bad padding");
  const body = plain.subarray(16, plain.length - pad);
  const length = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0);
  if (4 + length > body.length) throw new Error("bad length");
  const message = decoder.decode(body.subarray(4, 4 + length));
  if (decoder.decode(body.subarray(4 + length)) !== corpId) throw new Error("for another enterprise (CorpID does not match)");
  return message;
}

function unescapeXml(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (entity, name: string) => {
    const named: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
    if (named[name.toLowerCase()]) return named[name.toLowerCase()];
    const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
  });
}

/** The fields of a WeCom XML message, flat: <Content><![CDATA[hi]]></Content> → { Content: "hi" }. */
export function xmlFields(xml: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of xml.matchAll(/<([A-Za-z_][\w.-]*)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g)) {
    if (!(match[1] in fields)) fields[match[1]] = match[2] ?? unescapeXml(match[3] ?? "");
  }
  return fields;
}

type Signed = { signature: string; timestamp: string; nonce: string };

function signedOf(params: URLSearchParams): Signed | null {
  const signature = params.get("msg_signature") ?? "";
  const timestamp = params.get("timestamp") ?? "";
  const nonce = params.get("nonce") ?? "";
  return signature && timestamp && nonce ? { signature, timestamp, nonce } : null;
}

async function opened(config: WecomConfig, signed: Signed, encrypted: string): Promise<string | null> {
  const age = Math.abs(Date.now() / 1000 - Number(signed.timestamp));
  if (!Number.isFinite(age) || age > PUSH_MAX_AGE_SECONDS) return null;
  if (!sameText(await wecomSignature(config.token, signed.timestamp, signed.nonce, encrypted), signed.signature)) return null;
  try {
    return await wecomDecrypt(config.aesKey, encrypted, config.corpId);
  } catch (error) {
    console.error("wecom: a push did not open", { error: String(error) });
    return null;
  }
}

/**
 * WeCom checking the app's message URL (a GET with echostr): the opened echostr, as WeCom wants it back. Anything
 * else is refused.
 */
export async function wecomVerify(config: WecomConfig | null, params: URLSearchParams): Promise<{ status: number; body: string }> {
  if (!config) return { status: 404, body: "WeCom is not set up on this resident" };
  const signed = signedOf(params);
  const echo = (params.get("echostr") ?? "").replace(/ /g, "+");
  if (!signed || !echo) return { status: 400, body: "missing msg_signature, timestamp, nonce or echostr" };
  const plain = await opened(config, signed, echo);
  return plain === null ? { status: 403, body: "forbidden" } : { status: 200, body: plain };
}

/** What she sent, as text and attachments; null for what is not a message to answer (events, unknown types). */
export function readPush(fields: Record<string, string>): { text: string; attachments: Attachment[] } | null {
  const media = (type: Attachment["type"], mimeType: string): Attachment => ({
    type,
    mimeType,
    name: `${type}-${fields.MediaId}`,
    fetchMetadata: { fileId: fields.MediaId }
  });
  switch (fields.MsgType) {
    case "text":
      return fields.Content?.trim() ? { text: fields.Content, attachments: [] } : null;
    case "image":
      return fields.MediaId ? { text: "", attachments: [media("image", "image/jpeg")] } : null;
    case "voice":
      return fields.MediaId ? { text: "", attachments: [media("audio", `audio/${(fields.Format || "amr").toLowerCase()}`)] } : null;
    case "video":
      return fields.MediaId ? { text: "", attachments: [media("video", "video/mp4")] } : null;
    case "location": {
      const where = [fields.Label, fields.Location_X && fields.Location_Y ? `(${fields.Location_X}, ${fields.Location_Y})` : ""].filter(Boolean).join(" ");
      return where ? { text: `[location] ${where}`, attachments: [] } : null;
    }
    case "link": {
      const lines = [fields.Title, fields.Description, fields.Url].filter((line) => line?.trim());
      return lines.length ? { text: `[link] ${lines.join("\n")}`, attachments: [] } : null;
    }
    default:
      return null;
  }
}

// ---- text going out ----

/**
 * A reply as WeChat shows it: no markdown there, so the marks that would show as clutter come off. Single * and `
 * stay, since kaomoji use them.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^[^\S\n]*```[^\n]*\n?/gm, "")
    .replace(/^[^\S\n]{0,3}#{1,6}[^\S\n]+/gm, "")
    .replace(/^[^\S\n]{0,3}>[^\S\n]?/gm, "")
    .replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)[^)\n]*\)/g, (_, label: string, url: string) => (label === url ? url : `${label} ${url}`))
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "$1")
    .replace(/__(?=\S)([^\n]*?\S)__/g, "$1")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "$1")
    .replace(/^([^\S\n]*)[*+][^\S\n]+/gm, "$1- ")
    .trim();
}

function utf8Size(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}

/** Text cut into WeCom-sized pieces (2048 UTF-8 bytes), at a line break, a full stop or a space when there is one. */
export function byteChunks(text: string, limit = TEXT_MAX_BYTES): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (encoder.encode(rest).length > limit) {
    let bytes = 0;
    let end = 0;
    for (const char of rest) {
      const size = utf8Size(char);
      if (bytes + size > limit) break;
      bytes += size;
      end += char.length;
    }
    const window = rest.slice(0, end);
    const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf("。"), window.lastIndexOf(" "));
    const at = cut > end / 2 ? cut + 1 : end;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function textOfPostable(message: AdapterPostableMessage): string {
  if (typeof message === "string") return message;
  if ("markdown" in message && typeof message.markdown === "string") return message.markdown;
  if ("raw" in message && typeof message.raw === "string") return message.raw;
  if ("ast" in message && message.ast) return toPlainText(message.ast);
  return "";
}

// ---- the API, through the relay ----

export class WecomError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

/** What a WeCom error means for her, for the status page; the code and WeCom's words when there is no better one. */
export function wecomProblem(error: unknown): string {
  if (!(error instanceof WecomError)) return (error instanceof Error ? error.message : String(error)).slice(0, 300);
  const hints: Record<number, string> = {
    60020: "企业微信不认这台转发机的 IP：把转发机的出口 IP 填进应用的「企业可信 IP」",
    40013: "企业 ID（CorpID）不对",
    40001: "应用 Secret 不对",
    40056: "AgentId 不对",
    301002: "AgentId 和 Secret 不是同一个应用的",
    81013: "这个账号不在应用的可见范围里",
    45009: "调用太频繁，企业微信限流了",
    45033: "调用太频繁，企业微信限流了"
  };
  return `${hints[error.code] ?? error.message}（${error.code}）`.slice(0, 300);
}

/** Where the token is kept between turns: the resident's own storage. */
export type TokenStore = {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
};

export type Abilities = { amr: boolean; mp3: boolean; gif: boolean; png: boolean };

type Answer = { errcode?: number; errmsg?: string; [key: string]: unknown };

export class WecomApi {
  #abilities: { at: number; value: Abilities | null } | null = null;

  constructor(
    private readonly config: () => WecomConfig | null,
    private readonly store: TokenStore,
    /** Told what went wrong with a message going out or a file coming down, and null once one goes through. */
    private readonly report?: (problem: string | null) => void
  ) {}

  private async reported<T>(work: () => Promise<T>): Promise<T> {
    try {
      const done = await work();
      this.report?.(null);
      return done;
    } catch (error) {
      this.report?.(wecomProblem(error));
      throw error;
    }
  }

  private need(): WecomConfig {
    const config = this.config();
    if (!canSend(config)) throw new Error("企业微信还没接好：设置页里还有没填的");
    return config;
  }

  /** One request to the relay, with its key. */
  private async relay(path: string, init: RequestInit = {}): Promise<Response> {
    const config = this.need();
    const headers = new Headers(init.headers);
    headers.set("x-relay-key", config.relayKey);
    const response = await fetch(`${config.relay}${path}`, { ...init, headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    if (response.status === 403) throw new Error("转发机不认这把钥匙：设置页的「转发钥匙」跟转发机上的不一样");
    return response;
  }

  private async answer(response: Response): Promise<Answer> {
    const body = (await response.json().catch(() => null)) as Answer | null;
    if (!body) throw new Error(`转发机回了 HTTP ${response.status}，不是企业微信的回答`);
    if (body.errcode) throw new WecomError(body.errcode, body.errmsg ?? "WeCom error");
    return body;
  }

  private async token(fresh = false): Promise<string> {
    const config = this.need();
    // Kept for the app it was asked for: another CorpID, AgentId or Secret asks again.
    const secret = hex(await crypto.subtle.digest("SHA-256", encoder.encode(config.secret))).slice(0, 16);
    const owner = `${config.corpId}/${config.agentId}/${secret}`;
    const saved = (await this.store.get(TOKEN_KEY)) as { token: string; until: number; owner: string } | undefined;
    if (!fresh && saved && saved.owner === owner && saved.until > Date.now()) return saved.token;
    const query = new URLSearchParams({ corpid: config.corpId, corpsecret: config.secret });
    const body = await this.answer(await this.relay(`/cgi-bin/gettoken?${query}`));
    const token = String(body.access_token ?? "");
    if (!token) throw new Error("企业微信没给 access_token");
    const seconds = Number(body.expires_in) || 7200;
    await this.store.put(TOKEN_KEY, { token, until: Date.now() + Math.max(60, seconds - 300) * 1000, owner });
    return token;
  }

  /** A call with the access token, once more with a new token when WeCom says the old one is no good. */
  private async withToken<T>(run: (token: string) => Promise<T>): Promise<T> {
    try {
      return await run(await this.token());
    } catch (error) {
      if (error instanceof WecomError && TOKEN_ERRORS.has(error.code)) return run(await this.token(true));
      throw error;
    }
  }

  private async send(user: string, payload: Record<string, unknown>): Promise<string> {
    const config = this.need();
    return this.reported(() => this.withToken(async (token) => {
      const body = await this.answer(
        await this.relay(`/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ touser: user, agentid: Number(config.agentId), safe: 0, ...payload })
        })
      );
      return String(body.msgid ?? "");
    }));
  }

  /** One text message (at most 2048 bytes: cut longer text with byteChunks first). Returns its msgid. */
  sendText(user: string, text: string): Promise<string> {
    return this.send(user, { msgtype: "text", text: { content: text } });
  }

  /** A picture (JPG, PNG or GIF), a voice message (AMR) or a file as one message. */
  async sendFile(user: string, kind: "image" | "voice" | "file", file: { bytes: Uint8Array; type: string; name: string }): Promise<string> {
    const mediaId = await this.reported(() => this.upload(kind, file));
    return this.send(user, { msgtype: kind, [kind]: { media_id: mediaId } });
  }

  /** A file into WeCom's temporary media (kept 3 days), for one message. Returns its media_id. */
  private upload(kind: "image" | "voice" | "file", file: { bytes: Uint8Array; type: string; name: string }): Promise<string> {
    return this.withToken(async (token) => {
      // Built by hand: WeCom wants filelength in the part's header, and the relay gets one body of known length.
      const boundary = `----resident${crypto.randomUUID().replace(/-/g, "")}`;
      const head = `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${file.name}"; filelength=${file.bytes.length}\r\nContent-Type: ${file.type}\r\n\r\n`;
      const body = joined(encoder.encode(head), file.bytes, encoder.encode(`\r\n--${boundary}--\r\n`));
      const answer = await this.answer(
        await this.relay(`/cgi-bin/media/upload?access_token=${encodeURIComponent(token)}&type=${kind}`, {
          method: "POST",
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
          body
        })
      );
      const id = String(answer.media_id ?? "");
      if (!id) throw new Error("企业微信没给 media_id");
      return id;
    });
  }

  /** A file she sent (a picture, a voice message), by its MediaId. */
  download(mediaId: string): Promise<Uint8Array> {
    return this.reported(() => this.withToken(async (token) => {
      const response = await this.relay(`/cgi-bin/media/get?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(mediaId)}`);
      const type = response.headers.get("content-type") ?? "";
      // An error comes back as JSON (or text) instead of the file.
      if (/json|text\/plain/i.test(type)) {
        await this.answer(response);
        throw new Error("企业微信没给文件");
      }
      if (!response.ok) throw new Error(`转发机回了 HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > DOWNLOAD_MAX_BYTES) throw new Error("文件太大");
      return bytes;
    }));
  }

  /** Taking a message back (WeCom allows it for 24 hours). */
  recall(msgid: string): Promise<void> {
    return this.withToken(async (token) => {
      await this.answer(
        await this.relay(`/cgi-bin/message/recall?access_token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ msgid })
        })
      );
    });
  }

  /** What the relay converts (installed with --media), asked at most every 10 minutes; null when it cannot be asked. */
  async abilities(): Promise<Abilities | null> {
    if (this.#abilities && Date.now() - this.#abilities.at < ABILITIES_TTL_MS) return this.#abilities.value;
    let value: Abilities | null = null;
    try {
      const response = await this.relay("/ping");
      const body = (await response.json().catch(() => null)) as { ok?: boolean; media?: Partial<Abilities> } | null;
      if (body?.ok) value = { amr: Boolean(body.media?.amr), mp3: Boolean(body.media?.mp3), gif: Boolean(body.media?.gif), png: Boolean(body.media?.png) };
    } catch (error) {
      console.error("wecom: the relay did not answer /ping", { error: String(error) });
    }
    this.#abilities = { at: Date.now(), value };
    return value;
  }

  /** What was known about the relay the last time it was asked, without asking. */
  knownAbilities(): Abilities | null {
    return this.#abilities?.value ?? null;
  }

  /** A file converted by the relay (amr, mp3, gif or png). Throws when it cannot. */
  async convert(to: keyof Abilities, bytes: Uint8Array): Promise<Uint8Array> {
    const response = await this.relay(`/media/${to}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(`转发机没能转成 ${to}：${body?.error ?? `HTTP ${response.status}`}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

// ---- the Chat SDK adapter ----

/** A push, as the adapter keeps it: its XML fields. */
export type WecomPush = Record<string, string>;

export type WecomAdapterOptions = {
  config: () => WecomConfig | null;
  api: WecomApi;
  userName: string;
  /** Keeps the work a push starts going after the push is answered. */
  waitUntil: (work: Promise<unknown>) => void;
  /** A slash command (/status, /letter, …): its answer, sent as text. */
  command: (name: string) => Promise<string>;
  /** Someone not in WECOM_ALLOWED wrote: no reply, but the settings page shows their UserID. */
  refused: (user: string) => Promise<void>;
};

/** "/status" → "status"; anything else → null. */
function commandOf(text: string): string | null {
  return text.trim().match(/^\/([a-z_]+)(?:\s|$)/i)?.[1]?.toLowerCase() ?? null;
}

/**
 * Her messages in, and replies out as WeCom text messages. One thread per person ("wecom:<UserID>"), always a direct
 * message. WeCom has no typing indicator, reactions or edits.
 */
export class WecomAdapter implements Adapter<{ user: string }, WecomPush> {
  readonly name = "wecom";
  readonly userName: string;
  #chat: ChatInstance | null = null;
  /** Set by useBubbles (telegram.ts): replies go out a paragraph at a time. */
  stream?: Adapter<{ user: string }, WecomPush>["stream"];

  constructor(private readonly options: WecomAdapterOptions) {
    this.userName = options.userName;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.#chat = chat;
  }

  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    const ok = () => new Response("", { status: 200 });
    const config = this.options.config();
    if (!config) return new Response("WeCom is not set up on this resident", { status: 404 });
    const signed = signedOf(new URL(request.url).searchParams);
    const body = await request.text();
    if (!signed || body.length > PUSH_MAX_BYTES) return new Response("bad request", { status: 400 });
    const encrypted = xmlFields(body).Encrypt;
    const xml = encrypted ? await opened(config, signed, encrypted) : null;
    if (xml === null) return new Response("forbidden", { status: 403 });
    const fields = xmlFields(xml);
    const user = fields.FromUserName ?? "";
    // Another app of the same enterprise sending here, or an event (entering the app and the like): nothing to say.
    if (!user || (fields.AgentID && config.agentId && fields.AgentID !== config.agentId) || fields.MsgType === "event") return ok();
    if (!isWecomAllowed(config, user)) {
      console.log("wecom: dropped a message from someone not in WECOM_ALLOWED", { user });
      this.options.waitUntil(this.options.refused(user).catch(() => undefined));
      return ok();
    }
    if (!canSend(config)) {
      console.log("wecom: a message came, but nothing can go back yet (AgentId, Secret or the relay is missing)");
      return ok();
    }
    const read = readPush(fields);
    if (!read) return ok();
    const command = read.attachments.length ? null : commandOf(read.text);
    if (command) {
      // Answered without a model turn, as on Telegram.
      this.options.waitUntil(
        this.options
          .command(command)
          .then(async (text) => {
            for (const chunk of byteChunks(plainText(text))) await this.options.api.sendText(user, chunk);
          })
          .catch((error) => console.error("wecom: command failed", { command, error: wecomProblem(error) }))
      );
      return ok();
    }
    if (!this.#chat) return ok();
    const message = this.toMessage(fields, read);
    this.options.waitUntil(
      this.#chat.processMessage(this, message.threadId, message, options).catch((error) => console.error("wecom: message not handled", { error: String(error) }))
    );
    return ok();
  }

  private toMessage(fields: WecomPush, read: { text: string; attachments: Attachment[] }): Message<WecomPush> {
    const user = fields.FromUserName ?? "";
    const sent = Number(fields.CreateTime);
    return new Message<WecomPush>({
      // WeCom sends a push again when the answer is slow; the same MsgId is dropped by the Chat SDK.
      id: fields.MsgId || `${user}:${fields.CreateTime}:${fields.MsgType}`,
      threadId: this.encodeThreadId({ user }),
      text: read.text,
      formatted: parseMarkdown(read.text),
      raw: fields,
      author: { userId: user, userName: user, fullName: user, isBot: false, isMe: false },
      metadata: { dateSent: Number.isFinite(sent) && sent > 0 ? new Date(sent * 1000) : new Date(), edited: false },
      attachments: read.attachments.map((attachment) => ({
        ...attachment,
        fetchData: async () => {
          const bytes = await this.options.api.download(attachment.fetchMetadata!.fileId);
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        }
      })),
      isMention: false
    });
  }

  async postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage<WecomPush>> {
    const user = userOf(threadId);
    if (!user) throw new Error(`not a WeCom thread: ${threadId}`);
    let id = "";
    for (const chunk of byteChunks(plainText(textOfPostable(message)))) id = await this.options.api.sendText(user, chunk);
    return { id: id || `none-${Date.now()}`, threadId, raw: {} };
  }

  /** WeCom cannot edit a message: the new text goes out as another one. */
  editMessage(threadId: string, _messageId: string, message: AdapterPostableMessage): Promise<RawMessage<WecomPush>> {
    return this.postMessage(threadId, message);
  }

  async deleteMessage(_threadId: string, messageId: string): Promise<void> {
    if (!messageId.startsWith("none-")) await this.options.api.recall(messageId);
  }

  async addReaction(): Promise<void> {}

  async removeReaction(): Promise<void> {}

  async startTyping(): Promise<void> {}

  async fetchMessages(): Promise<FetchResult<WecomPush>> {
    return { messages: [] };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    return { id: threadId, channelId: threadId, isDM: true, metadata: {} };
  }

  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  isDM(): boolean {
    return true;
  }

  async openDM(userId: string): Promise<string> {
    return this.encodeThreadId({ user: userId });
  }

  encodeThreadId({ user }: { user: string }): string {
    return `wecom:${user}`;
  }

  decodeThreadId(threadId: string): { user: string } {
    const user = userOf(threadId);
    if (!user) throw new Error(`not a WeCom thread: ${threadId}`);
    return { user };
  }

  parseMessage(raw: WecomPush): Message<WecomPush> {
    return this.toMessage(raw, readPush(raw) ?? { text: raw.Content ?? "", attachments: [] });
  }

  renderFormatted(content: FormattedContent): string {
    return toPlainText(content);
  }
}
