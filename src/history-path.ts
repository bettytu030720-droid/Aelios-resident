import type { Sql } from "./sticker-store";

// Matches the pinned Sessions path traversal ceiling. This query reads IDs only,
// including hidden legacy overlay rows: a filtered row count cannot prove completeness.
const MAX_PATH_DEPTH = 10_000;

/** Fail closed on a missing parent, cycle, or SDK-capped branch; never load content to check. */
export function historyPathComplete(sql: Sql, sessionId: string, leafId: string): boolean {
  const [oldest] = sql<{ parent_id: string | null }>`
    WITH RECURSIVE path(id, parent_id, depth) AS (
      SELECT id, parent_id, 0 FROM cf_agents_session_messages
      WHERE session_id = ${sessionId} AND id = ${leafId}
      UNION ALL
      SELECT m.id, m.parent_id, p.depth + 1 FROM cf_agents_session_messages m
      JOIN path p ON m.id = p.parent_id
      WHERE m.session_id = ${sessionId} AND p.depth < ${MAX_PATH_DEPTH}
    )
    SELECT parent_id FROM path ORDER BY depth DESC LIMIT 1
  `;
  return Boolean(oldest) && oldest.parent_id === null;
}
