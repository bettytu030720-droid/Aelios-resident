// Quiet hours (QUIET_HOURS): the part of the night when the heartbeat does not ask whether to reach out. In the
// user's time zone, 00:00-08:00 unless set, "off" for none. Check-ins, alarms and letters are not affected: those
// run at a time someone chose.

import { localOf } from "./alarms";

export const DEFAULT_QUIET_HOURS = "00:00-08:00";

/** Minutes after midnight. When start is later than end, the hours run past midnight. */
export type QuietHours = { start: number; end: number };

const RANGE = /^(\d{1,2})(?::(\d{2}))?\s*(?:-|–|—|~|到)\s*(\d{1,2})(?::(\d{2}))?$/;

/** The hours a setting names: null for "off", an error for anything else that is not a range. */
export function parseQuietHours(raw: string): QuietHours | null | { error: string } {
  const text = raw.trim().toLowerCase();
  if (text === "off") return null;
  const match = RANGE.exec(text);
  if (!match) return { error: "写成 00:00-08:00 这样，或者 off" };
  const [, h1, m1 = "0", h2, m2 = "0"] = match;
  const start = Number(h1) * 60 + Number(m1);
  const end = Number(h2) * 60 + Number(m2);
  if (Number(h1) > 23 || Number(m1) > 59 || Number(m2) > 59 || end > 24 * 60) return { error: "不是一天里的时间" };
  if (start === end % (24 * 60)) return { error: "开始和结束不能是同一个时间" };
  return { start, end };
}

/** Why a value cannot be saved, or null when it can (config.ts). */
export function quietHoursProblem(value: string): string | null {
  const parsed = parseQuietHours(value);
  return parsed && "error" in parsed ? parsed.error : null;
}

/** The hours in effect: the saved or Worker value, the default when empty or unreadable, null when off. */
export function quietHoursOf(setting: string | undefined): QuietHours | null {
  const parsed = parseQuietHours(setting?.trim() || DEFAULT_QUIET_HOURS);
  if (parsed && "error" in parsed) {
    console.warn("quiet hours: unreadable setting, using the default", { setting });
    return parseQuietHours(DEFAULT_QUIET_HOURS) as QuietHours;
  }
  return parsed;
}

/** Whether `at` falls inside the hours, on the clock of the time zone. The end is not included. */
export function inQuietHours(hours: QuietHours | null, at: number, timeZone: string): boolean {
  if (!hours) return false;
  const local = localOf(at, timeZone);
  const now = local.hour * 60 + local.minute;
  return hours.start < hours.end ? now >= hours.start && now < hours.end : now >= hours.start || now < hours.end;
}

/** "0:00 到 8:00", for /status. */
export function quietHoursInWords(hours: QuietHours): string {
  const clock = (minutes: number) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
  return `${clock(hours.start)} 到 ${clock(hours.end)}`;
}
