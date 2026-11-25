import { NOTE_PREFIX } from "./prompts";
import type { Sql } from "./sticker-store";

export const PROACTIVE_CALL_TOOL = "call_web";
export const PROACTIVE_CALL_NOTE_PREFIX = `${NOTE_PREFIX}: web call`;
export const PROACTIVE_CALL_DEFAULT_RING_SECONDS = 45;
export const PROACTIVE_CALL_DEFAULT_ONLINE_SECONDS = 20;
const OPENING_MAX_CHARS = 1200;
const FALLBACK_MAX_CHARS = 1200;
const TOPIC_MAX_CHARS = 60;
const KEEP_HISTORY = 30;

export const PROACTIVE_CALL_TOOL_DESCRIPTION =
  "Place a live voice call on the web page instead of sending a text check-in. Use this only during a scheduled " +
  "check-in, heartbeat, or alarm when you have something concrete to talk through live. Provide what you will say " +
  "first once they pick up (opening) and a short fallback message (fallback) to leave via the normal proactive " +
  "message channel if they decline, miss it, or the web page is not open.";

export type ProactiveCallStatus = "ringing" | "answered" | "declined" | "missed" | "cancelled";
export type ProactiveCallReason = "" | "offline" | "timeout" | "declined" | "answered" | "user_replied" | "config_off";

export type ProactiveCallContent = {
  topic: string;
  opening: string;
  fallback: string;
};

export type ProactiveCall = ProactiveCallContent & {
  id: string;
  status: ProactiveCallStatus;
  reason: ProactiveCallReason;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
  clientId: string;
  scheduleId: string;
  fallbackSentAt: number | null;
  messageId: string;
};

export type IncomingCallView = {
  id: string;
  residentId: string;
  topic: string;
  createdAt: number;
  expiresAt: number;
};

export type ProactiveCallStaleReason = "not_found" | "already_answered" | "declined" | "expired" | "wrong_resident";

type Row = {
  id: string;
  status: string;
  reason: string;
  topic: string;
  opening: string;
  fallback: string;
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
  client_id: string;
  schedule_id: string;
  fallback_sent_at: number | null;
  message_id: string;
};

const rowOf = (row: Row): ProactiveCall => ({
  id: row.id,
  status: row.status as ProactiveCallStatus,
  reason: row.reason as ProactiveCallReason,
  topic: row.topic,
  opening: row.opening,
  fallback: row.fallback,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  resolvedAt: row.resolved_at,
  clientId: row.client_id,
  scheduleId: row.schedule_id,
  fallbackSentAt: row.fallback_sent_at,
  messageId: row.message_id
});

export function isProactiveCallNote(text: string): boolean {
  return text.startsWith(PROACTIVE_CALL_NOTE_PREFIX);
}

export function proactiveCallAnsweredNote(now: string): string {
  return `${PROACTIVE_CALL_NOTE_PREFIX} answered; it is now ${now}.) They picked up your web call. You opened the call with what follows.`;
}

export function proactiveCallFallbackNote(reason: ProactiveCallReason, now: string): string {
  const detail =
    reason === "declined"
      ? "declined"
      : reason === "offline"
        ? "could not reach the web page"
        : "went unanswered and timed out";
  return `${PROACTIVE_CALL_NOTE_PREFIX} ${detail}; it is now ${now}.) You left this short message instead.`;
}

export function proactiveCallPromptHint(): string {
  return (
    ` If you have something concrete you want to talk through live, you may call ${PROACTIVE_CALL_TOOL} instead of ` +
    "sending a text message (provide what you will say first when they answer, and a short fallback line in case they cannot pick up)."
  );
}

export function proactiveCallRingMs(raw: string | undefined): number {
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  return PROACTIVE_CALL_DEFAULT_RING_SECONDS * 1000;
}

export function proactiveCallOnlineMs(raw: string | undefined): number {
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  return PROACTIVE_CALL_DEFAULT_ONLINE_SECONDS * 1000;
}

