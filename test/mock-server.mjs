// Stands in for the Telegram Bot API, Aelios and other MCP servers during local tests. Records every call.
import http from "node:http";

const log = [];
let nextMessageId = 1000;
const ORIGIN = "http://127.0.0.1:9999";

// Other MCP servers: /ext and /ext2 are open, /keyed wants x-api-key: k1, /oauth wants a token from its sign-in.
// echo's descriptions are long on purpose, and one of its parameters is called title, which must survive trimming.
const TOOLS = [
  {
    name: "echo",
    description: `Echo the text back. ${"It says it again. ".repeat(30)}\n\nUsage notes nobody needs every turn.`,
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      title: "EchoArgs",
      properties: {
        text: { type: "string", description: `What to echo. ${"More words. ".repeat(30)}` },
        title: { type: "string", description: "A parameter that happens to be called title." }
      },
      required: ["text"]
    }
  },
  { name: "add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } }
];

function mcpServer(name, req, res, json) {
  const send = (status, obj, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(obj === undefined ? "" : JSON.stringify(obj));
  };
  if (req.method !== "POST") return send(405, { error: "method not allowed" });
  const messages = Array.isArray(json) ? json : [json];
  const answers = [];
  for (const message of messages) {
    if (!message || message.id === undefined) continue;
    const result = (() => {
      switch (message.method) {
        case "initialize":
          return { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name, version: "1.0.0" } };
        case "ping":
          return {};
        case "tools/list":
          return { tools: TOOLS };
        case "tools/call": {
          const args = message.params?.arguments ?? {};
          if (message.params?.name === "echo") return { content: [{ type: "text", text: `${name} echo: ${args.text}` }] };
          if (message.params?.name === "add") return { content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }] };
          return { content: [{ type: "text", text: "no such tool" }], isError: true };
        }
        default:
          return null;
      }
    })();
    answers.push(result ? { jsonrpc: "2.0", id: message.id, result } : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
  if (!answers.length) return send(202);
  return send(200, Array.isArray(json) ? answers : answers[0]);
}

