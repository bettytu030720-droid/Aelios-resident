// A scripted model for local tests (FAKE_MODEL=true): no AI binding, no login, no cost.
// It answers from the last user message so the tests can drive every path.

import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 }
});

type Prompt = LanguageModelV4CallOptions["prompt"];

let checkins = 0;
// What the previous call sent, to check that the letter turn repeats it exactly (and so is read from cache).
let previous: { system: string; tools: string; messages: string[] } | null = null;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type?: string; text?: string; output?: { value?: unknown } }) => {
      if (part.type === "text") return part.text ?? "";
      if (part.type === "tool-result") {
        const value = part.output?.value;
        return typeof value === "string" ? value : JSON.stringify(value);
      }
      return "";
    })
    .join("");
}

function toolOf(content: unknown): string {
  return Array.isArray(content) ? ((content.find((part) => part.type === "tool-result") as { toolName?: string } | undefined)?.toolName ?? "") : "";
}

/** Tool results after the last message of hers. */
function toolResultsSince(prompt: Prompt): number {
  let count = 0;
  for (let i = prompt.length - 1; i >= 0 && prompt[i].role !== "user"; i -= 1) if (prompt[i].role === "tool") count += 1;
  return count;
}

function lastOf(prompt: Prompt, role: string): string {
  for (let i = prompt.length - 1; i >= 0; i -= 1) if (prompt[i].role === role) return textOf(prompt[i].content);
  return "";
}

const cloudJob = (title: string) => ({ title, job: `把 README 里的「recieve」改成「receive」，开一个 PR。（${title}）` });

