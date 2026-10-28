// The Claude box: the resident's turns through the official Claude Agent SDK, signed in with the owner's own
// `claude setup-token`. It runs on a small machine of the owner's (docs/claude-box.md: a free Google Cloud VM behind
// a Cloudflare Tunnel). The resident sends the whole conversation every turn, so a box that restarted carries on.
//
//   GET  /health   200 once the server listens
//   POST /turn     { token, model, system, effort?, thinking?, tools?, history, prompt } → NDJSON, one object a line:
//                    { "e": <a streamed Messages API event of the reply> } …
//                    { "done": { "prompt": [entries], "reply": [entries] } }   the transcript entries Claude Code wrote
//                                                                              for the prompt and for its reply
//                    { "error": "…" }                                          instead of done when the turn failed
//                  With BOX_KEY set, a turn needs `authorization: Bearer <BOX_KEY>`.
//
// history is the conversation before the prompt, in order. An item is either { entries } (what this box wrote for
// that message on an earlier turn, sent back untouched so the request Claude Code makes matches the one before and
// the prompt cache keeps hitting) or { role, content } (a message the box never saw, written into the transcript).
//
// tools are the resident's (Messages API tool definitions). Claude Code sees them through an MCP server this box
// serves, and its calls wait there: the reply streams back with its tool_use blocks and ends, the resident runs the
// tools itself, and its next turn, whose prompt is their tool_result blocks, answers the waiting calls. The same
// Claude Code then goes on. A box that no longer has that Claude Code (it restarted, or waited too long) tells the
// calls and their results as text instead. Claude Code's own tools (commands, files, the web) stay off, and so do
// settings files and every other MCP server.

import http from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { callResult, lastLine, replyStream, settle, toolsFor, transcript, TOOL_SERVER } from "./transcript.mjs";

