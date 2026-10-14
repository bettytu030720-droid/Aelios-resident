// Stands in for the Telegram Bot API and Aelios during local tests. Records every call.
import http from "node:http";

const log = [];
let nextMessageId = 1000;

const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const json = body ? JSON.parse(body) : undefined;
  const url = new URL(req.url, "http://x");
  const reply = (obj, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === "/__log") return reply(log);
  if (url.pathname === "/__reset") {
    log.length = 0;
    return reply({ ok: true });
  }

  const tg = url.pathname.match(/^\/bot[^/]+\/(\w+)$/);
  if (tg) {
    const method = tg[1];
    log.push({ kind: `tg.${method}`, body: json });
    const chat = { id: Number(json?.chat_id ?? 42), type: "private" };
    const message = () => ({ message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat, text: json?.text });
    switch (method) {
      case "getMe":
        return reply({ ok: true, result: { id: 777, is_bot: true, first_name: "Resident", username: "resident_test_bot" } });
      case "sendMessage":
      case "editMessageText":
        return reply({ ok: true, result: message() });
      case "sendChatAction":
      case "setWebhook":
      case "setMyCommands":
        return reply({ ok: true, result: true });
      default:
        // e.g. sendRichMessage: an older Bot API, so the adapter falls back to sendMessage.
        return reply({ ok: false, error_code: 404, description: "Not Found: method not found" }, 404);
    }
  }
  const auth = req.headers.authorization;
  if (url.pathname === "/v1/memory/recall") {
    log.push({ kind: "aelios.recall", body: json, auth });
    // Only a question about her birthday finds something, so ordinary test messages recall nothing.
    const hit = { id: "mem-birthday", content: "她的生日在春天", type: "fact", score: 0.9 };
    return reply({ data: String(json.query ?? "").includes("生日") ? [hit] : [] });
  }
  // Aelios' own stateless MCP server, answering tools/call with plain JSON.
  if (url.pathname === "/mcp") {
    log.push({ kind: "aelios.mcp", body: json, auth });
    const text = JSON.stringify({ data: { id: "mem-new", created: true } });
    return reply({ jsonrpc: "2.0", id: json.id, result: { content: [{ type: "text", text }] } });
  }
  if (url.pathname === "/v1/memory/ingest") {
    log.push({ kind: "aelios.ingest", body: json, auth });
    return reply({ data: { conversation_id: json.conversation_id, message_ids: [] } });
  }
  if (url.pathname === "/v1/precious") {
    log.push({ kind: "aelios.precious", body: json, auth });
    return reply({ data: { id: "p1", content: json.content } }, 201);
  }
  if (url.pathname === "/v1/memory_boot") {
    log.push({ kind: "aelios.boot", query: url.search, auth });
    return reply({
      data: {
        daily_log: { title: "闲聊日", summary: "昨天你们聊了周末去哪儿玩。" },
        precious: [{ content: "说好了要一起去看海。" }],
        glossary: [{ term: "小橘", definition: "楼下那只猫" }]
      }
    });
  }
  res.writeHead(404);
  res.end();
});
server.listen(9999, "127.0.0.1", () => console.log("mock on 9999"));
