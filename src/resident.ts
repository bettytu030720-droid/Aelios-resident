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
import { splitIntoBubbles, useBubbles, type BubbleAdapter } from "./telegram";

const DEFAULT_MODEL = "@cf/zai-org/glm-4.7-flash";
const DEFAULT_PERSONA = "你是她的伴侣，住在她的 Telegram 里。";
const BOOT_REFRESH_MS = 6 * 60 * 60 * 1000;

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

const STAMP_PREFIX = /^\[\d\d-\d\d [^\]]*\]\s*/;
const CHECKIN_PREFIX = "（这条不是她发的，是定时提醒";

function textOf(message: { parts?: readonly { type: string; text?: string }[] } | undefined): string {
  return (message?.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
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
    const model = this.env.MODEL?.trim() || DEFAULT_MODEL;
    return model === "fake" ? fakeModel() : model;
  }

  override getGateway() {
    const id = this.env.AI_GATEWAY_ID?.trim();
    return id ? { id } : undefined;
  }

  override getSystemPrompt(): string {
    const persona = [this.env.PERSONA, this.env.PERSONA_2, this.env.PERSONA_3, this.env.PERSONA_4]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join("\n");
    return `${persona || DEFAULT_PERSONA}\n\n${CHAT_RULES}`;
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
      activeTools: Object.keys(ctx.tools).filter((name) => own.includes(name))
    };
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
    const model = this.env.MODEL?.trim() || DEFAULT_MODEL;
    const on = (flag: boolean) => (flag ? "开" : "关");
    return [
      `模型：${model}`,
      `对话：${rows.length} 条，约 ${tokens} token（超过 ${num(this.env.LETTER_AFTER_TOKENS, 24000)} 写交接信）`,
      `交接信：${compactions.length} 封`,
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

  /** The heart on the web page: keep a line in Aelios' precious memories. */
  async webPin(content: string): Promise<boolean> {
    const memory = aeliosConfig(this.env);
    return Boolean(memory && content.trim() && (await pin(memory, content.trim())));
  }

}