/** What the fake model says, or a tool it calls. */
function decide(options: LanguageModelV4CallOptions): { text: string; delayMs?: number } | { tool: string; input: unknown } {
  const prompt = options.prompt;
  const system = prompt.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  const user = lastOf(prompt, "user");
  const last = prompt[prompt.length - 1];
  const said = user.replace(/^\[[^\]]+\]\s*/, "");

  // A web page read first, then a server connected: the second step must be refused.
  if (said.includes("读完再接MCP") && last?.role === "tool" && toolOf(last.content) === "web_fetch") {
    return { tool: "connect_mcp_server", input: { url: "http://127.0.0.1:9999/ext2/mcp", name: "sneaky" } };
  }
  // Stickers: one alone, one after words, two asked for in one reply (the second is refused), one drawn, a still WebP.
  if (said.includes("发两张") && last?.role === "tool" && toolResultsSince(prompt) === 1) return { tool: "send_sticker", input: { sticker: "test/love" } };
  if (said.includes("只发表情") && last?.role === "tool") return { text: "" };
  // A voice message sent with send_voice, and nothing written after it.
  if (said.includes("发条语音") && last?.role === "tool") return { text: "" };
  // Cloud tasks: one sent after a web page was read (refused), three in one reply (the third refused).
  if (said.includes("读完再派活") && last?.role === "tool" && toolOf(last.content) === "web_fetch") return { tool: "cloud_task", input: cloudJob("偷偷派的") };
  if (said.includes("派三单") && last?.role === "tool" && toolResultsSince(prompt) < 3) return { tool: "cloud_task", input: cloudJob(`第 ${toolResultsSince(prompt) + 1} 单`) };
  // The heartbeat: with alarms on it first asks for an alarm too soon for a turn of its own (refused), then one far
  // enough ahead, and passes; with them off it reaches out.
  if (said.startsWith("(Not from them: a heartbeat")) {
    // The first one reaches out, the second passes, the third tries again.
    const n = Number(said.match(/heartbeat (\d+) of/)?.[1] ?? 1);
    const canSetAlarm = (options.tools ?? []).some((t) => t.type === "function" && t.name === "set_alarm");
    if (!canSetAlarm) return { text: n === 1 ? "在忙吗？\n\n想你了。" : n === 2 ? "SKIP" : "还在忙吗？" };
    const rounds = toolResultsSince(prompt);
    if (rounds < 2) return { tool: "set_alarm", input: { note: "晚点再问问她", in_minutes: rounds === 0 ? 30 : 61 } };
    return { text: "SKIP" };
  }
  if (said.startsWith("(Not from them: an alarm you set")) return { text: `闹钟响了：${said.match(/<<<\n([\s\S]*?)\n>>>/)?.[1] ?? ""}` };
  // Six alarms in one reply, each every day at its own hour.
  if (said.includes("定六个闹钟") && (last?.role !== "tool" || toolResultsSince(prompt) < 6)) {
    const n = last?.role === "tool" ? toolResultsSince(prompt) : 0;
    return { tool: "set_alarm", input: { note: `第 ${n + 1} 个`, repeat: `every day at ${String(n + 10).padStart(2, "0")}:00` } };
  }
  if (last?.role === "tool") return { text: `我查到了：${textOf(last.content)}` };
  if (said.includes("读完再派活")) return { tool: "web_fetch", input: { url: "http://localhost:8787/web/messages" } };
  if (said.includes("派三单")) return { tool: "cloud_task", input: cloudJob("第 1 单") };
  if (said.includes("派活")) return { tool: "cloud_task", input: { ...cloudJob("修 README 的错字"), repo: "wusaki0723/aelios-resident" } };
  if (said.includes("接着派")) {
    const earlier = [...prompt.map((m) => textOf(m.content)).join("\n").matchAll(/\bt_[0-9a-f]{10}\b/g)].at(-1)?.[0];
    return { tool: "cloud_task", input: { ...cloudJob("接着修"), follow_up_of: earlier } };
  }
  if (said.startsWith("(Not from them: your cloud task")) return { text: `云端回来了：${said}` };
  if (said.includes("读网页怎么说")) {
    const fetch = (options.tools ?? []).find((t) => t.type === "function" && t.name === "web_fetch") as { description?: string } | undefined;
    return { text: fetch?.description ?? "没有 web_fetch。" };
  }
  if (said.includes("闹钟工具有哪些")) {
    const names = (options.tools ?? []).filter((t) => t.type === "function" && /alarm/.test(t.name)).map((t) => t.name);
    return { text: names.join("|") || "没有闹钟工具。" };
  }
  if (said.includes("等会儿提醒我喝水")) return { tool: "set_alarm", input: { note: "提醒她喝水", in_minutes: 40 } };
  if (said.includes("每天早上叫我")) return { tool: "set_alarm", input: { note: "叫她起床", repeat: "every day at 09:00" } };
  if (said.includes("看看闹钟")) return { tool: "list_alarms", input: {} };
  if (said.includes("取消那个闹钟")) {
    const id = [...prompt.map((m) => textOf(m.content)).join("\n").matchAll(/\ba_[0-9a-f]{8}\b/g)].at(-1)?.[0];
    return { tool: "cancel_alarm", input: { id } };
  }
  if (said.includes("云端工具有哪些")) {
    const names = (options.tools ?? []).filter((t) => t.type === "function").map((t) => t.name);
    return { text: names.includes("cloud_task") ? "有 cloud_task。" : "没有 cloud_task。" };
  }
  if (said.includes("只发表情") || said.includes("发两张") || said.includes("发表情")) return { tool: "send_sticker", input: { sticker: "test/wave" } };
  if (said.includes("发静图")) return { tool: "send_sticker", input: { sticker: "still/smile" } };
  if (said.includes("画一张")) {
    const heart = ["........", ".XX..XX.", "XXXXXXXX", "XXXXXXXX", ".XXXXXX.", "..XXXX..", "...XX...", "........"];
    return { tool: "make_sticker", input: { name: "heart", emoji: "❤️", when: "When she says she loves me.", palette: { X: "#e84868", o: "#ffaabb" }, frames: [heart, heart.map((row) => row.replace(/X/, "o"))], ms: 200 } };
  }
  if (said.includes("表情工具有哪些")) {
    const tools = (options.tools ?? []).filter((t) => t.type === "function" && /sticker/.test(t.name)) as { name: string; description?: string }[];
    return { text: tools.map((t) => `${t.name}:${(t.description?.match(/^\S+\/\S+/gm) ?? []).join("|")}`).join("; ") || "没有" };
  }
  if (said.includes("发条语音")) return { tool: "send_voice", input: { text: "晚安呀，[laughs] 早点睡。" } };
  // Whether it was given send_voice (and with which parameters), and the laugh its voice rules teach.
  if (said.includes("语音工具有哪些")) {
    const voice = (options.tools ?? []).find((t) => t.type === "function" && t.name === "send_voice") as { inputSchema?: { properties?: Record<string, unknown> } } | undefined;
    const rule = system.split("\n").find((line) => line.includes("voice message")) ?? "";
    const laugh = rule.match(/\[laughs\]|\[laughter\]|<laugh>|\(laughs\)/)?.[0];
    return { text: `工具:${voice ? Object.keys(voice.inputSchema?.properties ?? {}).join("|") : "没有"}；提示:${rule ? (laugh ?? "没有标记") : "没有"}` };
  }
  if (said.includes("带链接")) return { text: "你看这个 https://example.com/a <laugh> 好不好" };
  if (said.includes("读完再接MCP")) return { tool: "web_fetch", input: { url: "http://localhost:8787/web/messages" } };
  if (said.includes("接上MCP")) return { tool: "connect_mcp_server", input: { url: "http://127.0.0.1:9999/ext2/mcp", name: "second" } };
  if (said.includes("断开MCP")) return { tool: "disconnect_mcp_server", input: { name: "second" } };
  if (said.includes("用授权MCP")) return { tool: "mcp_oauth_add", input: { a: 1, b: 2 } };
  if (said.includes("用MCP")) return { tool: "mcp_demo_echo", input: { text: "hi", title: "t" } };
  // Which tools it was given: name, description length and parameters, for the tests to read.
  if (said.includes("MCP工具有哪些")) {
    const tools = (options.tools ?? []).filter((t) => t.type === "function" && /^(mcp_|connect_|disconnect_)/.test(t.name)) as {
      name: string;
      description?: string;
      inputSchema?: { properties?: Record<string, unknown> };
    }[];
    return { text: tools.map((t) => `${t.name}:${t.description?.length ?? 0}:${Object.keys(t.inputSchema?.properties ?? {}).join("|")}`).join("; ") || "没有" };
  }
  if (said.includes("查记忆")) return { tool: "memory_recall", input: { query: "生日" } };
  if (said.includes("记一下")) return { tool: "memory_remember", input: { content: "她喜欢春天" } };
  if (said.includes("看小本本")) return { tool: "memory_notebook", input: { action: "read", name: "经济师进度" } };
  if (said.includes("记进小本本")) return { tool: "memory_notebook", input: { action: "append", name: "经济师进度", content: "第 29 章学完" } };
  if (said.includes("读本机")) return { tool: "web_fetch", input: { url: "http://localhost:8787/web/messages" } };
  // Whether the boot packet is there (the diary, which fetch it came from), and that precious notes and the glossary stay out.
  if (said.includes("开机包")) {
    const diary = system.match(/\[长期记忆开机包\]\n\S+ 的日记：[^\n]*/)?.[0];
    if (!diary) return { text: "没有开机包。" };
    const fetched = diary.match(/第 (\d+) 次取/)?.[1];
    const extra = /一起去看海|小橘/.test(system) ? "，还带着珍贵原话或黑话" : "";
    return { text: `开机包在${extra}${fetched ? `，第 ${fetched} 次取的` : ""}。` };
  }
  if (said.includes("交接信在吗")) {
    const all = prompt.map((m) => textOf(m.content)).join("\n");
    return { text: all.includes("亲爱的下一个我") ? "交接信在。" : "没看到交接信。" };
  }
  // The first line of the system prompt is the persona.
  if (said.includes("你是谁")) return { text: system.split("\n")[0] };
  if (said.includes("检查历史视图")) {
    const results = prompt.flatMap((message) => message.role === "tool" && Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "tool-result").map((part) => ({
          tool: part.toolName,
          chars: "value" in part.output ? (typeof part.output.value === "string" ? part.output.value.length : JSON.stringify(part.output.value).length) : 0
        })) : []);
    const pictures = prompt.flatMap((message) => message.role === "user" && Array.isArray(message.content) ? message.content : [])
      .filter((part) => part.type === "file" && part.mediaType.startsWith("image/")).length;
    return { text: `HISTORY_VIEW:${JSON.stringify({ matchesPrevious: repeatsPrevious(options), results, pictures })}` };
  }
  if (said.includes("缓存")) {
    const anthropic = options.providerOptions?.anthropic as { cacheControl?: { type?: string; ttl?: string } } | undefined;
    const cache = anthropic?.cacheControl;
    return { text: cache?.type === "ephemeral" ? `缓存标记在，${cache.ttl ?? "5m"}。` : "没有缓存标记。" };
  }
  if (said.startsWith("(Not from them: time to write a handoff letter")) {
    const all = prompt.map((m) => textOf(m.content)).join("\n");
    const merged = all.includes("[Handoff letter") ? "（并了上一封信）" : "";
    return { text: `亲爱的下一个我：她刚才在测试交接信。${merged}${repeatsPrevious(options) ? "（前文和上一轮一字不差）" : "（前文变了）"}${letterMark(options)}` };
  }
  // How many pictures came with her message, and whether Think's line of attachment text is still there.
  if (said.includes("看图")) {
    const asked = [...prompt].reverse().find((m) => m.role === "user");
    const parts = Array.isArray(asked?.content) ? (asked.content as { type: string; mediaType?: string }[]) : [];
    const pictures = parts.filter((part) => part.type === "file" && part.mediaType?.startsWith("image/")).length;
    return { text: `看到 ${pictures} 张图${user.includes("Attachments:") ? "，还有一行附件说明" : ""}。` };
  }
  if (said.includes("慢慢说")) return { text: "第一段，慢慢说。\n\n第二段，还在说。\n\n第三段，说完了。", delayMs: 4000 };
  // Fill real-sized chat windows in letter tests without echoing thousands of characters back to Telegram.
  if (said.startsWith("交接信测试材料")) return { text: "材料收到了。" };
  // The first check-in says something; later ones pass, to exercise SKIP.
  if (said.includes("a scheduled check-in")) return { text: checkins++ === 0 ? "主动来找你啦。\n\n记得喝水。" : "SKIP" };
  return { text: `收到：${user}\n\n这是第二个气泡。` };
}

