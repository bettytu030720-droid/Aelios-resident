import type {
  HistoryReadOptions,
  RecentHistoryResult,
  Session,
  SessionMessage,
  SessionRowStat,
  StoredCompaction,
} from "agents/sessions";

/** Only public, instance-level Sessions APIs; no SDK storage or private fields. */
type HistorySession = Pick<Session,
  "getHistory" | "getRecentHistory" | "getHistoryRowStats" | "getCompactions"
>;

export interface EffectiveHistoryOptions {
  /** A finite byte ceiling, evaluated on every admission/read (never Infinity). */
  budget(): number;
  /**
   * Content-free SQL verification supplied by the owner. Verify that the SDK's
   * path reaches an existing root within its 10,000-depth limit, INCLUDING any
   * hidden legacy overlay rows. Missing parents and cycles must return false.
   * null means no visible stat rows: verify that the session really is empty.
   * Do not implement this with getLatestLeaf(), which hydrates a message.
   */
  pathComplete(leafId: string | null): boolean;
}

export interface EffectiveHistoryPlan {
  readonly leafId: string | null;
  readonly complete: boolean;
  /** SDK semantics: RAW full-path bytes, including covered rows. */
  readonly rawBytes: number;
  readonly uncoveredBytes: number;
  readonly summaryBytes: number;
  readonly effectiveBytes: number;
  readonly messageIds: readonly string[];
}

export class EffectiveHistoryError extends Error {
  constructor(readonly code: "budget" | "incomplete" | "changed" | "metadata", message: string) {
    super(message);
    this.name = "EffectiveHistoryError";
  }
}

interface Entry { id: string; summary?: string }
interface Snapshot {
  rows: SessionRowStat[];
  records: StoredCompaction[];
  entries: Entry[];
  plan: EffectiveHistoryPlan;
  fingerprint: string;
}

const encoder = new TextEncoder();
const installed = new WeakSet<HistorySession>();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;

function finiteBytes(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EffectiveHistoryError("budget", `${label} must be a finite non-negative safe integer`);
  }
  return value;
}

function sum(a: number, b: number): number {
  const value = a + b;
  if (!Number.isSafeInteger(value)) throw new EffectiveHistoryError("metadata", "History size overflow");
  return value;
}

/**
 * Exact agents 0.29.0 / 0.30.1 planOverlays selection: root → leaf, newest
 * APPLICABLE record at the SAME start wins; then skip its entire span.
 * In particular, a globally newer overlapping/off-branch record need not win.
 */
function effective(rows: SessionRowStat[], records: StoredCompaction[]) {
  const indexById = new Map(rows.map((row, index) => [row.id, index]));
  const byStart = new Map<string, StoredCompaction[]>();
  for (const record of records) {
    const group = byStart.get(record.fromMessageId) ?? [];
    group.push(record);
    byStart.set(record.fromMessageId, group);
  }
  const entries: Entry[] = [];
  let uncoveredBytes = 0;
  let summaryBytes = 0;
  let i = 0;
  while (i < rows.length) {
    const candidates = byStart.get(rows[i].id) ?? [];
    let record: StoredCompaction | undefined;
    for (let candidate = candidates.length - 1; candidate >= 0; candidate--) {
      if ((indexById.get(candidates[candidate].toMessageId) ?? -1) >= i) {
        record = candidates[candidate];
        break;
      }
    }
    if (record) {
      const id = `compaction_${record.id}`;
      // SDK overlayMessage uses a fresh Date(). Its normal ISO timestamp has
      // the same serialized UTF-8 length as this fixed date; charge the WHOLE
      // synthetic message, including escaping, id, role, parts and timestamp.
      summaryBytes = sum(summaryBytes, bytes({
        id, role: "assistant", parts: [{ type: "text", text: record.summary }],
        createdAt: new Date(0),
      }));
      entries.push({ id, summary: record.summary });
      i = indexById.get(record.toMessageId)! + 1;
    } else {
      uncoveredBytes = sum(uncoveredBytes, rows[i].bytes);
      entries.push({ id: rows[i].id });
      i++;
    }
  }
  return { entries, uncoveredBytes, summaryBytes, effectiveBytes: sum(uncoveredBytes, summaryBytes) };
}