const PORT = Number(process.env.PORT || 8080);
// On a machine of its own the box listens only where the tunnel reaches it (BOX_HOST=127.0.0.1).
const HOST = process.env.BOX_HOST || undefined;
const KEY = process.env.BOX_KEY || "";
// Claude Code keys a transcript by its working directory, so it is the same on every turn.
const CWD = process.env.BOX_CWD || join(process.env.HOME || "/tmp", "chat");
const MAX_BODY = 64 * 1024 * 1024;
// Only what Claude Code needs from the machine's own environment (and, on a developer's machine, its proxy).
const PASSED = ["HOME", "PATH", "LANG", "TZ", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
// How long a turn that stopped at the resident's calls waits for their results before it stops.
const WAIT_MS = Number(process.env.BOX_WAIT_MS || 9 * 60_000);
// Claude Code's own limit on one call; above the wait, so the box is what gives up first.
const CALL_MS = WAIT_MS + 60_000;
// How long the end of a reply that stopped at calls waits for Claude Code to write it down.
const WRITTEN_MS = 5000;
// Claude Code steps on in one turn at most this many times (one request each), as a guard.
const MAX_STEPS = 40;
const UNANSWERED = { content: [{ type: "text", text: "No result came back for this call." }], isError: true };

// Running turns, by their MCP address (a random id, gone when the turn ends).
const runs = new Map();
// Turns stopped at the resident's calls, by the id of each call.
const waiting = new Map();

/** Whether a request carries `authorization: Bearer <key>`. */
function carries(request, key) {
  const given = Buffer.from(String(request.headers.authorization ?? ""));
  const wanted = Buffer.from(`Bearer ${key}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function keyed(request) {
  return !KEY || carries(request, KEY);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * One Claude Code session for one turn of the resident's and the steps it takes with the resident's tools. Each reply
 * (one request of Claude Code's) goes to the /turn that is streaming at the time: the turn that started it, then each
 * turn that brought the results of the calls the reply before stopped at.
 */
class Run {
  constructor(tools) {
    this.id = randomUUID();
    // The tunnel reaches every path here, so the turn's MCP server also wants a key only its Claude Code has.
    this.secret = randomBytes(32).toString("hex");
    this.tools = tools;
    this.appended = [];
    this.abort = new AbortController();
    this.failure = null;
    this.ended = false;
    // The reply streaming now: { write, stream, from, resolve }.
    this.reply = null;
    // The calls the last reply stopped at, and per call the MCP request that waits for its result, or the result
    // that came before Claude Code asked.
    this.asked = [];
    this.parked = new Map();
    this.given = new Map();
    this.timer = null;
    this.config = null;
  }

  /** Streams the next reply to this /turn; settles when that reply ended (at calls, or at the end of the turn). */
  attach(write, signal) {
    return new Promise((resolve) => {
      const reply = { write, stream: replyStream((event) => write({ e: event })), from: this.appended.length, resolve };
      this.reply = reply;
      // The resident gave up on the reply, while it streamed or before (while the turn was being set up): the turn stops.
      const cancel = () => this.reply === reply && this.stop("cancelled");
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
    });
  }

  finish(failure) {
    const reply = this.reply;
    if (!reply) return;
    this.reply = null;
    reply.write(lastLine(reply.stream, failure, this.appended.slice(reply.from)));
    reply.resolve();
  }

  event(event) {
    const reply = this.reply;
    if (!reply) return;
    reply.stream.event(event);
    if (event?.type === "message_stop" && reply.stream.calls && reply.stream.uses.length) void this.stopAt(reply);
  }

  /** The reply stopped at the resident's calls: once Claude Code wrote them down, it ends, and the turn waits. */
  async stopAt(reply) {
    const ids = reply.stream.uses.map((use) => use.id);
    const until = Date.now() + WRITTEN_MS;
    while (!this.ended && Date.now() < until && !ids.every((id) => this.wrote(id))) await new Promise((done) => setTimeout(done, 20));
    if (this.ended || this.reply !== reply) return;
    this.asked = reply.stream.uses;
    for (const id of ids) waiting.set(id, this);
    this.timer = setTimeout(() => this.stop("the resident's results did not come back"), WAIT_MS);
    this.finish(null);
  }

  wrote(id) {
    return this.appended.some(
      (entry) => entry?.type === "assistant" && Array.isArray(entry.message?.content) && entry.message.content.some((block) => block?.id === id)
    );
  }

  /** Whether this prompt answers the calls this turn waits on, and nothing else. */
  answers(prompt) {
    return !this.abort.signal.aborted && this.asked.length > 0 && prompt.every((block) => block?.type === "tool_result" && this.asked.some((use) => use.id === block.tool_use_id));
  }

  /** The resident's results: the waiting calls get them, and the next reply streams to this /turn. */
  go(prompt, write, signal) {
    clearTimeout(this.timer);
    const asked = this.asked;
    this.asked = [];
    for (const use of asked) waiting.delete(use.id);
    const replied = this.attach(write, signal);
    for (const use of asked) {
      const block = prompt.find((item) => item.tool_use_id === use.id);
      this.answer(use.id, block ? callResult(block) : UNANSWERED);
    }
    return replied;
  }

  answer(id, result) {
    const call = this.parked.get(id);
    if (call) {
      this.parked.delete(id);
      call(result);
    } else this.given.set(id, result);
  }

  /** A call Claude Code makes (an MCP tools/call): its result, once the resident has sent it. */
  call(params) {
    let id = params?._meta?.["claudecode/toolUseId"];
    // Claude Code sends the id of the call along; without it, the call is the first one not asked for yet.
    if (typeof id !== "string") id = [...this.given.keys(), ...this.asked.map((use) => use.id)].find((one) => !this.parked.has(one)) ?? randomUUID();
    const result = this.given.get(id);
    if (result) {
      this.given.delete(id);
      return Promise.resolve(result);
    }
    if (this.ended) return Promise.resolve(UNANSWERED);
    return new Promise((resolve) => this.parked.set(id, resolve));
  }

  stop(reason) {
    if (this.ended) return;
    this.failure ??= reason;
    for (const use of this.asked) if (waiting.get(use.id) === this) waiting.delete(use.id);
    this.abort.abort();
  }

  /** Claude Code is done: the reply streaming now (if any) ends, and nothing of the turn stays. */
  async close() {
    this.ended = true;
    clearTimeout(this.timer);
    for (const use of this.asked) if (waiting.get(use.id) === this) waiting.delete(use.id);
    for (const call of this.parked.values()) call(UNANSWERED);
    this.parked.clear();
    runs.delete(this.id);
    this.finish(this.failure);
    if (this.config) {
      const dir = this.config;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      // Claude Code stopped halfway still writes a few lines (her last words among them) on its way out: removed
      // again once it is gone.
      setTimeout(() => void rm(dir, { recursive: true, force: true }).catch(() => {}), 10_000).unref();
    }
  }

  async start(body, write, signal) {
    const { token, model, system, effort, thinking, history, prompt } = body;
    const sessionId = randomUUID();
    const settled = settle(transcript(history, { sessionId, model, cwd: CWD }), prompt);
    const entries = settled.entries;
    const store = {
      load: async (key) => (key.sessionId === sessionId && !key.subpath ? entries : null),
      append: async (key, batch) => {
        if (!key.subpath) this.appended.push(...batch);
      }
    };
    // A config directory of its own for each turn, removed after: nothing of hers stays on the disk.
    this.config = await mkdtemp(join(tmpdir(), "box-"));
    const env = {
      ...Object.fromEntries(PASSED.filter((name) => process.env[name]).map((name) => [name, process.env[name]])),
      CLAUDE_CONFIG_DIR: this.config,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      // The resident's tools are always in the request as they are, never behind a search for them.
      ENABLE_TOOL_SEARCH: "false",
      ...(typeof token === "string" && token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {})
    };
    runs.set(this.id, this);
    const replied = this.attach(write, signal);
    // Cancelled while it was being set up: no Claude Code at all.
    if (this.abort.signal.aborted) {
      void this.close();
      return replied;
    }
    const options = {
      ...(entries.length ? { resume: sessionId } : {}),
      sessionStore: store,
      sessionStoreFlush: "eager",
      cwd: CWD,
      model,
      tools: [],
      // The resident's tools run without asking; there are no others.
      allowedTools: this.tools.length ? [`mcp__${TOOL_SERVER}`] : [],
      mcpServers: this.tools.length
        ? {
            [TOOL_SERVER]: {
              type: "http",
              url: `http://127.0.0.1:${PORT}/mcp/${this.id}`,
              headers: { authorization: `Bearer ${this.secret}` },
              alwaysLoad: true,
              timeout: CALL_MS
            }
          }
        : {},
      strictMcpConfig: true,
      settingSources: [],
      verbatimPrompts: true,
      systemPrompt: { type: "custom", prompt: system, snapshot: false },
      title: "resident",
      includePartialMessages: true,
      maxTurns: MAX_STEPS,
      ...(EFFORTS.has(effort) ? { effort } : {}),
      ...(thinking === "summarized" ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
      env,
      abortController: this.abort
    };
    const told = settled.prompt;
    void this.pump(() =>
      query({
        prompt: (async function* () {
          yield { type: "user", message: { role: "user", content: told }, parent_tool_use_id: null, session_id: "" };
        })(),
        options
      })
    );
    return replied;
  }

  /** Runs Claude Code to the end of the turn, each reply to the /turn streaming at the time. */
  async pump(open) {
    try {
      for await (const message of open()) {
        if (message.type === "stream_event" && !message.parent_tool_use_id) this.event(message.event);
        else if (message.type === "result" && message.is_error) {
          this.failure ??= String(message.errors?.join("; ") || message.result || message.subtype || "the turn failed").slice(0, 500);
        }
      }
    } catch (error) {
      this.failure ??= this.abort.signal.aborted ? "cancelled" : String(error?.message ?? error).slice(0, 500);
    } finally {
      await this.close();
    }
  }
}

