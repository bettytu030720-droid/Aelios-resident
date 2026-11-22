// Audio and pictures the web door keeps for itself, in the resident's own SQLite: voice messages she records on the
// web page, the voice the resident answers in there or reads a message out in, the avatar and the group chats'
// icons, the files it hands over in the chat (made-files.ts), and pictures she sends in a group chat (group.ts). A
// Durable Object's SQLite takes at most 2 MB in one row, so a file goes in pieces. Pictures she sends in the chat
// stay in the conversation itself (pictures.ts); they are not copied here.

import type { Sql } from "./sticker-store";
import { playbackOf, type VoiceClip, type VoicePlayback } from "./web/reply-voice";

export type MediaKind = "voice" | "spoken" | "avatar" | "file" | "picture";

/** One piece of a file per row, under the 2 MB a row can hold. */
const PIECE_BYTES = 1024 * 1024;
/** The most one file may be: a minute and a half of 16 kHz WAV, or a long reply read out in MP3. */
export const MEDIA_MAX_BYTES = 6 * 1024 * 1024;
/** What all voice, read-out, handed-over and group picture files together may take; the oldest go first. Avatars and icons are never pruned. */
const KEEP_BYTES = 200 * 1024 * 1024;

export type MediaFile = { type: string; bytes: Uint8Array; seconds: number | null };

type StoredVoice = VoiceClip & { parts: string | null };

