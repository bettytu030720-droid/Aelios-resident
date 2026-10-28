// The Claude box: one turn of the resident's conversation through the official Claude Agent SDK, signed in with the
// owner's own `claude setup-token`. It runs in a Cloudflare container next to the resident (src/claude-code.ts) and
// keeps nothing between turns: the resident sends the whole conversation every time, so a container that slept and
// woke with a fresh disk carries on the same.
//
//   GET  /health   200 once the server listens
//   POST /turn     { token, model, system, effort?, thinking?, history, prompt } → NDJSON, one object a line:
//                    { "e": <a streamed Messages API event of the reply> } …
//                    { "done": { "prompt": [entries], "reply": [entries] } }   the transcript entries Claude Code wrote
//                                                                              for her turn and for its reply
//                    { "error": "…" }                                          instead of done when the turn failed
//
// history is the conversation before her turn, in order. An item is either { entries } (what this box wrote for that
// message on an earlier turn, sent back untouched so the request Claude Code makes matches the one before and the
// prompt cache keeps hitting) or { role, content } (a message the box never saw, written into the transcript as is).
// No tools, no settings files, no MCP: it only talks.

import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { lastLine, replyStream, transcript } from "./transcript.mjs";

const PORT = Number(process.env.PORT || 8080);
// Claude Code keys a transcript by its working directory, so it is the same on every turn.
const CWD = process.env.BOX_CWD || join(process.env.HOME || "/tmp", "chat");
const MAX_BODY = 64 * 1024 * 1024;
// Only what Claude Code needs from the container's own environment (and, on a developer's machine, its proxy).
const PASSED = ["HOME", "PATH", "LANG", "TZ", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

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

async function turn(body, write, signal) {
  const { token, model, system, effort, thinking, history = [], prompt } = body ?? {};
  if (typeof model !== "string" || !model) throw new Error("no model");
  if (typeof system !== "string") throw new Error("no system prompt");
  if (!Array.isArray(history)) throw new Error("history is not a list");
  if (!Array.isArray(prompt) || !prompt.length) throw new Error("no prompt");
  const sessionId = randomUUID();
  const entries = transcript(history, { sessionId, model, cwd: CWD });
  const appended = [];
  const store = {
    async load(key) {
      return key.sessionId === sessionId && !key.subpath ? entries : null;
    },
    async append(key, batch) {
      if (!key.subpath) appended.push(...batch);
    }
  };
  // A config directory of its own for each turn, removed after: nothing of hers stays on the disk.
  const config = await mkdtemp(join(tmpdir(), "box-"));
  const env = {
    ...Object.fromEntries(PASSED.filter((name) => process.env[name]).map((name) => [name, process.env[name]])),
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    ...(typeof token === "string" && token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {})
  };
  const abortController = new AbortController();
  signal.addEventListener("abort", () => abortController.abort(), { once: true });
  const stream = replyStream((event) => write({ e: event }));
  let failure = null;
  try {
    const messages = query({
      prompt: (async function* () {
        yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, session_id: "" };
      })(),
      options: {
        ...(entries.length ? { resume: sessionId } : {}),
        sessionStore: store,
        sessionStoreFlush: "eager",
        cwd: CWD,
        model,
        tools: [],
        allowedTools: [],
        mcpServers: {},
        strictMcpConfig: true,
        settingSources: [],
        verbatimPrompts: true,
        systemPrompt: { type: "custom", prompt: system, snapshot: false },
        title: "resident",
        includePartialMessages: true,
        maxTurns: 1,
        ...(EFFORTS.has(effort) ? { effort } : {}),
        ...(thinking === "summarized" ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
        env,
        abortController
      }
    });
    for await (const message of messages) {
      if (message.type === "stream_event" && !message.parent_tool_use_id) stream.event(message.event);
      else if (message.type === "result" && message.is_error) {
        failure = String(message.errors?.join("; ") || message.result || message.subtype || "the turn failed").slice(0, 500);
      }
    }
  } catch (error) {
    failure = signal.aborted ? "cancelled" : String(error?.message ?? error).slice(0, 500);
  } finally {
    await rm(config, { recursive: true, force: true }).catch(() => {});
  }
  write(lastLine(stream, failure, appended));
}

export const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (request.method !== "POST" || request.url !== "/turn") {
    response.writeHead(404).end();
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
  server.listen(PORT, () => console.log(`claude box on :${PORT}`));
  // A rollout or a host move stops the container with SIGTERM: stop taking turns; the resident runs a cut one again.
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
