// The box's side of the socket (protocol: src/box-protocol.ts, `aelios-box/1`). The box dials out to the resident and
// keeps the connection, with a ping every 25 seconds the resident's runtime answers without waking its object. On
// every connection it says hello (name, the plugs it can serve now, and the ones it cannot with a one-line reason).
// The resident sends turns down; the box streams each reply back a line at a time. No port is opened for this.
//
// It reconnects with backoff after any loss. A close with code 4401 means the token was revoked: it stops for good.
// Frames the protocol does not name are dropped, and `secrets` (the helpers' keys) are blanked out of anything sent,
// as a last guard: nothing of them is meant to be there.
const PROTOCOL = "aelios-box/1";
const PING_MS = 25_000;
const SILENT_MS = 75_000;
const RECHECK_MS = 5 * 60_000;
const TURN_FIELDS = ["t", "id", "plug", "body"];
const CANCEL_FIELDS = ["t", "id"];
export const REVOKED = 4401;

/** Whether an object has exactly these fields and no others. */
const only = (frame, fields) => Object.keys(frame).every((key) => fields.includes(key)) && fields.every((key) => key in frame);

export function runLink({ url, token, name, engines, secrets = () => [], WebSocketImpl = WebSocket, log = () => {}, backoff = { min: 1000, max: 60_000 } }) {
  let stopped = false;
  let socket = null;
  let closeSocket = null;
  let wait = backoff.min;
  let ended;
  const finished = new Promise((resolve) => (ended = resolve));
  const running = new Map();
  // What the last hello said: a plug that is down is never run, whatever a turn asks.
  let offered = { up: [], down: {} };

  const blank = (text) => secrets().reduce((out, secret) => (secret ? out.split(secret).join("[key]") : out), text);
  const logText = (value) => {
    if (!value) return null;
    const text = String(value);
    return blank(token ? text.split(token).join("[key]") : text).slice(0, 240);
  };
  const send = (frame) => {
    if (socket?.readyState === 1) socket.send(blank(JSON.stringify(frame)));
  };

  /** What can be served now, and what cannot with why. */
  async function plugs() {
    const up = [];
    const down = {};
    for (const [plug, engine] of Object.entries(engines)) {
      const why = await engine.check().catch((error) => String(error?.message ?? error));
      if (why) down[plug] = String(why).slice(0, 140);
      else up.push(plug);
    }
    return { up, down };
  }

  async function turn(frame) {
    const { id, plug, body } = frame;
    const engine = engines[plug];
    const stop = new AbortController();
    running.set(id, stop);
    try {
      if (!engine || !offered.up.includes(plug) || !body || typeof body !== "object") {
        const why = offered.down[plug] ? `: ${offered.down[plug]}` : "";
        send({ t: "line", id, line: { error: `this box cannot serve ${String(plug).slice(0, 20)} now${why}` } });
      }
      else await engine.turn(body, (line) => send({ t: "line", id, line }), stop.signal);
    } catch (error) {
      send({ t: "line", id, line: { error: String(error?.message ?? error).slice(0, 400) } });
    } finally {
      running.delete(id);
      send({ t: "end", id });
    }
  }

  async function connect() {
    if (stopped) return;
    const now = await plugs();
    if (stopped) return;
    offered = now;
    const ws = new WebSocketImpl(url, { headers: { authorization: `Bearer ${token}` } });
    socket = ws;
    let heard = Date.now();
    let openedAt = null;
    let lastPing = null;
    let lastPong = null;
    let localClose = null;
    const close = (code, reason) => {
      if (ws.readyState < 2 && !localClose) {
        localClose = reason;
        log(`closing WebSocket; ${reason}`);
      }
      ws.close(code, reason);
    };
    closeSocket = close;
    let timers = [];
    ws.onopen = () => {
      openedAt = Date.now();
      wait = backoff.min;
      send({ t: "hello", proto: PROTOCOL, name, plugs: now.up, down: now.down });
      log(`connected; plugs: ${now.up.join(", ") || "none"}${Object.keys(now.down).length ? `; unavailable: ${Object.entries(now.down).map(([p, w]) => `${p} (${w})`).join("; ")}` : ""}`);
      timers = [
        setInterval(() => {
          if (Date.now() - heard > SILENT_MS) return close(4000, "silent");
          lastPing = Date.now();
          ws.send("ping");
        }, PING_MS),
        // A plug that came up (IPv4 egress, a key) or went down is announced by a fresh hello on a fresh connection.
        setInterval(async () => {
          if (JSON.stringify(await plugs()) !== JSON.stringify(now)) close(1000, "plugs changed");
        }, RECHECK_MS)
      ];
    };
    ws.onmessage = (event) => {
      heard = Date.now();
      if (event.data === "pong") {
        lastPong = heard;
        return;
      }
      if (typeof event.data !== "string") return;
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
      if (frame.t === "turn" && only(frame, TURN_FIELDS) && typeof frame.id === "string" && !running.has(frame.id)) void turn(frame);
      else if (frame.t === "cancel" && only(frame, CANCEL_FIELDS)) running.get(frame.id)?.abort();
    };
    ws.onclose = (event) => {
      timers.forEach(clearInterval);
      if (socket === ws) {
        socket = null;
        closeSocket = null;
      }
      const at = Date.now();
      const age = (stamp) => stamp === null ? null : at - stamp;
      log(`disconnected; ${JSON.stringify({
        code: event.code, reason: logText(event.reason), wasClean: event.wasClean, localClose,
        openMs: age(openedAt), lastPingAgoMs: age(lastPing), lastPongAgoMs: age(lastPong), activeTurns: running.size
      })}`);
      // What was running on the lost connection has nowhere to answer: it stops.
      for (const stop of running.values()) stop.abort();
      if (stopped) return;
      if (event.code === REVOKED) {
        stopped = true;
        log("this box was revoked on the settings page: pair it again with a new code");
        return ended({ revoked: true });
      }
      log(`trying again in ${Math.round(wait / 1000)}s`);
      setTimeout(connect, wait * (1 + Math.random() / 4));
      wait = Math.min(wait * 2, backoff.max);
    };
    ws.onerror = (event) => {
      const error = event.error;
      log(`WebSocket error; ${JSON.stringify({
        message: logText(event.message || error?.message), code: logText(error?.code),
        cause: logText(error?.cause?.message), causeCode: logText(error?.cause?.code)
      })}`);
    };
  }

  void connect();
  return {
    finished,
    stop() {
      stopped = true;
      for (const stop of running.values()) stop.abort();
      closeSocket?.(1000, "stopping");
      ended({ revoked: false });
    }
  };
}
