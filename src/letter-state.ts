// Durable letter delivery and write progress in the resident's own SQLite.
// No network, queue payloads, credentials, clocks, or asynchronous work here.
import type { Sql } from "./sticker-store";

export type DeliveryTarget = { url: string; namespace: string };

export type DeliveryRow = {
  id: string;
  at: number;
  text: string;
  url: string;
  namespace: string;
  attempts: number;
  status: "pending" | "sent" | "failed" | "blocked";
  nextAt: number | null;
  lastError: string | null;
  sentAt: number | null;
};

export type WriteState = {
  state: "writing" | "recovering" | "written" | "empty" | "failed";
  at: number;
  error?: string;
};

type Row = Omit<DeliveryRow, "nextAt" | "lastError" | "sentAt"> & {
  next_at: number | null;
  last_error: string | null;
  sent_at: number | null;
};
type Latest = Pick<DeliveryRow, "id" | "at" | "status" | "attempts" | "lastError" | "sentAt">;
type Summary = { pending: number; failed: number; blocked: number; latest: Latest | null };

const BACKOFF = [30_000, 120_000, 600_000, 1_800_000, 7_200_000];
const MAX_ATTEMPTS = 6;
const LEASE_MS = 60_000;
const EXHAUSTED = "投递次数已耗尽（最多 6 次），请手动重试。";

function deliveryOf(row: Row): DeliveryRow {
  const { next_at, last_error, sent_at, ...rest } = row;
  return { ...rest, nextAt: next_at, lastError: last_error, sentAt: sent_at };
}

/**
 * All methods are synchronous. The caller uses storage.transactionSync() to
 * commit enqueue() together with local letter storage. Deliver only a claimed
 * row; the lease permits at-least-once recovery, not exactly-once remote I/O.
 * Errors passed in must be safe for the UI: summary() includes lastError.
 */
export class LetterStateStore {
  constructor(private readonly sql: Sql) {
    sql`CREATE TABLE IF NOT EXISTS res_letter_deliveries (
      id TEXT PRIMARY KEY, at INTEGER NOT NULL, text TEXT NOT NULL,
      url TEXT NOT NULL, namespace TEXT NOT NULL,
      attempts INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 6),
      status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'blocked')),
      next_at INTEGER, last_error TEXT, sent_at INTEGER
    )`;
    sql`CREATE INDEX IF NOT EXISTS res_letter_deliveries_due ON res_letter_deliveries (status, next_at)`;
    sql`CREATE INDEX IF NOT EXISTS res_letter_deliveries_order ON res_letter_deliveries (at, id)`;
    sql`CREATE TABLE IF NOT EXISTS res_letter_write_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL CHECK (state IN ('writing', 'recovering', 'written', 'empty', 'failed')),
      at INTEGER NOT NULL, error TEXT
    )`;
  }

  enqueue(input: { id: string; at: number; text: string; target: DeliveryTarget }): void {
    const { id, at, text, target } = input;
    this.sql`INSERT OR IGNORE INTO res_letter_deliveries
      (id, at, text, url, namespace, attempts, status, next_at, last_error, sent_at)
      VALUES (${id}, ${at}, ${text}, ${target.url}, ${target.namespace}, 0, 'pending', ${at}, NULL, NULL)`;
  }

  get(id: string): DeliveryRow | null {
    const [row] = this.sql<Row>`SELECT * FROM res_letter_deliveries WHERE id = ${id}`;
    return row ? deliveryOf(row) : null;
  }

  due(now: number): DeliveryRow | null {
    const [row] = this.sql<Row>`SELECT * FROM res_letter_deliveries
      WHERE status = 'pending' AND next_at <= ${now} ORDER BY at, id LIMIT 1`;
    return row ? deliveryOf(row) : null;
  }

