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
/**
 * What all voice, read-out, handed-over and group picture files together may take; the oldest go first. Avatars and
 * icons are never pruned, and neither are voices she keeps (keep), which do not count towards it either.
 */
const KEEP_BYTES = 200 * 1024 * 1024;

/** A voice message, hers or the resident's, kept from being pruned (keep): what was said and where its audio is. */
export type KeptVoice = {
  /** The message it belongs to. */
  message: string;
  role: "user" | "assistant";
  text: string;
  /** Its audio: one file, or a reply said in parts. */
  keys: string[];
  seconds: number | null;
  /** When it was said, and when she kept it. */
  at: number | null;
  keptAt: number;
  /** The precious memory it went into in Aelios, if it did. */
  memory: string | null;
};

type KeptRow = { message: string; role: "user" | "assistant"; text: string; keys: string; seconds: number | null; said_at: number | null;
  kept_at: number; memory: string | null };

function keptOf(row: KeptRow): KeptVoice {
  return { message: row.message, role: row.role, text: row.text, keys: JSON.parse(row.keys), seconds: row.seconds, at: row.said_at,
    keptAt: row.kept_at, memory: row.memory };
}

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
  /**
   * `onFileRemoved`: a handed-over file is gone. `onAwayRemoved`: a file whose bytes were sent away (sendAway, to the
   * R2 bucket for kept voices) is gone, and its copy there is now to clear (toClear). `sentAwayAs`: the name a file
   * sent away by an earlier version went under, which wrote no name down.
   */
  constructor(
    private readonly sql: Sql,
    private readonly onFileRemoved?: (key: string) => void,
    private readonly onAwayRemoved?: () => void,
    sentAwayAs?: (key: string) => string
  ) {
    sql`CREATE TABLE IF NOT EXISTS res_media (key TEXT PRIMARY KEY, kind TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL,
      seconds REAL, at INTEGER NOT NULL)`;
    // kept: a voice she kept, never pruned. away: its bytes are not in res_media_pieces but elsewhere (sendAway), in
    // away_to: a name new each time it goes, so a late delete of an earlier copy never reaches the one there now.
    const columns = sql<{ name: string }>`PRAGMA table_info(res_media)`.map(column => column.name);
    if (!columns.includes("kept")) sql`ALTER TABLE res_media ADD COLUMN kept INTEGER NOT NULL DEFAULT 0`;
    if (!columns.includes("away")) sql`ALTER TABLE res_media ADD COLUMN away INTEGER NOT NULL DEFAULT 0`;
    if (!columns.includes("away_to")) sql`ALTER TABLE res_media ADD COLUMN away_to TEXT`;
    // The voices she kept, by message (keys: a JSON array of res_media keys). One let go keeps its row, marked let_go,
    // so keeping it again finds the precious memory it already went into instead of making another.
    sql`CREATE TABLE IF NOT EXISTS res_media_kept (message TEXT PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, keys TEXT NOT NULL,
      seconds REAL, said_at INTEGER, kept_at INTEGER NOT NULL, memory TEXT)`;
    if (!sql<{ name: string }>`PRAGMA table_info(res_media_kept)`.some(column => column.name === "let_go")) {
      sql`ALTER TABLE res_media_kept ADD COLUMN let_go INTEGER`;
    }
    // The copies elsewhere that no file points to (any more, or yet), to clear there (toClear, cleared). Every copy
    // there is either a file's away_to or in here: written before a copy is made, taken out once a file points to it,
    // put back when nothing does, and only taken out for good once deleting it there has worked.
    sql`CREATE TABLE IF NOT EXISTS res_media_gone (object TEXT PRIMARY KEY)`;
    // Before anything can remove one of them, so its copy is never lost track of.
    if (sentAwayAs) {
      for (const { key } of sql<{ key: string }>`SELECT key FROM res_media WHERE away = 1 AND away_to IS NULL`) {
        sql`UPDATE res_media SET away_to = ${sentAwayAs(key)} WHERE key = ${key}`;
      }
    }
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
    const [removed] = this.sql<{ kind: MediaKind; away: number; away_to: string | null }>`DELETE FROM res_media WHERE key = ${key}
      RETURNING kind, away, away_to`;
    this.sql`DELETE FROM res_media_spoken WHERE key = ${key} OR EXISTS (
      SELECT 1 FROM json_each(res_media_spoken.parts) WHERE json_extract(value, '$.key') = ${key}
    )`;
    this.sql`DELETE FROM res_media_kept WHERE EXISTS (SELECT 1 FROM json_each(res_media_kept.keys) WHERE value = ${key})`;
    if (removed?.kind === "file") this.onFileRemoved?.(key);
    if (removed?.away && removed.away_to) {
      this.sql`INSERT OR IGNORE INTO res_media_gone (object) VALUES (${removed.away_to})`;
      this.onAwayRemoved?.();
    }
  }

  // ---- voices she keeps: never pruned, listed on the web page's 语音收藏 ----

  /** Keeps a voice message: its files are no longer pruned. Says whether every file of it is still here to keep. */
  keep(voice: Omit<KeptVoice, "keptAt" | "memory">): boolean {
    if (!voice.keys.length || voice.keys.some(key => !this.kindOf(key))) return false;
    for (const key of voice.keys) this.sql`UPDATE res_media SET kept = 1 WHERE key = ${key}`;
    // Kept before: still kept, it keeps when; let go, it is kept anew. Its precious memory stays either way.
    const [had] = this.sql<KeptRow & { let_go: number | null }>`SELECT * FROM res_media_kept WHERE message = ${voice.message}`;
    const keptAt = had && had.let_go === null ? had.kept_at : Date.now();
    this.sql`INSERT OR REPLACE INTO res_media_kept (message, role, text, keys, seconds, said_at, kept_at, memory, let_go)
      VALUES (${voice.message}, ${voice.role}, ${voice.text}, ${JSON.stringify(voice.keys)}, ${voice.seconds}, ${voice.at},
        ${keptAt}, ${had?.memory ?? null}, NULL)`;
    return true;
  }

  /** The precious memory in Aelios a kept voice went into. */
  keptInMemory(message: string, memory: string): void {
    this.sql`UPDATE res_media_kept SET memory = ${memory} WHERE message = ${message}`;
  }

  /** A voice kept no more: its files are pruned like any other from now on (the next put, or prune()). */
  unkeep(message: string): KeptVoice | null {
    const voice = this.kept(message);
    if (!voice) return null;
    this.sql`UPDATE res_media_kept SET let_go = ${Date.now()} WHERE message = ${message}`;
    for (const key of voice.keys) this.sql`UPDATE res_media SET kept = 0 WHERE key = ${key}`;
    return voice;
  }

  kept(message: string): KeptVoice | null {
    const [row] = this.sql<KeptRow>`SELECT * FROM res_media_kept WHERE message = ${message} AND let_go IS NULL`;
    return row ? keptOf(row) : null;
  }

  /** Every kept voice, the latest said first. */
  keptVoices(): KeptVoice[] {
    return this.sql<KeptRow>`SELECT * FROM res_media_kept WHERE let_go IS NULL
      ORDER BY COALESCE(said_at, kept_at) DESC`.map(keptOf);
  }

  /** Which of these messages have a kept voice. */
  keptAmong(messages: readonly string[]): Set<string> {
    const wanted = new Set(messages);
    return new Set(this.sql<{ message: string }>`SELECT message FROM res_media_kept WHERE let_go IS NULL`.map(row => row.message).filter(id => wanted.has(id)));
  }

  /** Whether a file belongs to a kept voice. */
  isKeptFile(key: string): boolean {
    return this.sql<{ kept: number }>`SELECT kept FROM res_media WHERE key = ${key}`[0]?.kept === 1;
  }

  /** A file's type and length, without its bytes. */
  about(key: string): { type: string; seconds: number | null } | null {
    return this.sql<{ type: string; seconds: number | null }>`SELECT type, seconds FROM res_media WHERE key = ${key}`[0] ?? null;
  }

  /** Whether a file's bytes were sent away (sendAway). */
  isAway(key: string): boolean {
    return this.awayTo(key) !== null;
  }

  /** Where a file's bytes were sent (sendAway), or null while they are here. */
  awayTo(key: string): string | null {
    const [row] = this.sql<{ away: number; away_to: string | null }>`SELECT away, away_to FROM res_media WHERE key = ${key}`;
    return row?.away ? row.away_to : null;
  }

  /** A copy is about to be made at `object`: until a file points to it (sendAway), it is to clear. */
  copying(object: string): void {
    this.sql`INSERT OR IGNORE INTO res_media_gone (object) VALUES (${object})`;
  }

  /**
   * The bytes of a kept file, now also at `object` (copying), leave SQLite; its row stays, with its type and length.
   * Only while it is still kept and here: false otherwise (let go or sent already), and that copy stays to clear.
   */
  sendAway(key: string, object: string): boolean {
    if (!this.sql<{ key: string }>`UPDATE res_media SET away = 1, away_to = ${object}
      WHERE key = ${key} AND kept = 1 AND away = 0 RETURNING key`.length) return false;
    this.sql`DELETE FROM res_media_pieces WHERE key = ${key}`;
    this.sql`DELETE FROM res_media_gone WHERE object = ${object}`;
    return true;
  }

  /** The bytes of a file sent away to `object`, back in SQLite. Nothing changes when it is no longer there. */
  bringBack(key: string, object: string, bytes: Uint8Array): void {
    const [row] = this.sql<{ size: number; away: number; away_to: string | null }>`SELECT size, away, away_to FROM res_media WHERE key = ${key}`;
    if (!row?.away || row.away_to !== object || bytes.length !== row.size) return;
    this.sql`DELETE FROM res_media_pieces WHERE key = ${key}`;
    for (let at = 0, n = 0; at < bytes.length; at += PIECE_BYTES, n += 1) {
      this.sql`INSERT INTO res_media_pieces (key, n, bytes) VALUES (${key}, ${n}, ${buffer(bytes.subarray(at, at + PIECE_BYTES))})`;
    }
    this.sql`UPDATE res_media SET away = 0, away_to = NULL WHERE key = ${key}`;
    this.sql`INSERT OR IGNORE INTO res_media_gone (object) VALUES (${object})`;
  }

  /** Whether anything is elsewhere: a file sent away (sendAway), or a copy still to clear (toClear). */
  anyAway(): boolean {
    return this.sql<{ key: string }>`SELECT key FROM res_media WHERE away = 1 LIMIT 1`.length > 0 || this.toClear().length > 0;
  }

  /** The copies elsewhere no file points to, still to clear there. */
  toClear(): string[] {
    return this.sql<{ object: string }>`SELECT object FROM res_media_gone`.map(row => row.object);
  }

  /** That copy is cleared there now: deleting it worked, or it was not there. */
  cleared(object: string): void {
    this.sql`DELETE FROM res_media_gone WHERE object = ${object}`;
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

  /** Keeps voice files under KEEP_BYTES together, the oldest going first; kept voices neither go nor count. */
  prune(): void {
    const rows = this.sql<{ key: string; size: number }>`SELECT key, size FROM res_media WHERE kind != 'avatar' AND kept = 0 AND away = 0
      ORDER BY at DESC`;
    let total = 0;
    for (const row of rows) {
      total += row.size;
      if (total > KEEP_BYTES) this.remove(row.key);
    }
  }
}