/**
 * Install once on Think's actual session handle, before its first history read.
 *
 * plan()/fits() and both patched reads share the exact same planner. fits() is
 * metadata-only and is NOT a lease: repeat it with the letter prompt reserve at
 * every letter admission boundary. getHistory() independently checks again.
 *
 * Coherence is optimistic, not a transaction: one metadata snapshot plans each
 * read, and the hydrated messages must match it (ids, summaries, actual bytes).
 * The owner should serialize writes with reads.
 * Public stats cannot detect an equal-size, equal-token raw content replacement
 * (nor ABA changes); this helper does not claim to provide snapshot isolation.
 * Streaming history(), getMessage(), and SDK-private reads are not patched.
 */
export function installEffectiveHistory(session: HistorySession, options: EffectiveHistoryOptions) {
  if (installed.has(session)) throw new Error("Effective history is already installed on this session");
  // Save bound originals BEFORE replacing either method. Never call a patched
  // method from another patched method, or change SDK-wide/prototype behavior.
  const originalHistory = session.getHistory.bind(session);
  const originalRecent = session.getRecentHistory.bind(session);
  const rowStats = session.getHistoryRowStats.bind(session);
  const compactions = session.getCompactions.bind(session);
  const historyDescriptor = Object.getOwnPropertyDescriptor(session, "getHistory");
  const recentDescriptor = Object.getOwnPropertyDescriptor(session, "getRecentHistory");
  const ceiling = () => finiteBytes(options.budget(), "History budget");
  ceiling();

  async function snapshot(leafId?: string | null): Promise<Snapshot> {
    const rows = await rowStats(leafId);
    const seen = new Set<string>();
    let rawBytes = 0;
    for (const row of rows) {
      if (seen.has(row.id) || !Number.isSafeInteger(row.bytes) || row.bytes < 0) {
        throw new EffectiveHistoryError("metadata", "Invalid or cyclic history row metadata");
      }
      seen.add(row.id);
      rawBytes = sum(rawBytes, row.bytes);
    }
    const records = await compactions();
    const pinned = rows.at(-1)?.id ?? null;
    const complete = options.pathComplete(pinned);
    if (typeof complete !== "boolean") throw new EffectiveHistoryError("metadata", "pathComplete must return a boolean");
    const planned = effective(rows, records);
    const plan: EffectiveHistoryPlan = Object.freeze({
      leafId: pinned, complete, rawBytes,
      uncoveredBytes: planned.uncoveredBytes, summaryBytes: planned.summaryBytes,
      effectiveBytes: planned.effectiveBytes,
      messageIds: Object.freeze(planned.entries.map((entry) => entry.id)),
    });
    return {
      rows, records, entries: planned.entries, plan,
      // Include even suppressed/off-branch records, not just effective bytes or
      // ids: moving a range or replacing a same-length summary must invalidate.
      fingerprint: JSON.stringify([rows, records, complete]),
    };
  }

  function same(before: Snapshot, after: Snapshot) {
    if (before.fingerprint !== after.fingerprint) {
      throw new EffectiveHistoryError("changed", "History metadata changed during the read; retry admission");
    }
  }

  // One metadata snapshot per read. Sessions reads Durable Object SQLite
  // synchronously, so no other request can write between the snapshot and the
  // body read; validateMessages() still checks what actually came back.

  function validateMessages(messages: SessionMessage[], entries: Entry[], limit: number) {
    if (messages.length !== entries.length || entries.some((entry, i) => {
      const message = messages[i];
      return message.id !== entry.id || (entry.summary !== undefined
        && (message.role !== "assistant" || message.parts.length !== 1
          || message.parts[0].type !== "text" || message.parts[0].text !== entry.summary));
    })) throw new EffectiveHistoryError("changed", "Materialized history does not match its effective plan");
    let actual = 0;
    for (const message of messages) actual = sum(actual, bytes(message));
    if (actual > limit) throw new EffectiveHistoryError("budget", "Materialized history exceeds its byte budget");
  }

  async function full(before: Snapshot, readOptions: HistoryReadOptions, limit: number) {
    if (!before.plan.complete) throw new EffectiveHistoryError("incomplete", "History path is not verified through its root");
    if (before.plan.effectiveBytes > limit) throw new EffectiveHistoryError("budget", "Effective history exceeds its byte budget");
    readOptions.signal?.throwIfAborted();
    // Pin the read to the snapshot's last stat id; an empty session reads nothing.
    const messages = before.plan.leafId === null ? []
      : await originalHistory({ ...readOptions, leafId: before.plan.leafId });
    validateMessages(messages, readOptions.newestFirst ? [...before.entries].reverse() : before.entries, limit);
    return messages;
  }

  // ThinkSession also takes a bare leaf id, as the pre-Sessions API did.
  const getHistory = async (leafIdOrOptions: string | HistoryReadOptions = {}) => {
    const readOptions = typeof leafIdOrOptions === "string" ? { leafId: leafIdOrOptions } : leafIdOrOptions;
    const limit = ceiling();
    return full(await snapshot(readOptions.leafId), readOptions, limit);
  };

  const getRecentHistory: HistorySession["getRecentHistory"] = async (requested, readOptions = {}) => {
    const limit = Math.min(ceiling(), finiteBytes(requested, "Recent history budget"));
    const before = await snapshot(readOptions.leafId);
    if (before.plan.complete && before.plan.effectiveBytes <= limit) {
      return {
        messages: await full(before, readOptions, limit),
        truncated: false,
        totalContentBytes: before.plan.rawBytes, // NOT the effective byte count
      };
    }
    // Ordinary chat retains the SDK's raw-budgeted suffix when the FULL view
    // cannot fit. Reproduce only the window arithmetic to verify safety BEFORE
    // calling the bound stock reader; an oversized synthetic summary must not
    // bypass our finite ceiling.
    let start = Math.max(0, before.rows.length - 1);
    let used = before.rows[start]?.bytes ?? 0;
    while (start > 0 && sum(used, before.rows[start - 1].bytes) <= limit) {
      used += before.rows[--start].bytes;
    }
    // As in the SDK, the newest message comes back even when it alone is over
    // the budget: hydrating no history at all is worse.
    const newestOnly = start === before.rows.length - 1;
    const window = effective(before.rows.slice(start), before.records);
    if (!newestOnly && window.effectiveBytes > limit) {
      throw new EffectiveHistoryError("budget", "Even the stock recent window exceeds its byte budget");
    }
    const result: RecentHistoryResult = before.plan.leafId === null
      ? { messages: [], truncated: true, totalContentBytes: before.plan.rawBytes }
      : await originalRecent(limit, { ...readOptions, leafId: before.plan.leafId });
    validateMessages(result.messages, window.entries, newestOnly ? Number.MAX_SAFE_INTEGER : limit);
    if (result.totalContentBytes !== before.plan.rawBytes) {
      throw new EffectiveHistoryError("changed", "Stock recent history raw total changed");
    }
    return { ...result, truncated: true, totalContentBytes: before.plan.rawBytes };
  };

  session.getHistory = getHistory;
  session.getRecentHistory = getRecentHistory;
  installed.add(session);
  return {
    async plan(readOptions: Pick<HistoryReadOptions, "leafId"> = {}): Promise<EffectiveHistoryPlan> {
      ceiling();
      return (await snapshot(readOptions.leafId)).plan;
    },
    async fits(reserve = 0, readOptions: Pick<HistoryReadOptions, "leafId"> = {}): Promise<boolean> {
      const limit = ceiling();
      finiteBytes(reserve, "History reserve");
      const { plan } = await snapshot(readOptions.leafId);
      return plan.complete && reserve <= limit && plan.effectiveBytes <= limit - reserve;
    },
    /**
     * Metadata-only view for committing an ALREADY WRITTEN letter. Unlike a
     * model admission it need not fit the hydration budget: a new oversized
     * tail must not prevent folding the saved prefix. No body read is leased.
     */
    async recovery() {
      const before = await snapshot();
      if (!before.plan.complete) {
        throw new EffectiveHistoryError("incomplete", "History path is not verified through its root");
      }
      const indexById = new Map(before.rows.map((row, index) => [row.id, index]));
      return Object.freeze({
        messages: Object.freeze(before.entries.map(({ id }) => Object.freeze({ id }))),
        compactions: Object.freeze(before.records.map((record) => Object.freeze({ ...record }))),
        // The caller must await this immediately before its native addCompaction.
        async assertCurrent(): Promise<void> {
          same(before, await snapshot());
        },
        containsRange(from: string, to: string): boolean {
          const start = indexById.get(from);
          const end = indexById.get(to);
          return start !== undefined && end !== undefined && start <= end;
        },
      });
    },
    /** Restore the original own-property/prototype arrangement, not a global patch. */
    restore() {
      if (session.getHistory !== getHistory || session.getRecentHistory !== getRecentHistory) {
        throw new Error("Cannot restore effective history over another instance patch");
      }
      if (historyDescriptor) Object.defineProperty(session, "getHistory", historyDescriptor);
      else delete (session as Partial<HistorySession>).getHistory;
      if (recentDescriptor) Object.defineProperty(session, "getRecentHistory", recentDescriptor);
      else delete (session as Partial<HistorySession>).getRecentHistory;
      installed.delete(session);
    },
  };
}