export function normalizeCallContent(input: { opening?: unknown; fallback?: unknown; topic?: unknown }): ProactiveCallContent | { error: string } {
  const opening = typeof input.opening === "string" ? input.opening.trim().slice(0, OPENING_MAX_CHARS) : "";
  if (!opening) return { error: "opening is required: say what you want to bring up when they answer." };
  const fallbackRaw = typeof input.fallback === "string" ? input.fallback.trim().slice(0, FALLBACK_MAX_CHARS) : "";
  const fallback = fallbackRaw || opening;
  const topic = typeof input.topic === "string" ? input.topic.replace(/\s+/g, " ").trim().slice(0, TOPIC_MAX_CHARS) : "";
  return { opening, fallback, topic };
}

export function placedProactiveCall(parts: readonly { type: string; toolName?: string; input?: unknown; output?: unknown }[]): ProactiveCallContent | null {
  const placed = parts.find((part) => {
    const isCall = part.type === `tool-${PROACTIVE_CALL_TOOL}` || (part.type === "dynamic-tool" && part.toolName === PROACTIVE_CALL_TOOL);
    return isCall && typeof part.output === "string" && part.output.startsWith("Placed:");
  });
  if (!placed?.input || typeof placed.input !== "object") return null;
  const content = normalizeCallContent(placed.input);
  return "error" in content ? null : content;
}

export function staleErrorOf(reason: ProactiveCallStaleReason): string {
  switch (reason) {
    case "already_answered":
      return "这通来电已经在别处接听了";
    case "declined":
      return "这通来电已经拒接了";
    case "wrong_resident":
      return "这通来电不属于当前住户";
    case "expired":
    case "not_found":
      return "这通来电已经结束了";
  }
}

export function incomingCallView(call: ProactiveCall | null, residentId: string): IncomingCallView | null {
  if (!call || call.status !== "ringing") return null;
  return {
    id: call.id,
    residentId,
    topic: call.topic,
    createdAt: call.createdAt,
    expiresAt: call.expiresAt
  };
}

export class ProactiveCallStore {
  constructor(private readonly sql: Sql) {
    sql`CREATE TABLE IF NOT EXISTS res_proactive_calls (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      topic TEXT NOT NULL,
      opening TEXT NOT NULL,
      fallback TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      resolved_at INTEGER,
      client_id TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      fallback_sent_at INTEGER,
      message_id TEXT NOT NULL
    )`;
  }

  get(id: string): ProactiveCall | null {
    const [row] = this.sql<Row>`SELECT * FROM res_proactive_calls WHERE id = ${id}`;
    return row ? rowOf(row) : null;
  }

  active(now: number): ProactiveCall | null {
    const [row] = this.sql<Row>`SELECT * FROM res_proactive_calls WHERE status = ${"ringing"} AND expires_at > ${now} ORDER BY created_at DESC LIMIT 1`;
    return row ? rowOf(row) : null;
  }

  expiredRinging(now: number): ProactiveCall[] {
    return this.sql<Row>`SELECT * FROM res_proactive_calls WHERE status = ${"ringing"} AND expires_at <= ${now} ORDER BY created_at`.map(rowOf);
  }

  allRinging(): ProactiveCall[] {
    return this.sql<Row>`SELECT * FROM res_proactive_calls WHERE status = ${"ringing"} ORDER BY created_at`.map(rowOf);
  }

  pendingFallbacks(): ProactiveCall[] {
    return this.sql<Row>`SELECT * FROM res_proactive_calls WHERE fallback_sent_at IS NULL AND status IN (${"declined"}, ${"missed"}) ORDER BY created_at`.map(rowOf);
  }

  start(input: ProactiveCallContent & { id: string; now: number; expiresAt: number | null }): ProactiveCall | null {
    const { id, now, expiresAt } = input;
    if (this.get(id) || this.active(now)) return null;
    const ringing = expiresAt !== null;
    this.sql`INSERT INTO res_proactive_calls (id, status, reason, topic, opening, fallback, created_at, expires_at, resolved_at, client_id, schedule_id, fallback_sent_at, message_id)
      VALUES (${id}, ${ringing ? "ringing" : "missed"}, ${ringing ? "" : "offline"}, ${input.topic}, ${input.opening}, ${input.fallback}, ${now}, ${expiresAt ?? now}, ${ringing ? null : now}, ${""}, ${""}, ${null}, ${""})`;
    this.prune();
    return this.get(id);
  }

