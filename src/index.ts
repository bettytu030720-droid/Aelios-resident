// The Worker in front of the resident:
//   POST /messengers/telegram/webhook   Telegram → secret check, allowlist, slash commands → the resident
//   GET  /tg/setup?secret=…             points the bot's webhook here (open once after deploy)
//   /web/*                              the web page's API (same conversation as Telegram, and the persona), behind WEB_KEY
//   everything else                     the web page itself (public/)

import { getAgentByName } from "agents";
import { commandOf, isAllowed, sendBubbles, setWebhook, timingSafeEqual, type TelegramUpdate } from "./telegram";

export { ThinkMessengerStateAgent } from "@cloudflare/think/messengers";
export { Resident } from "./resident";

const WEBHOOK_PATH = "/messengers/telegram/webhook";
// Telegram and the web page both talk to this one agent.
const AGENT_NAME = "default";

function telegram(env: Env) {
  return { token: env.TG_BOT_TOKEN ?? "", apiBase: env.TG_API_BASE };
}

async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const secret = env.TG_WEBHOOK_SECRET?.trim();
  const got = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!secret || !env.TG_BOT_TOKEN || !timingSafeEqual(got, secret)) return new Response("unauthorized", { status: 401 });

  const body = await request.text();
  let update: TelegramUpdate;
  try {
    update = JSON.parse(body);
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const message = update.message;
  const chatId = message?.chat?.id;
  // Anything that is not a private message from a person is acknowledged and dropped.
  if (!message || chatId == null || message.from?.is_bot || message.chat?.type !== "private") {
    return new Response("ok");
  }
  if (!isAllowed(env.TG_ALLOWED, String(chatId), message.from?.username)) {
    // No reply, so strangers cannot probe the bot. The log line shows what to put in TG_ALLOWED.
    console.log("tg: dropped message from a chat not in TG_ALLOWED", { chatId, username: message.from?.username });
    return new Response("ok");
  }

  const agent = await getAgentByName(env.RESIDENT, AGENT_NAME);
  const command = commandOf(message.text);
  if (command) {
    // The Think messenger ignores slash commands; the Worker answers them without a model turn.
    ctx.waitUntil(
      agent
        .command(command)
        .then((text) => sendBubbles(telegram(env), String(chatId), text, { bubbles: false }))
        .catch((error) => console.error("tg: command failed", { command, error: String(error) }))
    );
    return new Response("ok");
  }
  return agent.fetch(new Request(request.url, { method: "POST", headers: request.headers, body }));
}

async function handleSetup(env: Env, url: URL): Promise<Response> {
  const secret = env.TG_WEBHOOK_SECRET?.trim();
  if (!secret || !env.TG_BOT_TOKEN) return new Response("set TG_BOT_TOKEN and TG_WEBHOOK_SECRET first", { status: 400 });
  if (!timingSafeEqual(url.searchParams.get("secret") ?? "", secret)) return new Response("unauthorized", { status: 401 });
  return Response.json(await setWebhook(telegram(env), `${url.origin}${WEBHOOK_PATH}`, secret));
}

/** The web door is open only with WEB_KEY, sent by the page as the x-web-key header. */
function webAllowed(env: Env, request: Request): boolean {
  const key = env.WEB_KEY?.trim();
  return Boolean(key && timingSafeEqual(request.headers.get("x-web-key") ?? "", key));
}

async function handleWeb(request: Request, env: Env, url: URL): Promise<Response> {
  if (!webAllowed(env, request)) return new Response("unauthorized", { status: 401 });
  const agent = await getAgentByName(env.RESIDENT, AGENT_NAME);
  const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as { text?: string }) : {};
  switch (`${request.method} ${url.pathname}`) {
    case "GET /web/check":
      return Response.json({ ok: true, aelios: Boolean(env.AELIOS_URL && env.AELIOS_API_KEY) });
    case "GET /web/messages":
      return Response.json({ data: await agent.webHistory() });
    case "POST /web/say":
      return Response.json(await agent.webSay(String(body.text ?? "")));
    case "POST /web/pin":
      return Response.json({ ok: await agent.webPin(String(body.text ?? "")) });
    case "GET /web/persona":
      return Response.json(await agent.webPersona());
    case "POST /web/persona": {
      const saved = await agent.webSetPersona(String(body.text ?? ""));
      return Response.json(saved, { status: "error" in saved ? 400 : 200 });
    }
    default:
      return new Response("not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === WEBHOOK_PATH) return await handleWebhook(request, env, ctx);
      if (url.pathname === "/tg/setup") return await handleSetup(env, url);
      if (url.pathname.startsWith("/web/")) return await handleWeb(request, env, url);
      return new Response("not found", { status: 404 });
    } catch (error) {
      // Non-2xx makes Telegram redeliver; the messenger dedupes by message id.
      console.error("aelios-resident request failed", { path: url.pathname, error: String(error) });
      return new Response("error", { status: 500 });
    }
  }
} satisfies ExportedHandler<Env>;