const authServer = {
  issuer: `${ORIGIN}/oauth`,
  authorization_endpoint: `${ORIGIN}/oauth/authorize`,
  token_endpoint: `${ORIGIN}/oauth/token`,
  registration_endpoint: `${ORIGIN}/oauth/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"]
};

// A Telegram sticker pack: a still sticker, a video one and an animated (TGS) one, which only has a thumbnail to show.
const STICKER_SET = {
  name: "TestPack",
  title: "Test Pack",
  sticker_type: "regular",
  stickers: [
    { file_id: "tg-still", emoji: "😀", is_animated: false, is_video: false },
    { file_id: "tg-video", emoji: "🥰", is_animated: false, is_video: true },
    { file_id: "tg-anim", emoji: "😴", is_animated: true, is_video: false, thumbnail: { file_id: "tg-anim-thumb" } }
  ]
};
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([20, 0, 0, 0]), Buffer.from("WEBPVP8L"), Buffer.alloc(12)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16)]);
// A voice message she sends (Ogg), and one second of 128 kbit/s MP3 behind an ID3 tag, as the voice providers send.
const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(28)]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(16000 - 4)]);

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const body = raw.toString();
  let json;
  try {
    json = body ? JSON.parse(body) : undefined;
  } catch {
    // The OAuth token request is a form; a file upload to Telegram is multipart.
    json = undefined;
  }
  // A multipart upload (sendSticker and the like): its fields, and for each file its name, type and first bytes.
  if (!json && /multipart\/form-data/.test(req.headers["content-type"] ?? "")) {
    const form = await new Response(raw, { headers: { "content-type": req.headers["content-type"] } }).formData();
    json = { multipart: true };
    for (const [key, value] of form) {
      json[key] = typeof value === "string" ? value : { file: value.name, type: value.type, size: value.size, head: Buffer.from(await value.arrayBuffer()).subarray(0, 6).toString("latin1") };
    }
  }
  const url = new URL(req.url, "http://x");
  const reply = (obj, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === "/__log") return reply(log);
  if (url.pathname === "/__reset") {
    log.length = 0;
    return reply({ ok: true });
  }

  // A file the bot downloads after getFile: a few bytes that start like a JPEG, or a sticker's WebP or WebM.
  const file = url.pathname.match(/^\/file\/bot[^/]+\/(.+)$/);
  if (file) {
    log.push({ kind: "tg.file", path: file[1] });
    if (file[1].endsWith(".webp")) {
      res.writeHead(200, { "content-type": "image/webp" });
      return res.end(WEBP);
    }
    if (file[1].endsWith(".oga")) {
      res.writeHead(200, { "content-type": "audio/ogg" });
      return res.end(OGG);
    }
    if (file[1].endsWith(".webm")) {
      res.writeHead(200, { "content-type": "video/webm" });
      return res.end(WEBM);
    }
    res.writeHead(200, { "content-type": "image/jpeg" });
    return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]));
  }

  const tg = url.pathname.match(/^\/bot[^/]+\/(\w+)$/);
  if (tg) {
    const method = tg[1];
    log.push({ kind: `tg.${method}`, body: json });
    const chat = { id: Number(json?.chat_id ?? 42), type: "private" };
    const message = () => ({ message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat, text: json?.text });
    switch (method) {
      case "getMe":
        return reply({ ok: true, result: { id: 777, is_bot: true, first_name: "Resident", username: "resident_test_bot" } });
      case "sendMessage":
      case "editMessageText":
        return reply({ ok: true, result: message() });
      case "getFile": {
        // "gone" stands for a file Telegram no longer has.
        if (json?.file_id === "gone") return reply({ ok: false, error_code: 400, description: "Bad Request: invalid file_id" }, 400);
        const id = String(json?.file_id ?? "");
        const path = id === "tg-video" ? `stickers/${id}.webm` : id.startsWith("tg-") ? `stickers/${id}.webp` : id.startsWith("voice-") ? `voice/${id}.oga` : `photos/${id}.jpg`;
        return reply({ ok: true, result: { file_id: id, file_path: path } });
      }
      case "getStickerSet":
        if (json?.name !== STICKER_SET.name) return reply({ ok: false, error_code: 400, description: "Bad Request: STICKERSET_INVALID" }, 400);
        return reply({ ok: true, result: STICKER_SET });
      case "sendSticker":
      case "sendAnimation":
      case "sendPhoto": {
        const field = { sendSticker: "sticker", sendAnimation: "animation", sendPhoto: "photo" }[method];
        // "stale-…" stands for a file id Telegram no longer takes.
        if (typeof json?.[field] === "string" && json[field].startsWith("stale-")) {
          return reply({ ok: false, error_code: 400, description: "Bad Request: wrong file identifier" }, 400);
        }
        // An uploaded WebP that is no proper sticker (not 512 pixels): Telegram will not take it as one.
        if (method === "sendSticker" && json?.multipart && json.sticker?.type === "image/webp") {
          return reply({ ok: false, error_code: 400, description: "Bad Request: STICKER_PNG_DIMENSIONS" }, 400);
        }
        const id = typeof json?.[field] === "string" ? json[field] : `up-${method}-${nextMessageId}`;
        const media = method === "sendSticker" ? { sticker: { file_id: id } } : method === "sendAnimation" ? { animation: { file_id: id }, document: { file_id: id } } : { photo: [{ file_id: `${id}-s` }, { file_id: id }] };
        return reply({ ok: true, result: { message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat, ...media } });
      }
      case "sendVoice":
        return reply({ ok: true, result: { message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat, voice: { file_id: `up-voice-${nextMessageId}`, duration: Number(json?.duration ?? 0) } } });
      case "sendChatAction":
      case "setWebhook":
      case "setMyCommands":
      case "setChatMenuButton":
        return reply({ ok: true, result: true });
      default:
        // e.g. sendRichMessage: an older Bot API, so the adapter falls back to sendMessage.
        return reply({ ok: false, error_code: 404, description: "Not Found: method not found" }, 404);
    }
  }
  // Voice providers, reached through VOICE_BASE_URL=http://127.0.0.1:9999/voice: ElevenLabs Scribe and text to
  // speech, Cartesia, and OpenRouter's speech endpoint. A text with 炸 in it fails, so the reply goes out as text.
  const voice = url.pathname.match(/^\/voice\/(v1\/speech-to-text|v1\/text-to-speech\/[^/]+|tts\/bytes|v1\/audio\/speech)$/);
  if (voice) {
    const headers = Object.fromEntries(["authorization", "xi-api-key", "cartesia-version", "accept"].filter((h) => req.headers[h]).map((h) => [h, req.headers[h]]));
    log.push({ kind: "voice", endpoint: voice[1], query: url.search, headers, body: json });
    if (voice[1] === "v1/speech-to-text") {
      if (json?.file?.head?.startsWith("OggS")) return reply({ text: " 今天好累呀 " });
      return reply({ detail: "unreadable audio" }, 422);
    }
    const said = json?.text ?? json?.transcript ?? json?.input ?? "";
    if (said.includes("炸")) return reply({ error: { message: "the voice service fell over" } }, 500);
    res.writeHead(200, { "content-type": "audio/mpeg" });
    return res.end(MP3);
  }

  // A scheduled task's API trigger (CLOUD_TASK_API_BASE=http://127.0.0.1:9999): wants the token "good-token" and
  // both headers, and answers with a session link. trig_busyone has fired too often this hour.
  const routine = url.pathname.match(/^\/v1\/claude_code\/routines\/(trig_\w+)\/fire$/);
  if (routine) {
    const headers = Object.fromEntries(["authorization", "anthropic-beta", "anthropic-version"].map((h) => [h, req.headers[h] ?? null]));
    log.push({ kind: "routine.fire", trigger: routine[1], headers, body: json });
    if (req.headers.authorization !== "Bearer good-token") return reply({ type: "error", error: { type: "authentication_error", message: "invalid token" } }, 401);
    if (!req.headers["anthropic-beta"] || !req.headers["anthropic-version"]) return reply({ type: "error", error: { message: "missing header" } }, 400);
    if (routine[1] === "trig_busyone") return reply({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429);
    const n = log.filter((e) => e.kind === "routine.fire").length;
    return reply({ type: "routine_fire", claude_code_session_id: `session_test_${n}`, claude_code_session_url: `https://claude.ai/code/session_test_${n}` });
  }

  const mcp = url.pathname.match(/^\/(ext|ext2|keyed|oauth)\/mcp$/);
  if (mcp) {
    const who = mcp[1];
    log.push({ kind: `ext.${who}`, httpMethod: req.method, method: json?.method ?? null, auth: req.headers.authorization ?? null,
      apiKey: req.headers["x-api-key"] ?? null, tool: json?.params?.name ?? null, args: json?.params?.arguments ?? null });
    if (who === "keyed" && req.headers["x-api-key"] !== "k1") return reply({ error: "a key is needed" }, 403);
    if (who === "oauth" && req.headers.authorization !== "Bearer tok-1") {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/oauth/mcp"` });
      return res.end(JSON.stringify({ error: "invalid_token" }));
    }
    return mcpServer(who, req, res, json);
  }
  if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
    log.push({ kind: "oauth.resource", path: url.pathname });
    return reply({ resource: `${ORIGIN}/oauth/mcp`, authorization_servers: [`${ORIGIN}/oauth`] });
  }
  if (url.pathname.includes("/.well-known/oauth-authorization-server") || url.pathname.includes("/.well-known/openid-configuration")) {
    log.push({ kind: "oauth.metadata", path: url.pathname });
    return reply(authServer);
  }
  if (url.pathname === "/oauth/register") {
    log.push({ kind: "oauth.register", body: json });
    return reply({ ...json, client_id: "cid-1", token_endpoint_auth_method: "none" }, 201);
  }
  if (url.pathname === "/oauth/authorize") {
    // Stands in for her signing in: straight back to the resident with a code.
    log.push({ kind: "oauth.authorize", query: Object.fromEntries(url.searchParams) });
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", "code-1");
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: back.href });
    return res.end();
  }
  if (url.pathname === "/oauth/token") {
    const form = Object.fromEntries(new URLSearchParams(body));
    log.push({ kind: "oauth.token", form });
    if (form.grant_type === "authorization_code" && form.code !== "code-1") return reply({ error: "invalid_grant" }, 400);
    return reply({ access_token: "tok-1", token_type: "Bearer", expires_in: 3600, refresh_token: "ref-1" });
  }
  const auth = req.headers.authorization;
  if (url.pathname === "/v1/memory/recall") {
    log.push({ kind: "aelios.recall", body: json, auth });
    // Only a question about her birthday finds something, so ordinary test messages recall nothing.
    const hit = { id: "mem-birthday", content: "她的生日在春天", type: "fact", score: 0.9 };
    return reply({ data: String(json.query ?? "").includes("生日") ? [hit] : [] });
  }
  // Aelios' own stateless MCP server, answering tools/call with plain JSON.
  if (url.pathname === "/mcp") {
    log.push({ kind: "aelios.mcp", body: json, auth });
    const text = JSON.stringify({ data: { id: "mem-new", created: true } });
    return reply({ jsonrpc: "2.0", id: json.id, result: { content: [{ type: "text", text }] } });
  }
  if (url.pathname === "/v1/memory/ingest") {
    log.push({ kind: "aelios.ingest", body: json, auth });
    return reply({ data: { conversation_id: json.conversation_id, message_ids: [] } });
  }
  if (url.pathname === "/v1/precious") {
    log.push({ kind: "aelios.precious", body: json, auth });
    return reply({ data: { id: "p1", content: json.content } }, 201);
  }
  if (url.pathname === "/v1/memory_boot") {
    log.push({ kind: "aelios.boot", query: url.search, auth });
    // Says how many times it has been fetched, so a test can tell which packet a turn carries.
    const fetched = log.filter((e) => e.kind === "aelios.boot").length;
    return reply({
      data: {
        daily_log: { date: "2026-10-21", title: "闲聊日", summary: `昨天你们聊了周末去哪儿玩。（第 ${fetched} 次取）` },
        precious: [{ content: "说好了要一起去看海。" }],
        glossary: [{ term: "小橘", definition: "楼下那只猫" }]
      }
    });
  }
  // Models: a provider of your own (custom/…), and Aelios' model endpoint (/v1/… or /<identity>/v1/…).
  // Both answer OpenAI chat completions and Anthropic messages with a line saying what they got.
  const textOf = (content) => (typeof content === "string" ? content : (content ?? []).find((p) => p.type === "text")?.text ?? "");
  const sse = (events, headers = {}) => {
    res.writeHead(200, { "content-type": "text/event-stream", ...headers });
    for (const [event, data] of events) res.write(`${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
    res.end();
  };
  const chat = (text, headers = {}) => {
    const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 };
    if (!json.stream) {
      res.writeHead(200, { "content-type": "application/json", ...headers });
      return res.end(JSON.stringify({ id: "c1", object: "chat.completion", created: 0, model: json.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage }));
    }
    const chunk = (delta, finish, extra = {}) => ({ id: "c1", object: "chat.completion.chunk", created: 0, model: json.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
    return sse([[null, chunk({ role: "assistant", content: text }, null)], [null, chunk({}, "stop", { usage })], [null, "[DONE]"]], headers);
  };
  const messages = (text, headers = {}) => {
    const usage = { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    if (!json.stream) {
      res.writeHead(200, { "content-type": "application/json", ...headers });
      return res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: json.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage }));
    }
    return sse([
      ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: json.model, content: [], stop_reason: null, stop_sequence: null, usage } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想一想。" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-test" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } }],
      ["content_block_stop", { type: "content_block_stop", index: 1 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }],
      ["message_stop", { type: "message_stop" }]
    ], headers);
  };
  const said = () => textOf(json.messages.filter((m) => m.role === "user").at(-1)?.content);
  const thinkingCount = () => json.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "thinking").length;
  const cached = () => (Boolean(json.cache_control) || JSON.stringify(json).includes('"cache_control"') ? "有" : "无");

  if (url.pathname === "/custom/v1/chat/completions") {
    log.push({ kind: "custom.chat", auth: req.headers.authorization, body: json });
    return chat(`自己的供应商（OpenAI 格式）收到：${said()}`);
  }
  if (url.pathname === "/custom/v1/messages") {
    log.push({ kind: "custom.messages", apiKey: req.headers["x-api-key"], body: json });
    return messages(`自己的供应商（Anthropic 格式）收到 ${json.messages.length} 条，缓存标记${cached()}，旧思考块 ${thinkingCount()} 个`);
  }
  const gateway = url.pathname.match(/^(?:\/([^/]+))?\/v1\/(messages|chat\/completions)$/);
  if (gateway) {
    const purpose = req.headers["x-aelios-purpose"] ?? null;
    log.push({ kind: `aelios.${gateway[2] === "messages" ? "messages" : "chat"}`, identity: gateway[1] ?? null, purpose,
      apiKey: req.headers["x-api-key"], auth, body: json });
    // Like Aelios: a model needs its provider prefix; one outside the identity's main models gets no memory.
    // "dropped" stands for a model taken off the main list after it was picked: its trial call passed.
    if (!json.model.includes("/")) return reply({ error: { message: `"${json.model}" has no provider prefix; use the author/model form` } }, 400);
    const off = json.model.includes("plain") || (json.model.includes("dropped") && purpose !== "auxiliary");
    const memory = off ? "off" : purpose === "auxiliary" ? "skipped" : "injected";
    const headers = { "x-aelios-memory": memory };
    if (gateway[2] === "messages") {
      return messages(`Aelios 收到 ${json.messages.length} 条，缓存标记${cached()}，旧思考块 ${thinkingCount()} 个`, headers);
    }
    return chat(`Aelios（${json.model}）收到：${said()}`, headers);
  }
  res.writeHead(404);
  res.end();
});
server.listen(9999, "127.0.0.1", () => console.log("mock on 9999"));
