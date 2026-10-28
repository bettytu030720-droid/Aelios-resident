// Claude on your own subscription: `claude-code/<model>` (claude-code/claude-opus-5-5 and so on). The turn goes to
// the Claude box, the official Claude Agent SDK signed in with the owner's `claude setup-token`, running on a small
// machine of the owner's behind a Cloudflare Tunnel (claude-box/server.mjs, docs/claude-box.md), instead of to an
// API. Everything else stays the resident's: Think keeps the conversation, the persona, the letters, the heartbeat
// and the tools; only the call to the model goes to the box.
//
// To the AI SDK this is an Anthropic model whose requests never leave the Worker but for the box: the request body
// is read here and the box's stream is handed back as the Messages API's own events. Each turn carries the whole
// conversation. A message the box answered or was sent before goes back as the transcript entries Claude Code wrote
// for it (kept in the resident's storage), which keeps the requests Claude Code makes the same from turn to turn and
// the prompt cache hitting; a message it never saw (an older turn on another model, a handoff letter) goes as it is.
// From the first message that differs from what the box holds, the rest goes as it is, and the box's entries take
// over again from the next reply.
//
// The resident's tools go along. Claude Code calls them, the reply stops there as any model's does, Think runs them,
// and the next call brings their results, which the same Claude Code in the box goes on from. With Aelios connected
// the resident recalls for her message before the turn and records the exchange after it, which Aelios does itself
// on the other routes.

import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { isNote } from "./prompts";
import { thinksUnasked } from "./thinking";
import type { Thinking } from "./via-aelios";

export const CLAUDE_CODE_PREFIX = "claude-code/";

export function isClaudeCode(id: string): boolean {
  return id.startsWith(CLAUDE_CODE_PREFIX);
}

/** What the box holds of one message of the conversation: its fingerprint, and the entries it wrote for it. */
export type Segment = { fp: string; entries: unknown[] | null };

/** A turn's way to the box and back, and what the resident does around it. */
export type ClaudeCodeTurn = {
  /** The owner's `claude setup-token`. */
  token: string;
  /** Sends a turn to the box (POST /turn) and answers with its NDJSON stream. */
  send(body: string, signal?: AbortSignal): Promise<Response>;
  /** What the box holds of the conversation; none for work outside it (one call, nothing kept). */
  segments?: { load(): Segment[]; save(segments: Segment[]): void };
  /** For her own turns (not the system's notes), what long-term memory brings up for what she said ("" for nothing). */
  recall?(said: string): Promise<string>;
  /** For her own turns, after the reply: what she said and what was answered. */
  record?(said: string, reply: string): void;
};

type Block = Record<string, unknown> & { type?: unknown };
type Message = { role?: unknown; content?: unknown };
type Item = { entries: unknown[] } | { role: "user" | "assistant"; content: Block[] };

// One entry over this is not kept (a row holds at most 2 MB); its message goes as it is next time.
const SEGMENT_MAX_CHARS = 1_800_000;
const TOOL_TEXT_MAX = 4000;

function blocksOf(content: unknown): Block[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return Array.isArray(content) ? content.filter((block): block is Block => Boolean(block) && typeof block === "object") : [];
}

function clip(text: string): string {
  return text.length > TOOL_TEXT_MAX ? `${text.slice(0, TOOL_TEXT_MAX)}…` : text;
}

