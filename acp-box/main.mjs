#!/usr/bin/env node
// The box: `node main.mjs`. It dials out to the resident and serves the plugs this machine can (Kiro, Claude).
//
//   First start, with the pairing code from the settings page (Pair a box):
//     node main.mjs --resident https://your-worker.workers.dev --code ABCD-EFGH
//   After that the box has its own token in the config folder and starts with no arguments:
//     node main.mjs
//
//   --resident <url>   the resident's address (with /r/<id> for a resident that is not the first)
//   --code <code>      the one-time pairing code; used once
//   --name <name>      what the settings page calls this box (default: the computer's name)
//   --home <folder>    the config folder (default ~/.config/aelios-box, or AELIOS_BOX_HOME)
//   --pair-only        pair and stop (for the installer)
//
// The helpers' keys are read from this machine: KIRO_API_KEY and CLAUDE_CODE_OAUTH_TOKEN in the environment, or the
// creds.json in the config folder (asked for once on a terminal). They never leave it.
import { channel } from "node:diagnostics_channel";
import { parseArgs } from "node:util";
import { terminalAsk } from "./ask.mjs";
import { configDir, loadCredentials, loadLink, saveLink } from "./config.mjs";
import { createEngines } from "./engines.mjs";
import { runLink } from "./link.mjs";
import { startLocal } from "./local.mjs";
import { computerName, linkUrl, pair, residentUrl } from "./pair.mjs";
import { byAddress } from "./session.mjs";

const { values } = parseArgs({ options: { resident: { type: "string" }, code: { type: "string" }, name: { type: "string" }, home: { type: "string" }, "pair-only": { type: "boolean" } } });
const dir = values.home || configDir();
const say = (text) => console.log(`aelios-box: ${text}`);
// Node can report a broken TCP socket here without firing WebSocket.onerror. This channel is process-wide.
channel("undici:websocket:socket_error").subscribe((error) => {
  say(`WebSocket transport error; ${JSON.stringify({ code: error.code ?? null, syscall: error.syscall ?? null })}`);
});

let link = await loadLink(dir);
if (values.code) {
  if (!values.resident) throw new Error("--code needs --resident <the resident's address>");
  link = await pair({ resident: residentUrl(values.resident), code: values.code, name: values.name });
  await saveLink(dir, link);
  say("paired; the token is kept in this machine's config folder");
  if (values["pair-only"]) process.exit(0);
} else if (!link) {
  throw new Error("this box is not paired yet: node main.mjs --resident <address> --code <pairing code from the settings page>");
}

const creds = await loadCredentials(dir, { ask: terminalAsk() });
const local = await startLocal();
const engines = createEngines(creds, { base: local.base });
const secrets = Object.values(creds);
const connection = runLink({ url: linkUrl(link.resident), token: link.token, name: values.name || computerName(), engines, secrets: () => secrets, log: say });

// Stopping: the link closes, and every live session goes with its home (the resident seeds new ones from the conversation).
const quit = async () => {
  connection.stop();
  local.server.close();
  await Promise.all([...byAddress.values()].map((session) => session.drop("the box stopped")));
  process.exit(0);
};
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
const { revoked } = await connection.finished;
if (revoked) process.exit(2);