function storedPlayback(row: StoredVoice): VoicePlayback {
  const base = { key: row.key, seconds: row.seconds };
  return row.parts ? playbackOf(JSON.parse(row.parts)) ?? base : base;
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function newKey(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export class MediaStore {
  constructor(private readonly sql: Sql) {
    sql`CREATE TABLE IF NOT EXISTS res_media (key TEXT PRIMARY KEY, kind TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL,
      seconds REAL, at INTEGER NOT NULL)`;
    sql`CREATE TABLE IF NOT EXISTS res_media_pieces (key TEXT NOT NULL, n INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (key, n))`;
    // The text made from a kept file (a PDF or Office document), kept as a file of its own: original key -> text key.
    sql`CREATE TABLE IF NOT EXISTS res_media_text (key TEXT PRIMARY KEY, text_key TEXT NOT NULL)`;
    // The voice a reply was said in, or read out in afterwards, by the reply's message id.
    sql`CREATE TABLE IF NOT EXISTS res_media_spoken (message TEXT PRIMARY KEY, key TEXT NOT NULL, at INTEGER NOT NULL, parts TEXT)`;
    if (!sql<{ name: string }>`PRAGMA table_info(res_media_spoken)`.some(column => column.name === "parts")) {
      sql`ALTER TABLE res_media_spoken ADD COLUMN parts TEXT`;
    }
    sql`CREATE INDEX IF NOT EXISTS res_media_spoken_key ON res_media_spoken (key)`;
  }

  /** Keeps a file and returns its key (32 hex characters), or why it was not kept. */
  put(kind: MediaKind, type: string, bytes: Uint8Array, seconds: number | null = null): { key: string } | { error: string } {
    if (!bytes.length) return { error: "空的文件" };
    if (bytes.length > MEDIA_MAX_BYTES) return { error: `文件太大了，最多 ${MEDIA_MAX_BYTES / 1024 / 1024} MB` };
    const key = newKey();
    const now = Date.now();
    for (let at = 0, n = 0; at < bytes.length; at += PIECE_BYTES, n += 1) {
      this.sql`INSERT INTO res_media_pieces (key, n, bytes) VALUES (${key}, ${n}, ${buffer(bytes.subarray(at, at + PIECE_BYTES))})`;
    }
    this.sql`INSERT INTO res_media (key, kind, type, size, seconds, at) VALUES (${key}, ${kind}, ${type}, ${bytes.length},
      ${seconds}, ${now})`;
    if (kind !== "avatar") this.prune();
    return { key };
  }

  get(key: string): MediaFile | null {
    const [row] = this.sql<{ type: string; size: number; seconds: number | null }>`SELECT type, size, seconds FROM res_media WHERE key = ${key}`;
    if (!row) return null;
    const pieces = this.sql<{ bytes: ArrayBuffer }>`SELECT bytes FROM res_media_pieces WHERE key = ${key} ORDER BY n`;
    const bytes = new Uint8Array(row.size);
    let at = 0;
    for (const piece of pieces) {
      const part = new Uint8Array(piece.bytes);
      bytes.set(part.subarray(0, Math.max(0, row.size - at)), at);
      at += part.length;
    }
    return at >= row.size ? { type: row.type, bytes, seconds: row.seconds } : null;
  }

  /** A kept file's media type, without reading the file. */
  typeOf(key: string): string | null {
    return this.sql<{ type: string }>`SELECT type FROM res_media WHERE key = ${key}`[0]?.type ?? null;
  }

  /** Keeps `text` as the readable text of the file `key`. */
  putText(key: string, text: string): void {
    const saved = this.put("file", "text/markdown", new TextEncoder().encode(text));
    if ("key" in saved) this.sql`INSERT OR REPLACE INTO res_media_text (key, text_key) VALUES (${key}, ${saved.key})`;
  }

  /** The key of the text kept for a file, if there is one. */
  textKeyOf(key: string): string | null {
    return this.sql<{ text_key: string }>`SELECT text_key FROM res_media_text WHERE key = ${key}`[0]?.text_key ?? null;
  }

  kindOf(key: string): MediaKind | null {
    const [row] = this.sql<{ kind: MediaKind }>`SELECT kind FROM res_media WHERE key = ${key}`;
    return row?.kind ?? null;
  }

  remove(key: string): void {
    const text = this.textKeyOf(key);
    this.sql`DELETE FROM res_media_text WHERE key = ${key}`;
    if (text) this.remove(text);
    this.sql`DELETE FROM res_media_pieces WHERE key = ${key}`;
    this.sql`DELETE FROM res_media WHERE key = ${key}`;
    this.sql`DELETE FROM res_media_spoken WHERE key = ${key} OR EXISTS (
      SELECT 1 FROM json_each(res_media_spoken.parts) WHERE json_extract(value, '$.key') = ${key}
    )`;
  }

  /** The voice a reply was said in, if it was. */
  spokenFor(message: string): VoicePlayback | null {
    const [row] = this.sql<StoredVoice>`SELECT s.key, s.parts, m.seconds FROM res_media_spoken s
      JOIN res_media m ON s.key = m.key WHERE s.message = ${message}`;
    return row ? storedPlayback(row) : null;
  }

  /** The voices of these replies, by message id. */
  spokenOf(messages: readonly string[]): Map<string, VoicePlayback> {
    const found = new Map<string, VoicePlayback>();
    if (!messages.length) return found;
    const wanted = new Set(messages);
    for (const row of this.sql<StoredVoice & { message: string }>`SELECT s.message, s.key, s.parts, m.seconds
      FROM res_media_spoken s JOIN res_media m ON s.key = m.key`) {
      if (wanted.has(row.message)) found.set(row.message, storedPlayback(row));
    }
    return found;
  }

  saySpoken(message: string, key: string, clips?: VoiceClip[]): void {
    const parts = clips && clips.length > 1 ? JSON.stringify(clips) : null;
    this.sql`INSERT OR REPLACE INTO res_media_spoken (message, key, at, parts)
      VALUES (${message}, ${key}, ${Date.now()}, ${parts})`;
  }

  spokenParts(key: string): VoiceClip[] | null {
    const [row] = this.sql<{ parts: string }>`SELECT parts FROM res_media_spoken WHERE key = ${key} AND parts IS NOT NULL`;
    return row ? JSON.parse(row.parts) : null;
  }

  removeSpoken(message: string): void {
    const voice = this.spokenFor(message);
    if (voice) for (const key of voice.parts ?? [voice.key]) this.remove(key);
  }

  /** Keeps voice files under KEEP_BYTES together, the oldest going first. */
  private prune(): void {
    const rows = this.sql<{ key: string; size: number }>`SELECT key, size FROM res_media WHERE kind != 'avatar' ORDER BY at DESC`;
    let total = 0;
    for (const row of rows) {
      total += row.size;
      if (total > KEEP_BYTES) this.remove(row.key);
    }
  }
}