function textOfResult(content: unknown): string {
  if (typeof content === "string") return content;
  return blocksOf(content)
    .map((block) => (block.type === "text" ? String(block.text ?? "") : block.type === "image" ? "[图片]" : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * A message as the box gets it when it has not seen it: text, pictures and documents as they are, without cache
 * marks; the tool calls and results of a turn on another model as a line of text (Claude Code only takes calls it
 * made itself back); the thinking of earlier turns left out, as on every route.
 */
export function plainBlocks(role: "user" | "assistant", content: unknown): Block[] {
  const out: Block[] = [];
  for (const block of blocksOf(content)) {
    const { cache_control: _cache, ...rest } = block;
    switch (block.type) {
      case "text":
        if (typeof block.text === "string" && block.text) out.push({ type: "text", text: block.text });
        break;
      case "image":
      case "document":
        if (role === "user") out.push(rest);
        break;
      case "tool_use":
        out.push({ type: "text", text: clip(`[用了工具 ${String(block.name ?? "")}：${JSON.stringify(block.input ?? {})}]`) });
        break;
      case "tool_result":
        out.push({ type: "text", text: clip(`[工具的结果${block.is_error ? "（出错）" : ""}]\n${textOfResult(block.content)}`) });
        break;
      default:
        // Thinking, and the provider's own server tools: nothing the box can send back.
        break;
    }
  }
  return out.length ? out : [{ type: "text", text: "…" }];
}

/** Why a turn cannot go to the box: there is none on the settings page. */
export const NO_BOX = "还没填 Claude 盒子的地址：照 docs/claude-box.md 装好盒子，把地址和钥匙填进设置页「供应商」";

/**
 * Her turn as the box gets it: text, pictures and documents as they are, without cache marks; the results of the
 * calls the reply before stopped at as tool_result blocks, which the box hands to the calls waiting there.
 */
export function promptBlocks(content: unknown): Block[] {
  const out: Block[] = [];
  for (const block of blocksOf(content)) {
    if (block.type !== "tool_result") {
      out.push(...plainBlocks("user", [block]).filter((part) => part.text !== "…"));
      continue;
    }
    const parts = typeof block.content === "string" ? [{ type: "text", text: block.content }] : blocksOf(block.content);
    out.push({
      type: "tool_result",
      tool_use_id: String(block.tool_use_id ?? ""),
      content: parts.map((part) => (part.type === "text" || part.type === "image" ? (({ cache_control: _cache, ...rest }) => rest)(part) : { type: "text", text: JSON.stringify(part) })),
      ...(block.is_error ? { is_error: true } : {})
    });
  }
  return out.length ? out : [{ type: "text", text: "…" }];
}

/** The resident's own tools in a request (not the provider's server tools), as the box lists them to Claude Code. */
function ownTools(tools: unknown): Block[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool): tool is Block => Boolean(tool) && typeof tool === "object" && (tool.type === undefined || tool.type === "custom"))
    .map(({ cache_control: _cache, ...tool }) => tool);
}

/** What a message says, the same however Think splits it into blocks or marks it for the cache. */
function sayings(role: string, content: unknown): unknown[] {
  const out: unknown[] = [];
  for (const block of blocksOf(content)) {
    let part: unknown[] | null;
    switch (block.type) {
      case "text":
        part = ["t", String(block.text ?? "")];
        break;
      case "thinking":
      case "redacted_thinking":
        part = null;
        break;
      case "image":
      case "document":
        part = [block.type, JSON.stringify(block.source ?? null)];
        break;
      case "tool_use":
        part = ["u", String(block.name ?? ""), JSON.stringify(block.input ?? null)];
        break;
      case "tool_result":
        part = ["r", String(block.tool_use_id ?? ""), textOfResult(block.content), Boolean(block.is_error)];
        break;
      default: {
        const { cache_control: _cache, ...rest } = block;
        part = [String(block.type), JSON.stringify(rest)];
      }
    }
    if (!part) continue;
    const last = out.at(-1) as unknown[] | undefined;
    // Adjacent text is one saying: a reply streamed as two blocks comes back as one, or the other way round.
    if (part[0] === "t" && last?.[0] === "t") last[1] = `${last[1]}${part[1]}`;
    else out.push(part);
  }
  return [role, out];
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A message's fingerprint: what it says, by whom. */
export function fingerprint(role: string, content: unknown): Promise<string> {
  return sha256(JSON.stringify(sayings(role, content)));
}

function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  return blocksOf(system)
    .map((block) => (block.type === "text" ? String(block.text ?? "") : ""))
    .filter(Boolean)
    .join("\n\n");
}

/** The text she said in her turn (the newest user message), as Aelios recalls and records it. */
export function saidIn(content: unknown): string {
  return blocksOf(content)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/**
 * The history the box gets, and what it holds of it after this turn's reply: each earlier message as the box's own
 * entries while they still match, as it is from the first one that does not.
 */
export async function historyFor(messages: Message[], held: Segment[]): Promise<{ history: Item[]; kept: Segment[] }> {
  const history: Item[] = [];
  const kept: Segment[] = [];
  let same = true;
  for (let i = 0; i < messages.length; i += 1) {
    const role = messages[i].role === "assistant" ? "assistant" : "user";
    const fp = await fingerprint(role, messages[i].content);
    same = same && held[i]?.fp === fp;
    const entries = same ? held[i].entries : null;
    history.push(entries ? { entries } : { role, content: plainBlocks(role, messages[i].content) });
    kept.push({ fp, entries });
  }
  return { history, kept };
}

function sized(entries: unknown[]): unknown[] | null {
  return JSON.stringify(entries).length <= SEGMENT_MAX_CHARS ? entries : null;
}

const encoder = new TextEncoder();

function sse(event: StreamEvent): Uint8Array {
  return encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
}

/** An answer the AI SDK reads as the Messages API refusing the call, with the reason she is shown. */
function refusal(status: number, message: string): Response {
  return Response.json({ type: "error", error: { type: status === 401 ? "authentication_error" : "api_error", message } }, { status });
}

/**
 * Lines of an NDJSON stream as they come. When `stop` aborts, or the lines are no longer read, the stream is
 * cancelled: the connection to the box closes, and the box stops the turn.
 */
async function* lines(body: ReadableStream<Uint8Array>, stop: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  const cancel = () => void reader.cancel(stop.reason).catch(() => {});
  if (stop.aborted) cancel();
  else stop.addEventListener("abort", cancel, { once: true });
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += value;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line) yield JSON.parse(line) as Record<string, unknown>;
      }
      if (done) break;
    }
    if (buffer.trim()) yield JSON.parse(buffer) as Record<string, unknown>;
  } finally {
    stop.removeEventListener("abort", cancel);
    // Nothing once it has all been read; otherwise the box is told to stop.
    await reader.cancel().catch(() => {});
  }
}