/** A turn: the results a running turn waits on, or a new turn. Settles when its reply has ended. */
async function turn(body, write, signal) {
  const { model, system, tools = [], history = [], prompt } = body ?? {};
  if (!Array.isArray(prompt) || !prompt.length) throw new Error("no prompt");
  const run = waiting.get(prompt[0]?.tool_use_id);
  if (run?.answers(prompt)) return run.go(prompt, write, signal);
  // A turn that waits on some of these calls but is not answered by this prompt waits for nothing now.
  for (const block of prompt) waiting.get(block?.tool_use_id)?.stop("its calls were answered another way");
  if (typeof model !== "string" || !model) throw new Error("no model");
  if (typeof system !== "string") throw new Error("no system prompt");
  if (!Array.isArray(history)) throw new Error("history is not a list");
  if (!Array.isArray(tools)) throw new Error("tools is not a list");
  return new Run(toolsFor(tools)).start(body, write, signal);
}

/** The MCP server a turn's Claude Code calls the resident's tools through, over Streamable HTTP as plain JSON. */
async function mcp(run, message) {
  if (!message || typeof message !== "object" || message.id === undefined || message.id === null) return null;
  const answer = (result) => ({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      return answer({
        protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "resident", version: "1" }
      });
    case "ping":
      return answer({});
    case "tools/list":
      return answer({ tools: run.tools });
    case "tools/call":
      return answer(await run.call(message.params));
    default:
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${String(message.method)}` } };
  }
}

export const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  const address = request.url?.match(/^\/mcp\/([0-9a-f-]{36})$/);
  if (address) {
    // Only the turn's own Claude Code calls it, with the key it was given.
    const run = runs.get(address[1]);
    if (!run || !carries(request, run.secret)) return void response.writeHead(404).end();
    if (request.method !== "POST") return void response.writeHead(405).end();
    let message;
    try {
      message = await readJson(request);
    } catch {
      return void response.writeHead(400).end();
    }
    const answer = await mcp(run, message);
    if (!answer) return void response.writeHead(202).end();
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    return;
  }
  if (request.method !== "POST" || request.url !== "/turn") {
    response.writeHead(404).end();
    return;
  }
  if (!keyed(request)) {
    response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "the box key does not match" }));
    return;
  }
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: String(error?.message ?? error) }));
    return;
  }
  const gone = new AbortController();
  response.on("close", () => {
    if (!response.writableFinished) gone.abort();
  });
  response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
  const write = (line) => {
    if (!response.destroyed) response.write(`${JSON.stringify(line)}\n`);
  };
  try {
    await turn(body, write, gone.signal);
  } catch (error) {
    write({ error: String(error?.message ?? error).slice(0, 500) });
  }
  response.end();
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await mkdir(CWD, { recursive: true });
  server.listen(PORT, HOST, () => console.log(`claude box on ${HOST ?? "*"}:${PORT}${KEY ? "" : " (no BOX_KEY: anyone who reaches it can use it)"}`));
  // A restart stops the box with SIGTERM: it stops taking turns; the resident runs a cut one again.
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
