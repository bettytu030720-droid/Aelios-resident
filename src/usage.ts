// The usage timeline (时间流 on the web page): one row for every call to a model, with its tokens, what the call
// was for and where it came from. Only numbers and tool names are kept, never a word of the chat. The page sums the
// rows for today, 7 and 30 days, and lists them newest first. Rows older than USAGE_KEEP_DAYS are deleted.
//
// The tokens are what the model's provider reported for the call. A provider or relay that does not report cache
// writes shows none; an OpenAI-style one reports cache reads only. What a call cost is worked out from Anthropic's
// list prices (prices.ts) when it is read, so a price added later also prices older rows.

import type { LanguageModelUsage } from "ai";
import { LONG_PROMPT, costAt, costOf, priceFor } from "./prices";
import { noteKind } from "./prompts";
import type { Sql } from "./sticker-store";

export const USAGE_KEEP_DAYS = 90;
const DAY_MS = 86_400_000;
const PRUNE_EVERY_MS = 3_600_000;
/** Rows the page gets at a time. */
export const USAGE_PAGE = 100;

/**
 * What a call was for: a turn of theirs, the handoff letter, a check-in, a heartbeat, an alarm, a cloud task's
 * report, another system note; or work outside the conversation: shrinking a web page, saving what a search found,
 * the trial call when a model is picked.
 */
export type UsageKind = "chat" | "letter" | "checkin" | "heartbeat" | "alarm" | "task" | "worker" | "note" | "compress" | "learn" | "trial";
/** Where the turn came from; "" for a turn the resident started itself and for work outside the conversation. */
export type UsageVia = "web" | "telegram" | "wecom" | "";
export type UsageLabel = { kind: UsageKind; via: UsageVia };

/** A turn's label, from the message it answers and how it started. */
export function usageLabel({
  asked,
  letter,
  task,
  messenger,
  proactive
}: {
  /** The last message in the turn's input. */
  asked: string;
  /** The turn writes the handoff letter. */
  letter: boolean;
  /** The message is a cloud task's report. */
  task: boolean;
  /** The messenger the turn came in on (Telegram, WeCom), if any. */
  messenger?: string;
  /** Started by a schedule or a submission rather than by a message. */
  proactive: boolean;
}): UsageLabel {
  const kind: UsageKind = letter ? "letter" : task ? "task" : (noteKind(asked) ?? "chat");
  const via: UsageVia = messenger ? (messenger === "wecom" ? "wecom" : "telegram") : kind === "chat" && !proactive ? "web" : "";
  return { kind, via };
}

/** What a step of a model call hands over (Think's step, or generateText's), as far as it is read here. */
export type StepLike = {
  stepNumber?: number;
  model?: { modelId?: string };
  usage?: LanguageModelUsage;
  response?: { modelId?: string };
  toolCalls?: ReadonlyArray<{ toolName?: string }>;
};

export type UsageEntry = UsageLabel & {
  at: number;
  model: string;
  /** 0 for the first call of a turn, then one more for each call after its tools ran. */
  step: number;
  /** Input not read from or written to the cache. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Of cacheWrite, what went to the one-hour cache. */
  cacheWrite1h: number;
  /** Including thinking. */
  output: number;
  reasoning: number;
  tools: string[];
};

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

/**
 * The row for a step; null when the provider reported no tokens. Anthropic says how much of a cache write went to
 * the one-hour cache; when a provider does not, the write is taken to be the TTL the resident asked for.
 */
export function entryOf(step: StepLike, label: UsageLabel, at: number, ttl: "5m" | "1h"): UsageEntry | null {
  const usage = step.usage;
  if (!usage) return null;
  const total = count(usage.inputTokens);
  const cacheRead = count(usage.inputTokenDetails?.cacheReadTokens);
  const cacheWrite = count(usage.inputTokenDetails?.cacheWriteTokens);
  const noCache = usage.inputTokenDetails?.noCacheTokens;
  const input = typeof noCache === "number" ? count(noCache) : Math.max(0, total - cacheRead - cacheWrite);
  const output = count(usage.outputTokens);
  if (!input && !cacheRead && !cacheWrite && !output) return null;
  const creation = (usage.raw as { cache_creation?: { ephemeral_1h_input_tokens?: unknown } } | undefined)?.cache_creation;
  const told = creation && typeof creation.ephemeral_1h_input_tokens === "number";
  const cacheWrite1h = Math.min(cacheWrite, told ? count(creation.ephemeral_1h_input_tokens) : ttl === "1h" ? cacheWrite : 0);
  const tools = [...new Set((step.toolCalls ?? []).map((call) => String(call?.toolName ?? "").slice(0, 60)).filter(Boolean))].slice(0, 12);
  return {
    ...label,
    at,
    model: String(step.model?.modelId || step.response?.modelId || "").slice(0, 200),
    step: count(step.stepNumber),
    input,
    cacheRead,
    cacheWrite,
    cacheWrite1h,
    output,
    reasoning: Math.min(output, count(usage.outputTokenDetails?.reasoningTokens)),
    tools
  };
}

