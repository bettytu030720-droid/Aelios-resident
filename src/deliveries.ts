import type { Sql } from "./sticker-store";

export type Delivery = {
  key: string;
  kind: "checkin" | "letter";
  reply: string;
  telegramDone: boolean;
  memoryDone: boolean;
  progress: number;
};

type Row = { key: string; kind: "checkin" | "letter"; reply: string; telegram_done: number; memory_done: number; progress: number };

const deliveryOf = (row: Row): Delivery => ({
  key: row.key,
  kind: row.kind,
  reply: row.reply,
  telegramDone: Boolean(row.telegram_done),
  memoryDone: Boolean(row.memory_done),
  progress: row.progress
});

export class DeliveryStore {
  constructor(private readonly sql: Sql) {
    sql`CREATE TABLE IF NOT EXISTS res_deliveries (key TEXT PRIMARY KEY, kind TEXT NOT NULL, reply TEXT NOT NULL,
      telegram_done INTEGER NOT NULL, memory_done INTEGER NOT NULL, progress INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`;
    try {
      sql`ALTER TABLE res_deliveries ADD COLUMN progress INTEGER NOT NULL DEFAULT 0`;
    } catch {
      // The column already exists.
    }
  }

  add(key: string, kind: Delivery["kind"], reply: string, memory: boolean, now = Date.now()): void {
    this.sql`INSERT OR IGNORE INTO res_deliveries (key, kind, reply, telegram_done, memory_done, progress, created_at) VALUES
      (${key}, ${kind}, ${reply}, ${kind === "letter" ? 1 : 0}, ${memory ? 0 : 1}, 0, ${now})`;
  }

  get(key: string): Delivery | null {
    const [row] = this.sql<Row>`SELECT * FROM res_deliveries WHERE key = ${key}`;
    return row ? deliveryOf(row) : null;
  }

  pending(): Delivery[] {
    return this.sql<Row>`SELECT * FROM res_deliveries ORDER BY created_at LIMIT 100`.map(deliveryOf);
  }

  progress(key: string, progress: number): void {
    this.sql`UPDATE res_deliveries SET progress = ${progress} WHERE key = ${key}`;
  }

  telegramDone(key: string): void {
    this.sql`UPDATE res_deliveries SET telegram_done = 1 WHERE key = ${key}`;
  }

  memoryDone(key: string): void {
    this.sql`UPDATE res_deliveries SET memory_done = 1 WHERE key = ${key}`;
  }

  remove(key: string): void {
    this.sql`DELETE FROM res_deliveries WHERE key = ${key}`;
  }
}
