// Files the resident hands over in the chat itself (make_file): a document, a plan, a list, a page, instead of a
// long text to copy on a phone. The bytes go in the media store (media-store.ts) with the voice messages; this keeps
// each file's name and the reply it came with. Telegram and WeCom get it as a file; the web page shows it under the
// reply, to open and download.
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Sql } from "./sticker-store";

const NAME_MAX = 80;
const TEXT_MAX = 1024 * 1024;
export const FILES_PER_REPLY = 3;

export const MAKE_FILE_DESCRIPTION =
  "Give them a file instead of pasting a long text into the chat: a document, a plan, a list, a page, a table. " +
  "Write the whole content, and name it with an extension (.md, .txt, .html, .csv, .json). It goes to the chat they " +
  "wrote from (Telegram, WeCom) as a file, and shows under your reply on the web page, where they can open and " +
  "download it. Then say in a line or two what it is; don't paste it again.";

// Text types by extension; anything else is plain text.
const TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  html: "text/html",
  htm: "text/html",
  csv: "text/csv",
  json: "application/json"
};

/** A name to keep and send: no folders, quotes or control characters, at most 80 characters; .md without an extension. */
export function fileName(raw: string): string | null {
  const name = raw.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").trim().slice(0, NAME_MAX).trim();
  if (!name || /^\.+$/.test(name)) return null;
  return /\.[A-Za-z0-9]{1,8}$/.test(name) ? name : `${name}.md`;
}

export function fileType(name: string): string {
  const ext = name.split(".").pop()!.toLowerCase();
  return `${TYPES[ext] ?? "text/plain"}; charset=utf-8`;
}

export type MadeFile = { key: string; name: string; size: number };

export class MadeFiles {
  constructor(private readonly sql: Sql) {
    sql`CREATE TABLE IF NOT EXISTS res_made_files (key TEXT PRIMARY KEY, message TEXT NOT NULL, name TEXT NOT NULL,
      size INTEGER NOT NULL, at INTEGER NOT NULL)`;
  }

  add(key: string, name: string, size: number): void {
    this.sql`INSERT INTO res_made_files (key, message, name, size, at) VALUES (${key}, ${""}, ${name}, ${size}, ${Date.now()})`;
  }

  /** The files a turn made go with its reply. */
  withReply(keys: readonly string[], message: string): void {
    for (const key of keys) this.sql`UPDATE res_made_files SET message = ${message} WHERE key = ${key}`;
  }

  get(key: string): MadeFile | null {
    const [row] = this.sql<MadeFile>`SELECT key, name, size FROM res_made_files WHERE key = ${key}`;
    return row ?? null;
  }

  /** The files of these replies, by message id; ones the media store has let go of are left out. */
  ofReplies(messages: readonly string[]): Map<string, MadeFile[]> {
    const found = new Map<string, MadeFile[]>();
    if (!messages.length) return found;
    const wanted = new Set(messages);
    for (const row of this.sql<MadeFile & { message: string }>`SELECT f.key, f.name, f.size, f.message FROM res_made_files f
      JOIN res_media m ON m.key = f.key WHERE f.message != '' ORDER BY f.at`) {
      if (!wanted.has(row.message)) continue;
      found.set(row.message, [...(found.get(row.message) ?? []), { key: row.key, name: row.name, size: row.size }]);
    }
    return found;
  }
}

/** What make_file needs from the resident. */
export type FileHost = {
  /** The running turn, or null when no file can go out from it (the letter). */
  turn(): string | null;
  /** Files the turn has made already. */
  made(turn: string): number;
  /** Keeps the bytes (media-store.ts), and the file for the turn's reply. */
  keep(turn: string, name: string, type: string, bytes: Uint8Array): { key: string } | { error: string };
  /** Sends it to the chat the turn answers; where it went ("Telegram", "WeCom"), or null when that is the web page. */
  send(turn: string, file: { name: string; type: string; bytes: Uint8Array }): Promise<string | null>;
};

export function fileTools(host: FileHost): ToolSet {
  return {
    make_file: tool({
      description: MAKE_FILE_DESCRIPTION,
      inputSchema: z.object({
        name: z.string().describe("The file's name with its extension, in their language, like 方案.md."),
        content: z.string().describe("The whole text of the file.")
      }),
      execute: async ({ name, content }) => makeFile(host, name, content)
    })
  };
}

async function makeFile(host: FileHost, rawName: string, content: string): Promise<Record<string, unknown>> {
  const turn = host.turn();
  if (!turn) return { error: "No files from here." };
  if (host.made(turn) >= FILES_PER_REPLY) return { error: `At most ${FILES_PER_REPLY} files per reply.` };
  const name = fileName(rawName);
  if (!name) return { error: "Give the file a name, like 方案.md." };
  const bytes = new TextEncoder().encode(content);
  if (!content.trim()) return { error: "The file is empty: write its whole content." };
  if (bytes.length > TEXT_MAX) return { error: `Too long for one file (at most ${TEXT_MAX / 1024} KB): split it.` };
  const type = fileType(name);
  const kept = host.keep(turn, name, type, bytes);
  if ("error" in kept) return kept;
  try {
    const where = await host.send(turn, { name, type, bytes });
    return { made: name, size: bytes.length, note: where ? `Sent to ${where} as a file, and shown under your reply on the web page.` : "Shown under your reply on the web page." };
  } catch (error) {
    // The web page has it either way.
    return { made: name, size: bytes.length, note: `Not sent to their chat (${String(error instanceof Error ? error.message : error).slice(0, 160)}); it shows under your reply on the web page.` };
  }
}
