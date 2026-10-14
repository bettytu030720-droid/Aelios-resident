// The resident: one Think agent in one Durable Object. Telegram and the web page
// are two doors into the same conversation.

import {
  Think,
  type ChatResponseResult,
  type MessageMetadataCallback,
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
import { createFetchTools } from "@cloudflare/think/tools/fetch";
import { createCompactFunction } from "agents/sessions";
import { webSearchTool } from "agents/websearch/ai-sdk";
import { generateText, type ToolSet, type UIMessage } from "ai";
import { aeliosConfig, fetchBoot, ingest, pin, recallTool, type IngestMessage } from "./aelios";
import { fakeModel } from "./fake-model";
import { CHAT_RULES, LETTER_INSTRUCTIONS, SKIP, checkinPrompt, stamp } from "./prompts";
import { claudeSystemAsText } from "./claude-run";
import { splitIntoBubbles, useBubbles, type BubbleAdapter } from "./telegram";

// Used until a model is picked on the web page. Free on the Workers Free plan.
const DEFAULT_MODEL = "@cf/zai-org/glm-4.7-flash";
// Used until a persona is written on the web page.
const DEFAULT_PERSONA = "你是她的伴侣，在 Telegram 和网页上陪她聊天。";
const PERSONA_MAX_CHARS = 30000;
// How many earlier personas the web page can bring back.
const PERSONA_VERSIONS = 10;
// How many models that passed their trial call the web page's picker lists first.
const RECENT_MODELS = 8;
const BOOT_REFRESH_MS = 6 * 60 * 60 * 1000;
// Claude models ("anthropic/…") go out on Anthropic's Messages API, where this asks for prompt caching:
// persona, rules, boot packet and the earlier turns are read from cache on the next turn.
// Other providers ignore options under "anthropic".
const PROMPT_CACHE = { anthropic: { cacheControl: { type: "ephemeral" } } };

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
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

const STAMP_PREFIX = /^\[\d\d-\d\d [^\]]*\]\s*/;
const CHECKIN_PREFIX = "（这条不是她发的，是定时提醒";

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
    if (memory) tools.memory_recall = recallTool(memory);
    if (this.env.WEB_SEARCH?.trim().toLowerCase() === "on") {
      tools.web_search = webSearchTool({ binding: this.env.AI, gateway: this.env.AI_GATEWAY_ID?.trim() || undefined });
    }
    const allowlist = list(this.env.FETCH_ALLOWLIST);
    if (allowlist.length) Object.assign(tools, createFetchTools({ allowlist }));
    return tools;
  }

  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig> {
    const thread = ctx.messenger?.thread;
    if (thread?.isDirectMessage && (await this.ctx.storage.get("tg_thread")) !== thread.id) {
      await this.ctx.storage.put("tg_thread", thread.id);
    }
    const boot = await this.boot();
    // Only our own tools: Think's workspace file tools would cost tokens every turn and do nothing here.
    const own = Object.keys(this.getTools());
    return {
      instructions: boot ? `${ctx.system}\n\n[长期记忆开机包]\n${boot}` : ctx.system,
      activeTools: Object.keys(ctx.tools).filter((name) => own.includes(name)),
      providerOptions: PROMPT_CACHE
    };
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
    return session
      .onCompaction(
        createCompactFunction({
          keepRecentTokens: num(this.env.KEEP_RECENT_TOKENS, 6000),
          summarize: (prompt) => this.writeLetter(prompt)
        })
      )
      .compactAfter(num(this.env.LETTER_AFTER_TOKENS, 24000))
      .onCompactionError((error) => console.error("letter: compaction failed", { error: String(error) }));
  }

  /** Set while /handoff runs, so the letter goes back as the command's answer instead of a notice. */
  #quietLetter = false;

  /**
   * Compaction folds older turns into one overlay. Ours is a handoff letter from
   * the resident to itself: the compaction prompt brings the turns (and the last
   * letter), and its English summary instructions are swapped for ours.
   */
  private async writeLetter(prompt: string): Promise<string> {
    const notify = !this.#quietLetter;
    const cut = prompt.search(/\n\n(Use this structure:|Update the summary\.)/);
    const turns = cut > 0 ? prompt.slice(0, cut) : prompt;
    const { text } = await generateText({
      model: this.resolveModel(),
      system: this.getSystemPrompt(),
      prompt: `${turns}\n\n${LETTER_INSTRUCTIONS}`
    });
    const letter = text.trim();
    if (!letter) return "";
    this.letters();
    this.sql`INSERT INTO res_letters (at, text) VALUES (${Date.now()}, ${letter})`;
    this.ctx.waitUntil(this.afterLetter(letter, notify));
    return `[交接信：之前的你在 ${stamp(new Date(), this.tz)} 写的]\n${letter}`;
  }

  private async afterLetter(letter: string, notify: boolean): Promise<void> {
    const memory = aeliosConfig(this.env);
    if (memory) await ingest(memory, [{ role: "assistant", content: `（交接信）${letter}` }], "aelios-resident:letter");
    if (notify && this.env.SHOW_LETTER?.trim() !== "false") {
      await this.toTelegram(`（聊天有点长了，我给之后的自己写了封交接信，旧的聊天收起来了）\n\n${letter}`);
    }
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
    if (result.status !== "completed") return;
    const reply = textOf(result.message).trim();
    const trigger = this.activeTurn?.trigger;
    // A scheduled check-in has no messenger turn to reply into: post it ourselves.
    const proactive = trigger === "scheduled" || trigger === "submission";
    if (proactive && reply && reply !== SKIP) {
      for (const bubble of splitIntoBubbles(reply)) await this.toTelegram(bubble);
    }
    const memory = aeliosConfig(this.env);
    if (!memory || !reply || reply === SKIP) return;
    const messages: IngestMessage[] = [];
    if (!proactive) {
      const user = this.userMessageBefore(result.message.id);
      if (user) messages.push({ role: "user", content: user });
    }
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
        this.#quietLetter = true;
        try {
          await this.session.compact();
        } finally {
          this.#quietLetter = false;
        }
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
    const on = (flag: boolean) => (flag ? "开" : "关");
    const [persona] = this.personas(1);
    return [
      `模型：${model}`,
      persona?.text
        ? `人设：网页上填的，${persona.text.length} 字，${stamp(new Date(persona.at), this.tz)} 改的`
        : "人设：还没填，先用默认的一句（网页门右上角的铅笔）",
      `对话：${rows.length} 条，约 ${tokens} token（超过 ${num(this.env.LETTER_AFTER_TOKENS, 24000)} 写交接信）`,
      `交接信：${compactions.length} 封`,
      usageLine(await this.lastUsage()),
      `长期记忆 Aelios：${on(Boolean(aeliosConfig(this.env)))}`,
      `查网页：搜索${on(this.env.WEB_SEARCH?.trim().toLowerCase() === "on")}，指定网站 ${list(this.env.FETCH_ALLOWLIST).length} 个`,
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
        if (text.startsWith(CHECKIN_PREFIX)) {
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
          system: "你是一个测试助手。",
          prompt: "只回一个字：好",
          maxOutputTokens: 64,
          providerOptions: PROMPT_CACHE,
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