  setScheduleId(id: string, scheduleId: string): void {
    this.sql`UPDATE res_proactive_calls SET schedule_id = ${scheduleId} WHERE id = ${id}`;
  }

  setMessageId(id: string, messageId: string): void {
    this.sql`UPDATE res_proactive_calls SET message_id = ${messageId} WHERE id = ${id}`;
  }

  answer(id: string, now: number, clientId: string): { ok: true; call: ProactiveCall } | { ok: false; reason: ProactiveCallStaleReason; expiredCall?: ProactiveCall } {
    const current = this.get(id);
    if (!current) return { ok: false, reason: "not_found" };
    if (current.status === "ringing" && now >= current.expiresAt) {
      const expired = this.expire(id, now);
      return { ok: false, reason: "expired", ...(expired ? { expiredCall: expired } : {}) };
    }
    if (current.status !== "ringing") {
      return { ok: false, reason: current.status === "answered" ? "already_answered" : current.status === "declined" ? "declined" : "expired" };
    }
    const client = clientId.trim().slice(0, 64);
    this.sql`UPDATE res_proactive_calls SET status = ${"answered"}, reason = ${"answered"}, resolved_at = ${now}, client_id = ${client}
      WHERE id = ${id} AND status = ${"ringing"} AND expires_at > ${now}`;
    const updated = this.get(id);
    if (!updated || updated.status !== "answered") return { ok: false, reason: "already_answered" };
    return { ok: true, call: updated };
  }

  decline(id: string, now: number, clientId: string): { ok: true; call: ProactiveCall } | { ok: false; reason: ProactiveCallStaleReason; expiredCall?: ProactiveCall } {
    const current = this.get(id);
    if (!current) return { ok: false, reason: "not_found" };
    if (current.status === "ringing" && now >= current.expiresAt) {
      const expired = this.expire(id, now);
      return { ok: false, reason: "expired", ...(expired ? { expiredCall: expired } : {}) };
    }
    if (current.status !== "ringing") {
      return { ok: false, reason: current.status === "answered" ? "already_answered" : current.status === "declined" ? "declined" : "expired" };
    }
    const client = clientId.trim().slice(0, 64);
    this.sql`UPDATE res_proactive_calls SET status = ${"declined"}, reason = ${"declined"}, resolved_at = ${now}, client_id = ${client}
      WHERE id = ${id} AND status = ${"ringing"} AND expires_at > ${now}`;
    const updated = this.get(id);
    if (!updated || updated.status !== "declined") return { ok: false, reason: "expired" };
    return { ok: true, call: updated };
  }

  expire(id: string, now: number): ProactiveCall | null {
    const current = this.get(id);
    if (!current || current.status !== "ringing" || now < current.expiresAt) return null;
    this.sql`UPDATE res_proactive_calls SET status = ${"missed"}, reason = ${"timeout"}, resolved_at = ${now}
      WHERE id = ${id} AND status = ${"ringing"}`;
    const updated = this.get(id);
    return updated && updated.status === "missed" ? updated : null;
  }

  cancelRinging(now: number, reason: "user_replied" | "config_off"): ProactiveCall[] {
    const active = this.allRinging();
    if (!active.length) return [];
    this.sql`UPDATE res_proactive_calls SET status = ${"cancelled"}, reason = ${reason}, resolved_at = ${now}
      WHERE status = ${"ringing"}`;
    return active;
  }

  claimFallbackDelivery(id: string, now: number): ProactiveCall | null {
    const current = this.get(id);
    if (!current || current.fallbackSentAt !== null || (current.status !== "declined" && current.status !== "missed")) return null;
    this.sql`UPDATE res_proactive_calls SET fallback_sent_at = ${now}
      WHERE id = ${id} AND fallback_sent_at IS NULL AND status IN (${"declined"}, ${"missed"})`;
    const updated = this.get(id);
    return updated && updated.fallbackSentAt === now ? updated : null;
  }

  private prune(): void {
    this.sql`DELETE FROM res_proactive_calls WHERE status != ${"ringing"}
      AND (status NOT IN (${"declined"}, ${"missed"}) OR fallback_sent_at IS NOT NULL) AND id NOT IN (
      SELECT id FROM res_proactive_calls ORDER BY created_at DESC LIMIT ${KEEP_HISTORY}
    )`;
  }
}