  /** Claim atomically; an expired sixth lease becomes failed without a seventh send. */
  claim(id: string, now: number): DeliveryRow | null {
    const [row] = this.sql<Row>`UPDATE res_letter_deliveries SET
      attempts = CASE WHEN attempts < ${MAX_ATTEMPTS} THEN attempts + 1 ELSE attempts END,
      status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
      next_at = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN NULL ELSE ${now + LEASE_MS} END,
      last_error = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN ${EXHAUSTED} ELSE last_error END
      WHERE id = ${id} AND status = 'pending' AND next_at <= ${now}
      RETURNING *`;
    return row?.status === "pending" ? deliveryOf(row) : null;
  }

  accepted(id: string, now: number): void {
    this.sql`UPDATE res_letter_deliveries SET status = 'sent', next_at = NULL, last_error = NULL, sent_at = ${now}
      WHERE id = ${id} AND status != 'sent'`;
  }

  /** Failure belongs to the already-claimed attempt; never discard the letter. */
  attemptFailed(id: string, error: string, now: number): void {
    const row = this.get(id);
    if (!row || row.status !== "pending" || row.attempts === 0) return;
    const exhausted = row.attempts >= MAX_ATTEMPTS;
    const nextAt = exhausted ? null : now + BACKOFF[row.attempts - 1];
    this.sql`UPDATE res_letter_deliveries SET status = ${exhausted ? "failed" : "pending"},
      next_at = ${nextAt}, last_error = ${error}
      WHERE id = ${id} AND status = 'pending' AND attempts = ${row.attempts}`;
  }

  block(id: string, error: string): void {
    this.sql`UPDATE res_letter_deliveries SET status = 'blocked', next_at = NULL, last_error = ${error}
      WHERE id = ${id} AND status != 'sent'`;
  }

  retry(now: number): void {
    this.sql`UPDATE res_letter_deliveries SET status = 'pending', attempts = 0,
      next_at = ${now}, last_error = NULL, sent_at = NULL WHERE status IN ('failed', 'blocked')`;
  }

  /** Restoring the same target does not reset the automatic attempt budget. */
  resumeBlocked(target: DeliveryTarget, now: number): void {
    this.sql`UPDATE res_letter_deliveries SET status = 'pending', next_at = ${now}, last_error = NULL
      WHERE status = 'blocked' AND url = ${target.url} AND namespace = ${target.namespace}`;
  }

  nextAt(): number | null {
    const [row] = this.sql<{ at: number | null }>`SELECT MIN(next_at) AS at FROM res_letter_deliveries WHERE status = 'pending'`;
    return row?.at ?? null;
  }

  /** Only metadata is selected; no letter text, target URL, or namespace escapes. */
  summary(): Summary {
    const [counts] = this.sql<Omit<Summary, "latest">>`SELECT
      COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending,
      COUNT(CASE WHEN status = 'failed' THEN 1 END) AS failed,
      COUNT(CASE WHEN status = 'blocked' THEN 1 END) AS blocked FROM res_letter_deliveries`;
    const [latest] = this.sql<Latest>`SELECT id, at, status, attempts, last_error AS lastError, sent_at AS sentAt
      FROM res_letter_deliveries ORDER BY at DESC, id DESC LIMIT 1`;
    return { ...counts, latest: latest ? { ...latest } : null };
  }

  write(state: WriteState): void {
    this.sql`INSERT INTO res_letter_write_state (id, state, at, error) VALUES (1, ${state.state}, ${state.at}, ${state.error ?? null})
      ON CONFLICT (id) DO UPDATE SET state = excluded.state, at = excluded.at, error = excluded.error`;
  }

  readWrite(): WriteState | null {
    const [row] = this.sql<{ state: WriteState["state"]; at: number; error: string | null }>`SELECT state, at, error
      FROM res_letter_write_state WHERE id = 1`;
    if (!row) return null;
    return row.error === null ? { state: row.state, at: row.at } : { state: row.state, at: row.at, error: row.error };
  }
}
