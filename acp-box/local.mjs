// The box's loopback MCP server: where a helper (Kiro, Claude Code) calls the resident's tools. It listens on
// 127.0.0.1 only, on a port the system picks, and each run has its own address and a key only its helper has. It is
// not how the resident reaches the box: that is the outbound socket (link.mjs).
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { runs } from "./claude/run.mjs";
import { byAddress } from "./session.mjs";
import { mcp } from "./tools.mjs";

const MAX_BODY = 8 * 1024 * 1024;
const KEEP_ALIVE_MS = 10 * 60_000;
const HEADERS_MS = KEEP_ALIVE_MS + 5_000;

function carries(request, key) {
  const given = Buffer.from(String(request.headers.authorization ?? ""));
  const wanted = Buffer.from(`Bearer ${key}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
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

/** Starts the server; `base()` is its address for a helper's config. */
export async function startLocal() {
  const server = http.createServer(async (request, response) => {
    const address = new URL(request.url ?? "/", "http://box").pathname.match(/^\/mcp\/([0-9a-f-]{36})$/);
    const run = address ? (byAddress.get(address[1]) ?? runs.get(address[1])) : null;
    if (!run || !carries(request, run.secret)) return void response.writeHead(404).end();
    if (request.method !== "POST") return void response.writeHead(405).end();
    let message;
    try {
      message = await readJson(request);
    } catch {
      return void response.writeHead(400).end();
    }
    if (response.destroyed) return;
    const abort = new AbortController();
    const onClose = () => {
      if (!response.writableFinished) abort.abort();
    };
    response.on("close", onClose);
    let answer;
    try {
      answer = await mcp(run, message, abort.signal);
    } finally {
      response.off("close", onClose);
    }
    if (response.destroyed || response.writableEnded) return;
    if (!answer) return void response.writeHead(202).end();
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
  });
  server.requestTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = HEADERS_MS;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: () => `http://127.0.0.1:${server.address().port}` };
}