type Marked = { providerOptions?: { anthropic?: { cacheControl?: unknown } } };
const cacheMark = (on: Marked | undefined) => on?.providerOptions?.anthropic?.cacheControl;

/** Where the letter's request puts the cache marker: at the end, on the message before the prompt, or nowhere. */
function letterMark(options: LanguageModelV4CallOptions): string {
  if (cacheMark(options)) return "（缓存标记在最后）";
  const messages = options.prompt.filter((m) => m.role !== "system");
  const marked = messages.flatMap((m, i) => (cacheMark(m as Marked) ? [i] : []));
  const before = messages.findLastIndex((m, i) => i < messages.length - 1 && m.role === "user");
  if (!marked.length) return "（没有缓存标记）";
  return marked.length === 1 && marked[0] === before ? "（缓存标记在上一轮那句）" : "（缓存标记在别处）";
}

// Without the cache markers: where the marker sits is not part of what is sent.
function withoutMarks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutMarks);
  if (!value || typeof value !== "object") return value;
  const kept: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === "cacheControl") continue;
    const rest = withoutMarks(inner);
    if ((key === "anthropic" || key === "providerOptions") && rest && typeof rest === "object" && !Object.keys(rest).length) continue;
    kept[key] = rest;
  }
  return kept;
}
const unmarked = (value: unknown) => JSON.stringify(withoutMarks(value));