/** Why the box turned a turn down, in her words where it can be said simply. */
export function boxError(message: string): { status: number; message: string } {
  const text = message.trim() || "Claude 订阅这一轮没回";
  if (/not logged in|\/login|invalid api key|oauth|authenticat|401/i.test(text)) {
    return { status: 401, message: `Claude 订阅没登录上：setup token 不对或过期了，在电脑上跑 claude setup-token 重新拿一个，填进设置页（${text}）` };
  }
  if (/usage limit|rate limit|429|limit reached/i.test(text)) return { status: 400, message: `Claude 订阅的额度用完了：${text}` };
  return { status: 400, message: `Claude 订阅这一轮出错：${text}` };
}

/** The fetch the Anthropic provider uses: every request becomes a turn in the box. */
export function boxFetch(turn: ClaudeCodeTurn, thinking?: Thinking): typeof fetch {
  return async (_input, init) => {
    if (typeof init?.body !== "string") return refusal(400, "Claude 订阅只接对话");
    if (!turn.token) return refusal(401, "还没填 Claude 订阅的 setup token：在电脑上跑 claude setup-token，把那串填进设置页「供应商」");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const model = String(body.model ?? "");
    const messages = Array.isArray(body.messages) ? (body.messages as Message[]) : [];
    // Her turn is what follows the last reply: the AI SDK sends it as one user message.
    const cut = messages.findLastIndex((message) => message.role === "assistant") + 1;
    const fresh = messages.slice(cut);
    if (!fresh.length || fresh.some((message) => message.role !== "user")) return refusal(400, "Claude 订阅这一轮没有新的话可回");
    const content = fresh.flatMap((message) => promptBlocks(message.content));
    // The results of the calls the reply before stopped at: the same turn of hers goes on.
    const goesOn = content.every((block) => block.type === "tool_result");
    // Her turn began with her last message that was not only results; what was replied since is part of the reply.
    const start = goesOn ? messages.findLastIndex((message, i) => i < cut && message.role === "user" && blocksOf(message.content).some((block) => block.type !== "tool_result")) : cut;
    const said = (start < 0 ? [] : goesOn ? [messages[start]] : fresh).map((message) => saidIn(message.content)).filter(Boolean).join("\n");
    const before = goesOn && start >= 0 ? messages.slice(start + 1, cut).filter((message) => message.role === "assistant").map((message) => saidIn(message.content)).join("") : "";
    // Her own turns only: a check-in, a heartbeat or a letter answers one of the system's notes.
    const hers = Boolean(said) && !isNote(said.trimStart());
    // Recalled once, when her turn begins.
    const memory = hers && !goesOn && turn.recall ? await turn.recall(said).catch(() => "") : "";
    // After her words, as the resident's rules describe it (prompts.ts).
    const prompt = memory ? [...content, { type: "text", text: memory }] : content;
    const { history, kept } = await historyFor(messages.slice(0, cut), turn.segments?.load() ?? []);
    const freshFp = await fingerprint("user", fresh.flatMap((message) => blocksOf(message.content)));
    const request = {
      token: turn.token,
      model,
      system: systemText(body.system),
      effort: thinking?.effort ?? null,
      thinking: thinking && thinksUnasked(model) ? "summarized" : null,
      tools: ownTools(body.tools),
      history,
      prompt
    };
    // Aborted: as fetch does, the call fails with the reason it was aborted for.
    const abandon = () => {
      throw init.signal?.reason ?? new DOMException("The call was aborted", "AbortError");
    };
    let response: Response;
    try {
      response = await turn.send(JSON.stringify(request), init.signal ?? undefined);
    } catch (error) {
      if (init.signal?.aborted) abandon();
      return refusal(503, `Claude 盒子没连上：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      let reason = text;
      try {
        reason = String((JSON.parse(text) as { error?: unknown }).error ?? text);
      } catch {
        // Not JSON: the text as it is.
      }
      // No box on the settings page (501), or the wrong key, is not worth trying again; a box restarting is.
      if (response.status === 501) return refusal(400, reason || NO_BOX);
      if (response.status === 401) return refusal(400, "Claude 盒子不认这把钥匙：设置页「供应商」里的盒子钥匙要和装盒子时生成的那把一样");
      return refusal(response.status >= 500 ? 503 : 400, `Claude 盒子没接这一轮（${response.status}）：${reason.slice(0, 300)}`);
    }
    // Stops reading the box's answer: the call was aborted, or what was streamed is no longer read.
    const stop = new AbortController();
    init.signal?.addEventListener("abort", () => stop.abort(init.signal?.reason), { once: true });
    if (init.signal?.aborted) stop.abort(init.signal.reason);
    const stream = lines(response.body, stop.signal);
    // A turn the box turned down before saying anything is a refused call, so a model switch says why.
    let first: IteratorResult<Record<string, unknown>>;
    try {
      first = await stream.next();
    } catch (error) {
      if (init.signal?.aborted) abandon();
      return refusal(503, `Claude 盒子断了：${String(error)}`);
    }
    if (init.signal?.aborted) {
      await stream.return(undefined);
      abandon();
    }
    if (first.done) return refusal(503, "Claude 盒子什么都没回");
    if (typeof first.value.error === "string") {
      const { status, message } = boxError(first.value.error);
      return refusal(status, message);
    }
    // Every event of the reply, for the message it makes up.
    const events: StreamEvent[] = [];
    // The box ends every turn it finished with a done line; an answer that stops without one was cut off.
    let finished = false;
    const CUT_OFF = "Claude 盒子半路断了，这一轮没回完";
    /** One line of the box's answer: the event to pass on, or the error that ends it; the turn kept when done. */
    const take = async (line: Record<string, unknown>): Promise<{ event?: StreamEvent; error?: string }> => {
      const event = line.e as StreamEvent | undefined;
      if (event) {
        events.push(event);
        return { event };
      }
      if (typeof line.error === "string") return { error: boxError(line.error).message };
      const done = line.done as { prompt?: unknown; reply?: unknown } | undefined;
      if (!done) return {};
      finished = true;
      const message = messageOf(events);
      if (turn.segments && Array.isArray(done.prompt) && Array.isArray(done.reply)) {
        try {
          turn.segments.save([
            ...kept,
            { fp: freshFp, entries: sized(done.prompt) },
            { fp: await fingerprint("assistant", message.content), entries: sized(done.reply) }
          ]);
        } catch (error) {
          console.error("claude-code: transcript not kept", { error: String(error) });
        }
      }
      // Recorded once her turn is answered: a reply that stopped at calls goes on in the next one.
      const reply = `${before}${saidIn(message.content)}`;
      if (hers && turn.record && reply && message.stop_reason !== "tool_use") turn.record(said, reply);
      return {};
    };
    // A call that does not stream (a model switch's trial call, shrinking a page) gets the whole message at once.
    if (body.stream !== true) {
      try {
        for (let line: IteratorResult<Record<string, unknown>> = first; !line.done; line = await stream.next()) {
          const { error } = await take(line.value);
          if (error) return refusal(400, error);
          if (finished) break;
        }
      } catch (error) {
        if (!init.signal?.aborted) return refusal(503, `Claude 盒子断了：${String(error)}`);
      } finally {
        await stream.return(undefined);
      }
      if (init.signal?.aborted) abandon();
      if (!finished) return refusal(503, CUT_OFF);
      return Response.json(messageOf(events));
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          let failed = false;
          const fail = (message: string) => {
            failed = true;
            controller.enqueue(sse({ type: "error", error: { type: "api_error", message } }));
          };
          try {
            for (let line: IteratorResult<Record<string, unknown>> = first; !line.done; line = await stream.next()) {
              const { event, error } = await take(line.value);
              if (event) controller.enqueue(sse(event));
              if (error) {
                fail(error);
                break;
              }
              if (finished) break;
            }
            if (!finished && !failed && !stop.signal.aborted) fail(CUT_OFF);
          } catch (error) {
            if (!stop.signal.aborted) fail(`Claude 盒子断了：${String(error)}`);
          }
          await stream.return(undefined);
          try {
            controller.close();
          } catch {
            // Already cancelled by the reader.
          }
        },
        cancel(reason) {
          stop.abort(reason);
        }
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
  };
}

type StreamEvent = {
  type?: unknown;
  index?: number;
  message?: Record<string, unknown>;
  content_block?: Record<string, unknown>;
  delta?: Record<string, unknown> & { type?: unknown; text?: unknown };
  usage?: Record<string, unknown>;
  [key: string]: unknown;
};

/** The streamed events of a reply as the one message the Messages API answers a call that does not stream with. */
export function messageOf(events: StreamEvent[]): Record<string, unknown> {
  let message: Record<string, unknown> = { type: "message", role: "assistant", content: [] };
  const blocks: Record<string, unknown>[] = [];
  for (const event of events) {
    if (event.type === "message_start" && event.message) message = { ...event.message };
    else if (event.type === "content_block_start" && typeof event.index === "number" && event.content_block) blocks[event.index] = { ...event.content_block };
    else if (event.type === "content_block_delta" && typeof event.index === "number" && blocks[event.index]) {
      const block = blocks[event.index];
      const delta = event.delta ?? {};
      if (delta.type === "text_delta") block.text = `${String(block.text ?? "")}${String(delta.text ?? "")}`;
      else if (delta.type === "thinking_delta") block.thinking = `${String(block.thinking ?? "")}${String(delta.thinking ?? "")}`;
      else if (delta.type === "signature_delta") block.signature = delta.signature;
      else if (delta.type === "input_json_delta") block.partial = `${String(block.partial ?? "")}${String(delta.partial_json ?? "")}`;
    } else if (event.type === "message_delta") {
      message = { ...message, ...(event.delta ?? {}), usage: { ...(message.usage as object | undefined), ...(event.usage ?? {}) } };
    }
  }
  // A call's input comes as pieces of JSON.
  const content = blocks.filter(Boolean).map(({ partial, ...block }) => {
    if (block.type !== "tool_use" || typeof partial !== "string") return block;
    try {
      return { ...block, input: partial.trim() ? JSON.parse(partial) : {} };
    } catch {
      return block;
    }
  });
  return { ...message, content };
}

/** `claude-code/<model>` as a model whose every call is a turn in the box. */
export function claudeCodeModel(id: string, turn: ClaudeCodeTurn, thinking?: Thinking): LanguageModel {
  // The address is never reached: every request is answered by boxFetch.
  return createAnthropic({ baseURL: "https://claude-box.invalid/v1", apiKey: "subscription", fetch: boxFetch(turn, thinking) })(
    id.slice(CLAUDE_CODE_PREFIX.length)
  );
}
