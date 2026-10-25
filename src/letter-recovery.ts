import type { StoredCompaction } from "agents/sessions";

/** Only the session operations needed to commit an already-written letter. */
export interface LetterRecoverySession {
  getHistory(): Promise<readonly { id: string }[]>;
  /** SDK order: oldest compaction first. */
  getCompactions(): Promise<readonly Pick<StoredCompaction, "id" | "summary" | "fromMessageId" | "toMessageId">[]>;
  addCompaction(summary: string, fromMessageId: string, toMessageId: string): Promise<unknown>;
}

export interface LetterRecoveryJob {
  summary: string;
  fromMessageId: string;
  toMessageId: string;
}

/**
 * Commit a saved letter using the same active-history start expansion as
 * Session.compact(). Directly adding the job's range would leave an earlier
 * letter visible beside the new one. If the new range starts before the old
 * overlay, include it too (older deployments kept the first three messages).
 * The caller owns serialization and job
 * deletion; any read/write failure must escape so the job remains retryable.
 */
export async function resumeLetterCompaction(
  session: LetterRecoverySession,
  job: LetterRecoveryJob,
): Promise<void> {
  const compactions = await session.getCompactions();
  const history = await session.getHistory();
  const historyIds = new Set(history.map((message) => message.id));
  const active = compactions.filter((item) =>
    historyIds.has(`compaction_${item.id}`)
    || (historyIds.has(item.fromMessageId) && historyIds.has(item.toMessageId)),
  );
  // The job's endpoints may now be hidden inside its successfully committed overlay. Its dated summary
  // identifies the saved letter even when an earlier overlay forced the committed end farther forward.
  if (!historyIds.has(job.fromMessageId) && !historyIds.has(job.toMessageId) && active.some((item) => item.summary === job.summary)) return;
  const existing = active[0];
  let from = existing?.fromMessageId ?? job.fromMessageId;
  let to = job.toMessageId;
  if (existing) {
    const jobAt = history.findIndex((message) => message.id === job.fromMessageId);
    const overlayAt = history.findIndex((message) => message.id === `compaction_${existing.id}`);
    const existingAt = overlayAt < 0 ? history.findIndex((message) => message.id === existing.fromMessageId) : overlayAt;
    if (jobAt >= 0 && existingAt >= 0 && jobAt < existingAt) from = job.fromMessageId;
  }
  // On old deployments, only the permanent head may lie outside the recent-chat window. In that case
  // the new job ends BEFORE the previous letter: extend the end as well, so the old letter is replaced.
  const endAt = history.findIndex((message) => message.id === job.toMessageId);
  if (endAt >= 0) {
    let lastAt = endAt;
    for (const item of active) {
      const at = history.findIndex((message) => message.id === `compaction_${item.id}`);
      if (at > lastAt) {
        lastAt = at;
        to = item.toMessageId;
      }
    }
  }
  // A crash can happen after the overlay was stored but before job deletion. An old head-preserving overlay
  // with the same summary/end still needs extending when this job starts earlier.
  if (compactions.some((item) => item.toMessageId === to && item.summary === job.summary && item.fromMessageId === from)) return;
  await session.addCompaction(job.summary, from, to);
}
