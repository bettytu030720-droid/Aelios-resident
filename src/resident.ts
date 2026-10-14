// The resident: one Think agent in one Durable Object. Telegram and the web page
// are two doors into the same conversation.

import {
  Think,
  type ChatResponseResult,
  type MessageMetadataCallback,
  type SessionMessage,
  type ThinkModel,
  type ThinkScheduledTask,
  type ThinkScheduledTasks,
  type ThinkSession,
  type StepContext,
  type TurnConfig,
  type TurnContext
} from "@cloudflare/think";
import {
  defaultChatSdkEvent,
  type MessengerConcurrency,
  type MessengerEvent,
  type NormalizedMessengerDefinition,
  type ThinkMessengers
} from "@cloudflare/think/messengers";
import telegramMessenger from "@cloudflare/think/messengers/telegram";
import { createCompactFunction } from "agents/sessions";
import { webSearchTool } from "agents/websearch/ai-sdk";
import { generateText, type ModelMessage, type ToolSet, type UIMessage } from "ai";
import { aeliosConfig, fetchBoot, ingest, memoryTools, pin, recall, type AeliosConfig, type IngestMessage } from "./aelios";
import { fakeModel } from "./fake-model";
import { CHAT_RULES, DEFAULT_PERSONA, LETTER_PREFIX, SKIP, checkinPrompt, isCheckin, isNote, letterPrompt, stamp } from "./prompts";
import { claudeSystemAsText } from "./claude-run";
import { SURFACE_HITS, SURFACE_KEEP, SURFACE_RECENT, SURFACE_TIMEOUT_MS, keyOf, surfaceText, userText, withSurface } from "./surface";
import { splitIntoBubbles, useBubbles, type BubbleAdapter } from "./telegram";
import { readerFor, webFetchTool, webFetchVia, type Page, type PageCache } from "./web/fetch";
import { searchEngines, searchSource } from "./web/search";

// Used until a model is picked on the web page. Free on the Workers Free plan.
const DEFAULT_MODEL = "@cf/zai-org/glm-4.7-flash";
const PERSONA_MAX_CHARS = 30000;
// How many earlier personas the web page can bring back.
const PERSONA_VERSIONS = 10;
// How many models that passed their trial call the web page's picker lists first.
const RECENT_MODELS = 8;
const BOOT_REFRESH_MS = 6 * 60 * 60 * 1000;
// How long a page web_fetch read is kept, so asking about it again costs no second fetch.
const PAGE_KEEP_MS = 60 * 60 * 1000;
// Claude models ("anthropic/…") go out on Anthropic's Messages API, where this asks for prompt caching:
// persona, rules, boot packet and the earlier turns are read from cache on the next turn, for an hour by
// default (CACHE_TTL=5m for five minutes; an hour costs 2x the input price to write, five minutes 1.25x).
// Other providers ignore options under "anthropic".
function promptCache(env: Env) {
  const ttl = env.CACHE_TTL?.trim() === "5m" ? "5m" : "1h";
  return { anthropic: { cacheControl: { type: "ephemeral", ttl } } };
}

/** Minutes of quiet after which the letter is written, while the conversation is still in the cache. 0 = never. */
function idleMinutes(env: Env): number {
  const setting = env.LETTER_IDLE_MINUTES?.trim().toLowerCase();
  if (setting === "off") return 0;
  const minutes = Number(setting);
  if (setting && Number.isFinite(minutes) && minutes >= 0) return minutes;
  return env.CACHE_TTL?.trim() === "5m" ? 4 : 55;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** One line of the web page's conversation view. */
export type WebLine = {
  id: string;
  role: "user" | "assistant";
  kind: "chat" | "letter";
  text: string;
  at: number | null;
  via: "telegram" | "web" | "checkin" | null;
};

/** Token use of the latest model call. Input includes the cached part. */
export type LastUsage = { at: number; input: number; cacheRead: number; cacheWrite: number; output: number };

/** The model as the web page edits it. An empty model means the default is in use. */
export type WebModel = { model: string; at: number | null; fallback: string; recent: string[]; lastUsage: LastUsage | null };

/** The persona as the web page edits it. An empty text means the default line is in use. */
export type WebPersona = {
  text: string;
  at: number | null;
  fallback: string;
  versions: { at: number; text: string }[];
};

const RECALLED_BLOCK = /<(recalled|想起的旧事)>[\s\S]*?<\/\1>\n?/g;
const STAMP_PREFIX = /^\[\d\d-\d\d [^\]]*\]\s*/;

