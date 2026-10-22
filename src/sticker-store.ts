// The sticker packs in the resident's own SQLite: the pictures, what each is for, and the file id Telegram keeps
// each under once sent, so it is uploaded only the first time.

import {
  MAX_LISTED,
  MAX_LISTED_TOKENS,
  MAX_OWN,
  MAX_PACKS,
  OWN_PACK,
  catalogLine,
  tokensOf,
  type NewSticker,
  type PackInfo,
  type StickerFile
} from "./stickers";
import { mediaKindOf, type MediaKind } from "./telegram";

type Value = string | number | ArrayBuffer | null;
export type Sql = <T>(strings: TemplateStringsArray, ...values: Value[]) => T[];

export type PackSource = "zip" | "telegram" | "own";

/** A sticker from a Telegram pack: sent by its file id, shown on the web page from `webRemote` once fetched. */
export type RemoteSticker = { name: string; emoji: string; when: string; fileId: string; webRemote: string; webType: string };

export type StickerView = { key: string; name: string; emoji: string; when: string; video: boolean };

export type PackView = PackInfo & { source: PackSource; enabled: boolean; tokens: number; stickers: StickerView[] };

type PackRow = { id: string; name: string; info: string; source: PackSource; enabled: number; at: number };

type Row = {
  key: string;
  pack: string;
  name: string;
  emoji: string;
  when_text: string;
  web_type: string;
  has_web: number;
  web_remote: string | null;
  tg_type: string | null;
  tg_file: string | null;
  tg_kind: string | null;
};

