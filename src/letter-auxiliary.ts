import type { Session, SessionMessage, SessionRowStat } from "agents/sessions";
import { EffectiveHistoryError } from "./effective-history";

// Raw stats deliberately bypass overlays and the guarded full-history reader.
// The owner supplies a persisted auxiliary prompt id and serializes mutations.
type AuxiliarySession = Pick<Session, "getHistoryRowStats" | "getMessage" | "deleteMessages">;
type MetadataSession = Pick<AuxiliarySession, "getHistoryRowStats">;

async function snapshot(session: MetadataSession) {
  const rows = await session.getHistoryRowStats();
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.id || seen.has(row.id) || typeof row.role !== "string"
      || !Number.isSafeInteger(row.bytes) || row.bytes < 0) {
      throw new EffectiveHistoryError("metadata", "Invalid auxiliary history metadata");
    }
    seen.add(row.id);
  }
  return { rows, fingerprint: JSON.stringify(rows) };
}

type Snapshot = Awaited<ReturnType<typeof snapshot>>;
async function assertCurrent(session: MetadataSession, before: Snapshot): Promise<void> {
  if (before.fingerprint !== (await snapshot(session)).fingerprint) {
    throw new EffectiveHistoryError("changed", "Auxiliary history metadata changed; retry recovery");
  }
}

function answerRows(rows: SessionRowStat[], id: string): SessionRowStat[] | null {
  const at = rows.findIndex((row) => row.id === id);
  // Never delete by id alone: it may exist on a different branch. A recent
  // prompt found inside the SDK depth-capped suffix is sufficient; finding the
  // root or reading old bodies is not necessary to identify this one turn.
  if (at < 0) return null;
  if (rows[at].role !== "user") {
    throw new EffectiveHistoryError("metadata", "Auxiliary prompt must have the user role");
  }
  let end = at + 1;
  while (end < rows.length && rows[end].role !== "user") end++;
  return rows.slice(at + 1, end);
}

/** Read ONLY this raw auxiliary answer, charging its ENTIRE size before I/O. */
export async function readAuxiliaryAnswer(
  session: AuxiliarySession, id: string, budget: number,
): Promise<SessionMessage[]> {
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new EffectiveHistoryError("budget", "Auxiliary answer budget must be a finite non-negative safe integer");
  }
  const before = await snapshot(session);
  const rows = answerRows(before.rows, id);
  if (!rows) return [];
  let charged = 0;
  for (const row of rows) {
    charged += row.bytes;
    if (!Number.isSafeInteger(charged) || charged > budget) {
      throw new EffectiveHistoryError("budget", "Auxiliary answer exceeds its byte budget");
    }
  }
  await assertCurrent(session, before);
  const answer: SessionMessage[] = [];
  for (const row of rows) {
    const message = await session.getMessage(row.id);
    if (!message || message.id !== row.id || message.role !== row.role) {
      throw new EffectiveHistoryError("changed", "Auxiliary answer no longer matches its metadata");
    }
    answer.push(message);
  }
  await assertCurrent(session, before);
  return answer;
}

/** Remove ONLY the known prompt and contiguous non-user rows, without hydration. */
export async function removeAuxiliaryTurn(session: AuxiliarySession, id: string): Promise<void> {
  const before = await snapshot(session);
  const rows = answerRows(before.rows, id);
  if (!rows) return;
  await assertCurrent(session, before);
  // SDK deleteMessages splices surviving children to their nearest surviving
  // ancestor, preserving the next original user and all of that user's answer.
  await session.deleteMessages([id, ...rows.map((row) => row.id)]);
}