function textOf(message: { parts?: readonly { type: string; text?: string }[] } | undefined): string {
  return (message?.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function usageLine(usage: LastUsage | null): string {
  if (!usage) return "上一次调用模型：还没有";
  const share = Math.round((usage.cacheRead / usage.input) * 100);
  return `上一次调用模型：输入 ${usage.input} token，其中缓存读 ${usage.cacheRead}（${share}%）、写 ${usage.cacheWrite}，输出 ${usage.output}`;
}

/** Put her local time in front of the first message of a burst, so the model knows when she wrote. */
function stampEvent(event: MessengerEvent, timeZone: string): MessengerEvent {
  const first = event.skipped?.[0] ?? event.message;
  if (first) first.text = `[${stamp(new Date(first.createdAt ?? Date.now()), timeZone)}] ${first.text}`;
  return event;
}

export class Resident extends Think<Env> {
  // Messages sent within DEBOUNCE_SECONDS of each other are answered as one turn.
  // A class field: the messenger runtime reads it before onStart.
  override messengerConcurrency: MessengerConcurrency = {
    strategy: "burst",
    debounceMs: num(this.env.DEBOUNCE_SECONDS, 3) * 1000
  };

  // When each reply started, for the web page (stored rows carry no time of their own).
  override messageMetadata: MessageMetadataCallback = ({ part }) => (part.type === "start" ? { at: Date.now() } : undefined);

  get tz(): string {
    return this.env.TIME_ZONE?.trim() || "Asia/Shanghai";
  }

  override getModel(): ThinkModel {
    return this.modelFor(this.savedModel() || this.defaultModel);
  }

  /** The model picked on the web page, or "" for the default. */
  private savedModel(): string {
    const saved = this.settings("model");
    if (saved) return saved.value;
    // The model used to be the MODEL variable: carry it over once, so the switch does not drop back to the default.
    const old = this.env.MODEL?.trim();
    if (old) this.saveSetting("model", old);
    return old ?? "";
  }

  /** Local tests run on a scripted model, which also becomes a valid choice there. */
  private get defaultModel(): string {
    return this.env.FAKE_MODEL === "true" ? "fake" : DEFAULT_MODEL;
  }

  private modelFor(id: string): ThinkModel {
    return id === "fake" && this.env.FAKE_MODEL === "true" ? fakeModel() : id;
  }

  /** Small settings written on the web page (the model, the recently used ones), one row per key. */
  private settings(key: string): { value: string; at: number } | undefined {
    this.sql`CREATE TABLE IF NOT EXISTS res_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL)`;
    return this.sql<{ value: string; at: number }>`SELECT value, at FROM res_settings WHERE key = ${key}`[0];
  }

  private saveSetting(key: string, value: string): void {
    this.settings(key);
    this.sql`INSERT INTO res_settings (key, value, at) VALUES (${key}, ${value}, ${Date.now()})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at`;
  }

  override getGateway() {
    const id = this.env.AI_GATEWAY_ID?.trim();
    return id ? { id } : undefined;
  }

  // Claude on Cloudflare's run path wants `system` as one string (see claude-run.ts).
  override getAIBinding(): Ai {
    return claudeSystemAsText(super.getAIBinding());
  }

  // Think asks for this on every turn (nothing freezes it), so a persona saved on the web applies to the next message.
  override getSystemPrompt(): string {
    return `${this.personas(1)[0]?.text || DEFAULT_PERSONA}\n\n${CHAT_RULES}`;
  }

  /** Personas saved on the web page, newest first. */
  private personas(limit: number): { at: number; text: string }[] {
    this.sql`CREATE TABLE IF NOT EXISTS res_persona (at INTEGER NOT NULL, text TEXT NOT NULL)`;
    return this.sql<{ at: number; text: string }>`SELECT at, text FROM res_persona ORDER BY rowid DESC LIMIT ${limit}`;
  }

  override getMessengers(): ThinkMessengers {
    const token = this.env.TG_BOT_TOKEN?.trim();
    const secretToken = this.env.TG_WEBHOOK_SECRET?.trim();
    if (!token || !secretToken) return {};
    const timeZone = this.tz;
    const definition = telegramMessenger({
      token,
      secretToken,
      userName: this.env.TG_BOT_USERNAME?.trim().replace(/^@/, "") || "resident_bot",
      apiBaseUrl: this.env.TG_API_BASE?.trim() || undefined,
      // Telegram and the web page share this agent's one conversation.
      conversation: "self",
      respondTo: ["direct-message"],
      delivery: {
        splitText: splitIntoBubbles,
        emptyResponseText: "（我好像没说出话来，再发一次？）",
        errorResponseText: "我这边出错了，没能回你。再发一次试试？",
        interruptedResponseText: "刚才回到一半断了，再发一次好吗？"
      },
      toEvent: (input) =>
        stampEvent(defaultChatSdkEvent({ ...definition, id: "telegram" } as NormalizedMessengerDefinition, input), timeZone)
    });
    useBubbles(definition.adapter as unknown as BubbleAdapter);
    return { telegram: definition };
  }

  override getTools(): ToolSet {
    const tools: ToolSet = {};
    const memory = aeliosConfig(this.env);
    if (memory) Object.assign(tools, memoryTools(memory));
    const source = searchSource(this.env);
    if (source) {
      tools.web_search = webSearchTool({
        source,
        description: "Search the web for current information: news, facts, prices, events. Open a result with web_fetch.",
        maxDescriptionChars: 400
      });
    }
    if (this.webFetchOn()) tools.web_fetch = webFetchTool(readerFor(this.env, this.pageCache()));
    return tools;
  }

  private webFetchOn(): boolean {
    return this.env.WEB_FETCH?.trim().toLowerCase() !== "off";
  }

  /** Pages web_fetch read in the last hour, in this agent's SQLite. */
  private pageCache(): PageCache {
    this.sql`CREATE TABLE IF NOT EXISTS res_pages (url TEXT PRIMARY KEY, at INTEGER NOT NULL, page TEXT NOT NULL)`;
    return {
      get: (url) => {
        const [row] = this.sql<{ at: number; page: string }>`SELECT at, page FROM res_pages WHERE url = ${url}`;
        return row && Date.now() - row.at < PAGE_KEEP_MS ? (JSON.parse(row.page) as Page) : null;
      },
      put: (url, page) => {
        const now = Date.now();
        this.sql`DELETE FROM res_pages WHERE at < ${now - PAGE_KEEP_MS}`;
        this.sql`INSERT OR REPLACE INTO res_pages (url, at, page) VALUES (${url}, ${now}, ${JSON.stringify(page)})`;
      }
    };
  }

  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig> {
    const thread = ctx.messenger?.thread;
    if (thread?.isDirectMessage && (await this.ctx.storage.get("tg_thread")) !== thread.id) {
      await this.ctx.storage.put("tg_thread", thread.id);
    }
    const boot = await this.boot();
    const messages = await this.withRecall(ctx);
    // Only our own tools: Think's workspace file tools would cost tokens every turn and do nothing here.
    const own = Object.keys(this.getTools());
    return {
      instructions: boot ? `${ctx.system}\n\n[长期记忆开机包]\n${boot}` : ctx.system,
      activeTools: Object.keys(ctx.tools).filter((name) => own.includes(name)),
      providerOptions: promptCache(this.env),
      ...(messages ? { messages } : {})
    };
  }

  /**
   * The turn's messages with what came up from Aelios (see surface.ts): a new search for her latest message,
   * and the earlier ones put back exactly as they were. Undefined when nothing came up at all.
   */
  private async withRecall(ctx: TurnContext): Promise<ModelMessage[] | undefined> {
    const memory = aeliosConfig(this.env);
    if (!memory) return undefined;
    const kept = this.surfaced();
    const texts = new Map(kept.map((row) => [row.key, row.text]));
    const last = ctx.messages.at(-1);
    if (!ctx.continuation && last?.role === "user") {
      const said = userText(last);
      const key = await keyOf(said);
      if (!texts.has(key) && !isNote(said)) {
        const { text, ids } = await this.recallFor(memory, said, kept);
        // Kept even when empty, so a retried turn sees the same thing.
        this.sql`INSERT OR REPLACE INTO res_surfaced (key, text, ids) VALUES (${key}, ${text}, ${JSON.stringify(ids)})`;
        this.sql`DELETE FROM res_surfaced WHERE rowid NOT IN (SELECT rowid FROM res_surfaced ORDER BY rowid DESC LIMIT ${SURFACE_KEEP})`;
        texts.set(key, text);
      }
    }
    let found = false;
    const messages: ModelMessage[] = [];
    for (const message of ctx.messages) {
      const text = message.role === "user" ? texts.get(await keyOf(userText(message))) : undefined;
      if (message.role === "user" && text) {
        messages.push(withSurface(message, text));
        found = true;
      } else {
        messages.push(message);
      }
    }
    return found ? messages : undefined;
  }

  /** Search Aelios for her message, leaving out memories that came up lately. Never throws. */
  private async recallFor(memory: AeliosConfig, said: string, kept: { ids: string }[]): Promise<{ text: string; ids: string[] }> {
    const query = said.replace(STAMP_PREFIX, "").trim().slice(0, 500);
    if (!query) return { text: "", ids: [] };
    const recent = new Set(kept.slice(0, SURFACE_RECENT).flatMap((row) => JSON.parse(row.ids) as string[]));
    try {
      const hits = await recall(memory, query, SURFACE_HITS + 4, AbortSignal.timeout(SURFACE_TIMEOUT_MS));
      const fresh = hits.filter((hit) => !hit.id || !recent.has(hit.id)).slice(0, SURFACE_HITS);
      return { text: surfaceText(fresh), ids: fresh.flatMap((hit) => (hit.id ? [hit.id] : [])) };
    } catch (error) {
      console.error("aelios: recall before reply failed", { error: String(error) });
      return { text: "", ids: [] };
    }
  }

  /** What came up for each of her messages, newest first. */
  private surfaced(): { key: string; text: string; ids: string }[] {
    this.sql`CREATE TABLE IF NOT EXISTS res_surfaced (key TEXT PRIMARY KEY, text TEXT NOT NULL, ids TEXT NOT NULL)`;
    return this.sql<{ key: string; text: string; ids: string }>`SELECT key, text, ids FROM res_surfaced ORDER BY rowid DESC`;
  }

  /** Token use of the latest model step, so /status and the web page can show whether the prompt cache is hit. */
  override async onStepFinish(step: StepContext): Promise<void> {
    const usage = step.usage;
    if (!usage?.inputTokens) return;
    await this.ctx.storage.put<LastUsage>("last_usage", {
      at: Date.now(),
      input: usage.inputTokens,
      cacheRead: usage.inputTokenDetails?.cacheReadTokens ?? 0,
      cacheWrite: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
      output: usage.outputTokens ?? 0
    });
  }

  private async lastUsage(): Promise<LastUsage | null> {
    return (await this.ctx.storage.get<LastUsage>("last_usage")) ?? null;
  }

  /** Aelios' boot packet, fetched at most every six hours. */
  private async boot(): Promise<string> {
    const memory = aeliosConfig(this.env);
    if (!memory) return "";
    const cached = await this.ctx.storage.get<{ text: string; at: number }>("aelios_boot");
    if (cached && Date.now() - cached.at < BOOT_REFRESH_MS) return cached.text;
    const text = await fetchBoot(memory);
    await this.ctx.storage.put("aelios_boot", { text, at: Date.now() });
    return text;
  }

  override configureSession(session: ThinkSession) {
    // No token limit: a letter is written when she has been quiet for a while (idleLetter) or on /handoff.
    return session
      .onCompaction(
        createCompactFunction({
          keepRecentTokens: num(this.env.KEEP_RECENT_TOKENS, 6000),
          summarize: () => this.letterTurn()
        })
      )
      .onCompactionError((error) => console.error("letter: compaction failed", { error: String(error) }));
  }

  /** Why the letter being written is written. Set while compact() runs. */
  #letterReason: "idle" | "handoff" = "handoff";

  /**
   * The handoff letter, written as one more turn of the same conversation: the request is the chat's own
   * (system prompt, tools, every earlier message, exactly as the last turn sent them) plus one prompt at the
   * end, so all of it is read from the prompt cache. The prompt and the letter are then taken out of the
   * conversation again, and compaction folds the older turns into the letter.
   */
  private async letterTurn(): Promise<string> {
    const prompt: UIMessage = {
      id: `letter_${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text: letterPrompt(stamp(new Date(), this.tz), this.#letterReason === "idle") }]
    };
    const result = await this.saveMessages([prompt]);
    const history = await this.session.getHistory();
    const at = history.findIndex((message) => message.id === prompt.id);
    const answer: SessionMessage[] = [];
    for (const message of at < 0 ? [] : history.slice(at + 1)) {
      if (message.role === "user") break;
      answer.push(message);
    }
    await this.session.deleteMessages([prompt.id, ...answer.map((message) => message.id)]);
    if (result.status !== "completed") throw new Error(`the letter turn ended ${result.status}`);
    const letter = answer.map((message) => textOf(message)).join("\n").trim();
    if (!letter || letter === SKIP) return "";
    this.letters();
    this.sql`INSERT INTO res_letters (at, text) VALUES (${Date.now()}, ${letter})`;
    await this.ctx.storage.put("wrote_since_letter", false);
    const memory = aeliosConfig(this.env);
    if (memory) this.ctx.waitUntil(ingest(memory, [{ role: "assistant", content: `（交接信）${letter}` }], "aelios-resident:letter"));
    return `[Handoff letter you wrote on ${stamp(new Date(), this.tz)}]\n${letter}`;
  }

  /** Fold the older turns into a letter now. False when there was nothing to fold. */
  private async writeLetter(reason: "idle" | "handoff"): Promise<boolean> {
    this.#letterReason = reason;
    try {
      return Boolean(await this.session.compact());
    } finally {
      this.#letterReason = "handoff";
    }
  }

  /** After a turn: plan the idle letter, replacing the one planned after the turn before. */
  private async planIdleLetter(): Promise<void> {
    const minutes = idleMinutes(this.env);
    const previous = await this.ctx.storage.get<string>("idle_letter");
    if (previous) await this.cancelSchedule(previous).catch(() => false);
    if (!minutes || !(await this.ctx.storage.get<boolean>("wrote_since_letter"))) {
      await this.ctx.storage.delete("idle_letter");
      return;
    }
    const schedule = await this.schedule(minutes * 60, "idleLetter");
    await this.ctx.storage.put("idle_letter", schedule.id);
  }

  /**
   * Called LETTER_IDLE_MINUTES (55) after the last turn: she has gone quiet, and the conversation is
   * still in the one-hour cache, so the letter costs little to write. Nothing more happens until she writes again.
   */
  async idleLetter(): Promise<void> {
    await this.ctx.storage.delete("idle_letter");
    // A turn that is running now will plan its own letter when it ends.
    if (this.activeTurn) return;
    if (!(await this.ctx.storage.get<boolean>("wrote_since_letter"))) return;
    await this.writeLetter("idle");
  }

  private letters(): { at: number; text: string }[] {
    this.sql`CREATE TABLE IF NOT EXISTS res_letters (at INTEGER NOT NULL, text TEXT NOT NULL)`;
    return this.sql<{ at: number; text: string }>`SELECT at, text FROM res_letters ORDER BY at DESC LIMIT 1`;
  }

  /** One message to her Telegram chat, outside any turn. False when she has not written from Telegram yet. */
  private async toTelegram(text: string): Promise<boolean> {
    const thread = await this.ctx.storage.get<string>("tg_thread");
    if (!thread || !this.env.TG_BOT_TOKEN) return false;
    try {
      await this.deliverNotice({ markdown: text }, { channel: "telegram", thread });
      return true;
    } catch (error) {
      console.error("tg: notice failed", { error: String(error) });
      return false;
    }
  }

  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    const asked = this.userMessageBefore(result.message.id);
    // The letter turn: letterTurn() takes the answer and removes both messages.
    if (asked.startsWith(LETTER_PREFIX)) return;
    if (asked && !isNote(asked)) await this.ctx.storage.put("wrote_since_letter", true);
    await this.planIdleLetter();
    if (result.status !== "completed") return;
    // Should the model ever repeat a <recalled> block, it does not go back into Aelios as something it said.
    const reply = textOf(result.message).replace(RECALLED_BLOCK, "").trim();
    const trigger = this.activeTurn?.trigger;
    // A scheduled check-in has no messenger turn to reply into: post it ourselves.
    const proactive = trigger === "scheduled" || trigger === "submission";
    if (proactive && reply && reply !== SKIP) {
      for (const bubble of splitIntoBubbles(reply)) await this.toTelegram(bubble);
    }
    const memory = aeliosConfig(this.env);
    if (!memory || !reply || reply === SKIP) return;
    const messages: IngestMessage[] = [];
    if (!proactive && asked) messages.push({ role: "user", content: asked });
    messages.push({ role: "assistant", content: reply });
    this.ctx.waitUntil(ingest(memory, messages, proactive ? "aelios-resident:checkin" : "aelios-resident"));
  }

  private userMessageBefore(id: string): string {
    const messages = this.messages;
    const index = messages.findIndex((message) => message.id === id);
    for (let i = (index < 0 ? messages.length : index) - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") return textOf(messages[i]).trim();
    }
    return "";
  }

  override getDefaultTimezone(): string {
    return this.tz;
  }

  override getScheduledTasks(): ThinkScheduledTasks {
    const schedule = this.env.CHECKIN_SCHEDULE?.trim();
    if (!schedule) return {};
    return {
      checkin: {
        schedule,
        prompt: () => checkinPrompt(stamp(new Date(), this.tz))
      } as ThinkScheduledTask
    };
  }

  /** Slash commands, answered by the Worker without a model turn. */
  async command(name: string): Promise<string> {
    switch (name) {
      case "start":
        return "在的，直接跟我说话就行。\n/status 看状态，/letter 看最近一封交接信，/handoff 现在就写交接信。";
      case "status":
        return this.status();
      case "letter": {
        const [latest] = this.letters();
        return latest ? `${stamp(new Date(latest.at), this.tz)} 写的：\n\n${latest.text}` : "还没写过交接信。";
      }
      case "handoff": {
        const before = this.letters()[0]?.at;
        await this.writeLetter("handoff");
        const [latest] = this.letters();
        if (!latest || latest.at === before) return "现在聊得还不多，没什么要收起来的。";
        return `交接信写好了，旧的聊天收起来了：\n\n${latest.text}`;
      }
      default:
        return "这个命令我不认识。可以用 /status、/letter、/handoff。";
    }
  }

  private async status(): Promise<string> {
    const rows = await this.session.getHistoryRowStats();
    const compactions = await this.session.getCompactions();
    const tokens = rows.reduce((sum, row) => sum + row.tokenEstimate, 0);
    const model = this.savedModel() || this.defaultModel;
    const [persona] = this.personas(1);
    return [
      `模型：${model}`,
      persona?.text
        ? `人设：网页上填的，${persona.text.length} 字，${stamp(new Date(persona.at), this.tz)} 改的`
        : "人设：还没填，先用默认的一句（网页门右上角的铅笔）",
      `对话：${rows.length} 条，约 ${tokens} token`,
      `交接信：${idleMinutes(this.env) ? `没动静 ${idleMinutes(this.env)} 分钟后趁缓存还在写一封，` : ""}/handoff 随时写；缓存 ${promptCache(this.env).anthropic.cacheControl.ttl}`,
      `已写交接信：${compactions.length} 封`,
      usageLine(await this.lastUsage()),
      `长期记忆 Aelios：${aeliosConfig(this.env) ? "开，每条消息先自动想一下相关的旧事" : "关"}`,
      `查网页：搜索 ${searchEngines(this.env).join(" → ") || "关"}；读网页 ${this.webFetchOn() ? webFetchVia(readerFor(this.env)) : "关"}`,
      `主动找你：${this.env.CHECKIN_SCHEDULE?.trim() || "关"}`
    ].join("\n");
  }

  /** The conversation as the web page shows it: what the resident currently carries, letters included. */
  async webHistory(): Promise<WebLine[]> {
    const lines: WebLine[] = [];
    let via: WebLine["via"] = null;
    for (const message of await this.session.getHistory()) {
      const text = textOf(message).trim();
      const meta = message.metadata as { at?: number; messenger?: { message?: { createdAt?: string } } } | undefined;
      const sentAt = meta?.messenger?.message?.createdAt;
      const at = meta?.at ?? (sentAt ? new Date(sentAt).getTime() : null);
      if (message.id.startsWith("compaction_")) {
        lines.push({ id: message.id, role: "assistant", kind: "letter", text, at: null, via: null });
        continue;
      }
      if (message.role === "user") {
        if (isCheckin(text)) {
          via = "checkin";
          continue;
        }
        via = meta?.messenger ? "telegram" : "web";
        lines.push({ id: message.id, role: "user", kind: "chat", text: text.replace(STAMP_PREFIX, ""), at, via });
        continue;
      }
      if (message.role !== "assistant" || !text) continue;
      if (via === "checkin" && text === SKIP) continue;
      lines.push({ id: message.id, role: "assistant", kind: "chat", text, at, via });
    }
    return lines;
  }

  /** A message typed on the web page: one turn in the same conversation, answered there (not on Telegram). */
  async webSay(text: string): Promise<{ status: string }> {
    const said = text.trim().slice(0, 4000);
    if (!said) return { status: "empty" };
    const result = await this.saveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: `[${stamp(new Date(), this.tz)}] ${said}` }],
        metadata: { at: Date.now() }
      }
    ]);
    return { status: result.status };
  }

  async webModel(): Promise<WebModel> {
    this.savedModel();
    const saved = this.settings("model");
    return {
      model: saved?.value ?? "",
      at: saved?.at ?? null,
      fallback: this.defaultModel,
      recent: this.recentModels(),
      lastUsage: await this.lastUsage()
    };
  }

  /** Models that passed their trial call here, newest first. */
  private recentModels(): string[] {
    try {
      const list: unknown = JSON.parse(this.settings("recent_models")?.value ?? "[]");
      return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  }

  /**
   * Pick the model from the web page. It is tried with one tiny call first, so a typo,
   * a model the plan does not include, or a missing key is reported here instead of in the chat.
   * Empty goes back to the default.
   */
  async webSetModel(id: string): Promise<WebModel | { error: string }> {
    const model = id.trim();
    if (model) {
      try {
        await generateText({
          model: this.resolveModel(this.modelFor(model)),
          // Shaped like a real turn (a system prompt and the cache marker), so a model that would fail in the chat fails here.
          system: "You are a test assistant.",
          prompt: "Reply with one word: ok",
          maxOutputTokens: 64,
          providerOptions: promptCache(this.env),
          abortSignal: AbortSignal.timeout(30_000)
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { error: `这个模型用不了：${reason.slice(0, 300)}` };
      }
    }
    this.saveSetting("model", model);
    if (model) {
      const recent = [model, ...this.recentModels().filter((id) => id !== model)].slice(0, RECENT_MODELS);
      this.saveSetting("recent_models", JSON.stringify(recent));
    }
    return this.webModel();
  }

  /** The persona panel on the web page: the current persona and the ones before it. */
  async webPersona(): Promise<WebPersona> {
    const [current, ...older] = this.personas(PERSONA_VERSIONS + 1);
    const text = current?.text ?? "";
    // Each earlier persona once, skipping empties and the one in use (bringing one back saves it again).
    const seen = new Set([text, ""]);
    const versions = older.filter((version) => !seen.has(version.text) && Boolean(seen.add(version.text)));
    return { text, at: current?.at ?? null, fallback: DEFAULT_PERSONA, versions };
  }

  /** Save a persona from the web page. Empty goes back to the default line. */
  async webSetPersona(text: string): Promise<WebPersona | { error: string }> {
    const persona = text.trim();
    if (persona.length > PERSONA_MAX_CHARS) return { error: `人设最多 ${PERSONA_MAX_CHARS} 字` };
    if (persona !== (this.personas(1)[0]?.text ?? "")) {
      this.sql`INSERT INTO res_persona (at, text) VALUES (${Date.now()}, ${persona})`;
      this.sql`DELETE FROM res_persona WHERE rowid NOT IN (SELECT rowid FROM res_persona ORDER BY rowid DESC LIMIT ${PERSONA_VERSIONS + 1})`;
    }
    return this.webPersona();
  }

  /** The heart on the web page: keep a line in Aelios' precious memories. */
  async webPin(content: string): Promise<boolean> {
    const memory = aeliosConfig(this.env);
    return Boolean(memory && content.trim() && (await pin(memory, content.trim())));
  }

}
