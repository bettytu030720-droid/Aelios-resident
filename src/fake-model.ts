// A scripted model for local tests (MODEL=fake): no AI binding, no login, no cost.
// It answers from the last user message so the tests can drive every path.

import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 }
});

type Prompt = LanguageModelV4CallOptions["prompt"];

let checkins = 0;

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

function lastOf(prompt: Prompt, role: string): string {
  for (let i = prompt.length - 1; i >= 0; i -= 1) if (prompt[i].role === role) return textOf(prompt[i].content);
  return "";
}

/** What the fake model says, or a tool it calls. */
function decide(prompt: Prompt): { text: string; delayMs?: number } | { tool: string; input: unknown } {
  const system = prompt.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  const user = lastOf(prompt, "user");
  const last = prompt[prompt.length - 1];
  const said = user.replace(/^\[[^\]]+\]\s*/, "");

  if (last?.role === "tool") return { text: `我查到了：${textOf(last.content)}` };
  if (said.includes("查记忆")) return { tool: "memory_recall", input: { query: "生日" } };
  if (said.includes("开机包")) {
    return { text: system.includes("[长期记忆开机包]") && system.includes("一起去看海") ? "开机包在。" : "没有开机包。" };
  }
  if (said.includes("交接信在吗")) {
    const all = prompt.map((m) => textOf(m.content)).join("\n");
    return { text: all.includes("亲爱的下一个我") ? "交接信在。" : "没看到交接信。" };
  }
  if (said.includes("慢慢说")) return { text: "第一段，慢慢说。\n\n第二段，还在说。\n\n第三段，说完了。", delayMs: 4000 };
  // The first check-in says something; later ones pass, to exercise SKIP.
  if (said.includes("定时提醒")) return { text: checkins++ === 0 ? "主动来找你啦。\n\n记得喝水。" : "SKIP" };
  return { text: `收到：${user}\n\n这是第二个气泡。` };
}

export function fakeModel(): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake",
    supportedUrls: {},
    async doGenerate(options) {
      // Only compaction calls generate: write the handoff letter.
      const prompt = textOf(options.prompt.map((m) => textOf(m.content)).join("\n"));
      const merged = prompt.includes("PREVIOUS SUMMARY") ? "（并了上一封信）" : "";
      return {
        content: [{ type: "text", text: `亲爱的下一个我：她刚才在测试交接信。${merged}` }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(prompt.length, 20),
        warnings: []
      };
    },
    async doStream(options) {
      const choice = decide(options.prompt);
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