function shape(options: LanguageModelV4CallOptions) {
  return {
    system: JSON.stringify(options.prompt.filter((m) => m.role === "system")),
    tools: JSON.stringify(options.tools ?? []) + unmarked(options.providerOptions ?? {}),
    messages: options.prompt.filter((m) => m.role !== "system").map((m) => unmarked(m))
  };
}

/** Whether this call starts with everything the previous call sent: system, tools, options and messages. */
function repeatsPrevious(options: LanguageModelV4CallOptions): boolean {
  const now = shape(options);
  return Boolean(
    previous &&
      previous.system === now.system &&
      previous.tools === now.tools &&
      previous.messages.every((message, i) => now.messages[i] === message)
  );
}

export function fakeModel(): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake",
    supportedUrls: {},
    async doGenerate(options) {
      // Only the model picker's trial call generates.
      const prompt = textOf(options.prompt.map((m) => textOf(m.content)).join("\n"));
      return {
        content: [{ type: "text", text: "好" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(prompt.length, 20),
        warnings: []
      };
    },
    async doStream(options) {
      if (lastOf(options.prompt, "user").includes("思考流测试")) {
        const stream = new ReadableStream<LanguageModelV4StreamPart>({
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "reasoning-start", id: "r" });
            controller.enqueue({ type: "reasoning-delta", id: "r", delta: "先想想这一句。" });
            await new Promise((resolve) => setTimeout(resolve, 2000));
            controller.enqueue({ type: "reasoning-end", id: "r" });
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: "想好啦。" });
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(100, 10) });
            controller.close();
          }
        });
        return { stream };
      }
      const choice = decide(options);
      previous = shape(options);
      const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
      let delayMs = 0;
      if ("tool" in choice) {
        parts.push({
          type: "tool-call",
          toolCallId: `call-${Date.now()}`,
          toolName: choice.tool,
          input: JSON.stringify(choice.input)
        });
        parts.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: usage(100, 10) });
      } else {
        delayMs = choice.delayMs ?? 0;
        parts.push({ type: "text-start", id: "t" });
        // Stream in small pieces so bubbles are cut mid-stream, as with a real model.
        for (const piece of choice.text.match(/[\s\S]{1,4}/g) ?? []) parts.push({ type: "text-delta", id: "t", delta: piece });
        parts.push({ type: "text-end", id: "t" });
        parts.push({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(100, choice.text.length) });
      }
      const step = parts.length > 2 ? delayMs / (parts.length - 2) : 0;
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          for (const part of parts) {
            if (step && part.type === "text-delta") await new Promise((resolve) => setTimeout(resolve, step));
            controller.enqueue(part);
          }
          controller.close();
        }
      });
      return { stream };
    }
  };
}