const own: PackInfo = { id: OWN_PACK, name: "它自己画的", description: "", author: "", license: "", homepage: "" };

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function newKey(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

export class StickerStore {
  constructor(private readonly sql: Sql) {
    sql`CREATE TABLE IF NOT EXISTS res_sticker_packs (id TEXT PRIMARY KEY, name TEXT NOT NULL, info TEXT NOT NULL,
      source TEXT NOT NULL, enabled INTEGER NOT NULL, at INTEGER NOT NULL)`;
    sql`CREATE TABLE IF NOT EXISTS res_stickers (key TEXT PRIMARY KEY, pack TEXT NOT NULL, name TEXT NOT NULL,
      emoji TEXT NOT NULL, when_text TEXT NOT NULL, seq INTEGER NOT NULL, web BLOB, web_type TEXT NOT NULL, web_remote TEXT,
      tg BLOB, tg_type TEXT, tg_file TEXT, tg_kind TEXT, at INTEGER NOT NULL)`;
    sql`CREATE UNIQUE INDEX IF NOT EXISTS res_stickers_name ON res_stickers (pack, name)`;
  }

  private packRows(): PackRow[] {
    return this.sql<PackRow>`SELECT id, name, info, source, enabled, at FROM res_sticker_packs
      ORDER BY CASE WHEN id = ${OWN_PACK} THEN 0 ELSE 1 END, at`;
  }

  private rows(pack: string): Row[] {
    return this.sql<Row>`SELECT key, pack, name, emoji, when_text, web_type, web IS NOT NULL AS has_web, web_remote,
      tg_type, tg_file, tg_kind FROM res_stickers WHERE pack = ${pack} ORDER BY seq`;
  }

  /**
   * The stickers the model can send, in a fixed order (so the prompt cache keeps hitting), as `pack/name emoji when`:
   * its own first, then the packs in the order they came, up to MAX_LISTED of them and about MAX_LISTED_TOKENS.
   */
  listed(): string[] {
    return this.catalog().lines;
  }

  /** listed(), and how many stickers of the packs that are on it left out. */
  catalog(): { lines: string[]; left: number } {
    const lines: string[] = [];
    let tokens = 0;
    let left = 0;
    for (const pack of this.packRows().filter((row) => row.enabled)) {
      for (const row of this.rows(pack.id)) {
        const line = catalogLine(pack.id, { name: row.name, emoji: row.emoji, when: row.when_text });
        const cost = tokensOf([line]);
        if (left || lines.length >= MAX_LISTED || tokens + cost > MAX_LISTED_TOKENS) left += 1;
        else {
          lines.push(line);
          tokens += cost;
        }
      }
    }
    return { lines, left };
  }

  /** A sticker by `pack/name`; `enabledOnly` for one the model may send now. */
  find(handle: string, enabledOnly = true): Row | null {
    const cut = handle.trim().indexOf("/");
    if (cut < 0) return null;
    const pack = handle.trim().slice(0, cut).toLowerCase();
    const name = handle.trim().slice(cut + 1);
    const [row] = this.sql<Row & { enabled: number }>`SELECT s.key, s.pack, s.name, s.emoji, s.when_text, s.web_type,
      s.web IS NOT NULL AS has_web, s.web_remote, s.tg_type, s.tg_file, s.tg_kind, p.enabled
      FROM res_stickers s JOIN res_sticker_packs p ON p.id = s.pack WHERE s.pack = ${pack} AND s.name = ${name}`;
    if (!row || (enabledOnly && !row.enabled)) return null;
    return row;
  }

  /** Where a new pack goes: its own id, or the id of the pack of the same name and kind it replaces. */
  private placeFor(info: PackInfo, source: PackSource): { id: string; replaces: PackRow | null } | { error: string } {
    const packs = this.packRows();
    let id = info.id;
    for (let n = 2; ; n += 1) {
      const there = packs.find((row) => row.id === id);
      if (!there) break;
      if (there.source === source) return { id, replaces: there };
      id = `${info.id}-${n}`;
    }
    if (packs.filter((row) => row.id !== OWN_PACK).length >= MAX_PACKS) return { error: `最多 ${MAX_PACKS} 个包，先删一个` };
    return { id, replaces: null };
  }

  /** Add a pack, or replace the one with the same id and kind (its on/off stays). */
  addPack(info: PackInfo, source: PackSource, stickers: (NewSticker | RemoteSticker)[]): { id: string } | { error: string } {
    const place = this.placeFor(info, source);
    if ("error" in place) return place;
    const { id, replaces } = place;
    const now = Date.now();
    this.sql`DELETE FROM res_stickers WHERE pack = ${id}`;
    this.sql`INSERT OR REPLACE INTO res_sticker_packs (id, name, info, source, enabled, at)
      VALUES (${id}, ${info.name}, ${JSON.stringify({ ...info, id })}, ${source}, ${replaces ? replaces.enabled : 1}, ${replaces?.at ?? now})`;
    stickers.forEach((sticker, seq) => {
      if ("fileId" in sticker) {
        this.sql`INSERT INTO res_stickers (key, pack, name, emoji, when_text, seq, web, web_type, web_remote, tg, tg_type, tg_file, tg_kind, at)
          VALUES (${newKey()}, ${id}, ${sticker.name}, ${sticker.emoji}, ${sticker.when}, ${seq}, NULL, ${sticker.webType}, ${sticker.webRemote},
            NULL, NULL, ${sticker.fileId}, ${"sticker"}, ${now})`;
      } else {
        this.sql`INSERT INTO res_stickers (key, pack, name, emoji, when_text, seq, web, web_type, web_remote, tg, tg_type, tg_file, tg_kind, at)
          VALUES (${newKey()}, ${id}, ${sticker.name}, ${sticker.emoji}, ${sticker.when}, ${seq}, ${buffer(sticker.web.bytes)}, ${sticker.web.type},
            NULL, ${sticker.telegram ? buffer(sticker.telegram.bytes) : null}, ${sticker.telegram?.type ?? null}, NULL, NULL, ${now})`;
      }
    });
    return { id };
  }

  /**
   * One of the resident's own drawings, into its own pack; drawing one again under the same name replaces it
   * (with a new key, so the new picture is not mistaken for the cached old one).
   */
  saveOwn(sticker: NewSticker): { handle: string } | { error: string } {
    if (!this.packRows().some((row) => row.id === OWN_PACK)) {
      this.sql`INSERT INTO res_sticker_packs (id, name, info, source, enabled, at)
        VALUES (${OWN_PACK}, ${own.name}, ${JSON.stringify(own)}, ${"own"}, 1, ${Date.now()})`;
    }
    const rows = this.rows(OWN_PACK);
    const old = rows.find((row) => row.name === sticker.name);
    if (!old && rows.length >= MAX_OWN) return { error: `Your own pack is full (${MAX_OWN}). They can delete some on the settings page.` };
    const [last] = this.sql<{ seq: number | null }>`SELECT MAX(seq) AS seq FROM res_stickers WHERE pack = ${OWN_PACK}`;
    this.sql`DELETE FROM res_stickers WHERE pack = ${OWN_PACK} AND name = ${sticker.name}`;
    this.sql`INSERT INTO res_stickers (key, pack, name, emoji, when_text, seq, web, web_type, web_remote, tg, tg_type, tg_file, tg_kind, at)
      VALUES (${newKey()}, ${OWN_PACK}, ${sticker.name}, ${sticker.emoji}, ${sticker.when}, ${(last?.seq ?? -1) + 1},
        ${buffer(sticker.web.bytes)}, ${sticker.web.type}, NULL, ${sticker.telegram ? buffer(sticker.telegram.bytes) : null},
        ${sticker.telegram?.type ?? null}, NULL, NULL, ${Date.now()})`;
    return { handle: `${OWN_PACK}/${sticker.name}` };
  }

  setEnabled(id: string, enabled: boolean): void {
    this.sql`UPDATE res_sticker_packs SET enabled = ${enabled ? 1 : 0} WHERE id = ${id}`;
  }

  removePack(id: string): void {
    this.sql`DELETE FROM res_stickers WHERE pack = ${id}`;
    this.sql`DELETE FROM res_sticker_packs WHERE id = ${id}`;
  }

  removeSticker(key: string): void {
    this.sql`DELETE FROM res_stickers WHERE key = ${key}`;
  }

  /** What a sticker is for (and its emoji), as written on the settings page. */
  edit(key: string, when: string, emoji: string | null): boolean {
    const [row] = this.sql<{ key: string }>`SELECT key FROM res_stickers WHERE key = ${key}`;
    if (!row) return false;
    if (emoji === null) this.sql`UPDATE res_stickers SET when_text = ${when} WHERE key = ${key}`;
    else this.sql`UPDATE res_stickers SET when_text = ${when}, emoji = ${emoji} WHERE key = ${key}`;
    return true;
  }

  /** The picture the web page shows, or the Telegram file to fetch it from first. */
  webFile(key: string): StickerFile | { remote: string } | null {
    const [row] = this.sql<{ web: ArrayBuffer | null; web_type: string; web_remote: string | null }>`SELECT web, web_type, web_remote
      FROM res_stickers WHERE key = ${key}`;
    if (!row) return null;
    if (row.web) return { bytes: new Uint8Array(row.web), type: row.web_type };
    return row.web_remote ? { remote: row.web_remote } : null;
  }

  saveWeb(key: string, file: StickerFile): void {
    this.sql`UPDATE res_stickers SET web = ${buffer(file.bytes)}, web_type = ${file.type} WHERE key = ${key}`;
  }

  /** How a sticker goes to Telegram: by the file id it is kept under there, else the file to upload. */
  telegramMedia(key: string): { kind: MediaKind; fileId?: string; file?: StickerFile; emoji: string } | null {
    const [row] = this.sql<{ emoji: string; web: ArrayBuffer | null; web_type: string; tg: ArrayBuffer | null; tg_type: string | null;
      tg_file: string | null; tg_kind: string | null }>`SELECT emoji, web, web_type, tg, tg_type, tg_file, tg_kind FROM res_stickers WHERE key = ${key}`;
    if (!row) return null;
    if (row.tg_file && row.tg_kind) return { kind: row.tg_kind as MediaKind, fileId: row.tg_file, emoji: row.emoji };
    const file = row.tg && row.tg_type ? { bytes: new Uint8Array(row.tg), type: row.tg_type } : row.web ? { bytes: new Uint8Array(row.web), type: row.web_type } : null;
    return file ? { kind: mediaKindOf(file.type), file, emoji: row.emoji } : null;
  }

  saveTelegramFile(key: string, fileId: string | null, kind: MediaKind | null): void {
    this.sql`UPDATE res_stickers SET tg_file = ${fileId}, tg_kind = ${kind} WHERE key = ${key}`;
  }

  /** Whether a sticker can only be sent by a file id (one from a Telegram pack, which has no file of its own here). */
  remoteOnly(key: string): boolean {
    const [row] = this.sql<{ local: number }>`SELECT (tg IS NOT NULL OR web IS NOT NULL) AS local FROM res_stickers WHERE key = ${key}`;
    return !row?.local;
  }

  /** The packs as the settings page shows them. */
  view(): PackView[] {
    return this.packRows().map((pack) => {
      const rows = this.rows(pack.id);
      const info = JSON.parse(pack.info) as PackInfo;
      return {
        ...info,
        id: pack.id,
        name: pack.name,
        source: pack.source,
        enabled: Boolean(pack.enabled),
        tokens: tokensOf(rows.map((row) => catalogLine(pack.id, { name: row.name, emoji: row.emoji, when: row.when_text }))),
        stickers: rows.map((row) => ({ key: row.key, name: row.name, emoji: row.emoji, when: row.when_text, video: row.web_type === "video/webm" }))
      };
    });
  }
}