/** One row as the page shows it, with what it cost at list price (null when the model has no price). */
export type UsageRow = UsageEntry & { id: number; cost: number | null };

/** A span's sums. cost leaves out the calls to models without a price; unpriced counts those calls. */
export type UsageTotals = {
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  cost: number;
  unpriced: number;
};

type Row = {
  id: number;
  at: number;
  model: string;
  kind: string;
  via: string;
  step: number;
  input: number;
  cache_read: number;
  cache_write: number;
  cache_write_1h: number;
  output: number;
  reasoning: number;
  tools: string;
};

type Sum = {
  model: string;
  is_long: number;
  calls: number;
  input: number;
  cache_read: number;
  cache_write: number;
  cache_write_1h: number;
  output: number;
  reasoning: number;
};

function rowOf(row: Row): UsageRow {
  const entry: UsageEntry = {
    at: row.at,
    model: row.model,
    kind: row.kind as UsageKind,
    via: row.via as UsageVia,
    step: row.step,
    input: row.input,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    cacheWrite1h: row.cache_write_1h,
    output: row.output,
    reasoning: row.reasoning,
    tools: row.tools ? row.tools.split(",") : []
  };
  return { id: row.id, ...entry, cost: costOf(entry.model, entry) };
}

export class UsageStore {
  #prunedAt = 0;

  constructor(private readonly sql: Sql) {
    sql`CREATE TABLE IF NOT EXISTS res_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, model TEXT NOT NULL,
      kind TEXT NOT NULL, via TEXT NOT NULL, step INTEGER NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL,
      cache_write INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER NOT NULL,
      tools TEXT NOT NULL)`;
    sql`CREATE INDEX IF NOT EXISTS res_usage_at ON res_usage (at)`;
  }

  add(entry: UsageEntry): void {
    const e = entry;
    this.sql`INSERT INTO res_usage (at, model, kind, via, step, input, cache_read, cache_write, cache_write_1h, output, reasoning, tools)
      VALUES (${e.at}, ${e.model}, ${e.kind}, ${e.via}, ${e.step}, ${e.input}, ${e.cacheRead}, ${e.cacheWrite}, ${e.cacheWrite1h},
      ${e.output}, ${e.reasoning}, ${e.tools.join(",")})`;
    if (e.at - this.#prunedAt >= PRUNE_EVERY_MS) {
      this.#prunedAt = e.at;
      this.sql`DELETE FROM res_usage WHERE at < ${e.at - USAGE_KEEP_DAYS * DAY_MS}`;
    }
  }

  /** Sums since a time. Priced per model, and for Haiku 5.5 per prompt length, as each call was billed. */
  totals(since: number): UsageTotals {
    const sums = this.sql<Sum>`SELECT model, (input + cache_read + cache_write > ${LONG_PROMPT}) AS is_long, COUNT(*) AS calls,
      SUM(input) AS input, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write, SUM(cache_write_1h) AS cache_write_1h,
      SUM(output) AS output, SUM(reasoning) AS reasoning
      FROM res_usage WHERE at >= ${since} GROUP BY model, is_long`;
    const totals: UsageTotals = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0, unpriced: 0 };
    for (const sum of sums) {
      totals.calls += sum.calls;
      totals.input += sum.input;
      totals.cacheRead += sum.cache_read;
      totals.cacheWrite += sum.cache_write;
      totals.output += sum.output;
      totals.reasoning += sum.reasoning;
      const price = priceFor(sum.model, sum.is_long ? LONG_PROMPT + 1 : 0);
      if (!price) {
        totals.unpriced += sum.calls;
        continue;
      }
      totals.cost += costAt(price, { input: sum.input, cacheRead: sum.cache_read, cacheWrite: sum.cache_write, cacheWrite1h: sum.cache_write_1h, output: sum.output });
    }
    return totals;
  }

  /** The newest rows, or the ones before a row id; more says whether older rows are left. */
  rows(before: number | null, limit = USAGE_PAGE): { rows: UsageRow[]; more: boolean } {
    const found =
      before === null
        ? this.sql<Row>`SELECT * FROM res_usage ORDER BY id DESC LIMIT ${limit + 1}`
        : this.sql<Row>`SELECT * FROM res_usage WHERE id < ${before} ORDER BY id DESC LIMIT ${limit + 1}`;
    return { rows: found.slice(0, limit).map(rowOf), more: found.length > limit };
  }
}

/** Midnight in the time zone on the day of `at`, give or take a daylight-saving change that day. */
export function midnightOf(at: number, local: { hour: number; minute: number }): number {
  return Math.floor(at / 60_000) * 60_000 - (local.hour * 60 + local.minute) * 60_000;
}

/** Where today, the last 7 days and the last 30 days begin, counting today as one of them. */
export function usageSpans(at: number, local: { hour: number; minute: number }): { today: number; week: number; month: number } {
  const today = midnightOf(at, local);
  return { today, week: today - 6 * DAY_MS, month: today - 29 * DAY_MS };
}
