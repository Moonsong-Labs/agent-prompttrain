/**
 * SQL shared by the proxy's per-request upsert (StorageWriter) and
 * scripts/db/backfill-conversation-summaries.ts, so live writes, retries and the backfill merge
 * identically in any order (ADR-039).
 */

/**
 * Keeps the earliest first activity, the latest last activity and the union of accounts. The
 * target table must be aliased `cs`. Rows that would not change are not rewritten, so re-runs
 * and duplicate activity leave no dead tuples.
 */
export const CONVERSATION_SUMMARY_MERGE_SQL = `
  ON CONFLICT (conversation_id, project_id) DO UPDATE SET
    first_activity_at = LEAST(cs.first_activity_at, EXCLUDED.first_activity_at),
    last_activity_at = GREATEST(cs.last_activity_at, EXCLUDED.last_activity_at),
    account_ids = CASE
      WHEN EXCLUDED.account_ids <@ cs.account_ids THEN cs.account_ids
      ELSE ARRAY(SELECT DISTINCT unnest(cs.account_ids || EXCLUDED.account_ids))
    END
  WHERE EXCLUDED.first_activity_at < cs.first_activity_at
    OR EXCLUDED.last_activity_at > cs.last_activity_at
    OR NOT (EXCLUDED.account_ids <@ cs.account_ids)`

/** $1 conversation_id, $2 project_id, $3 request timestamp, $4 accounts ({accountId} or {}) */
export const UPSERT_CONVERSATION_SUMMARY_SQL = `
  INSERT INTO conversation_summaries AS cs
    (conversation_id, project_id, first_activity_at, last_activity_at, account_ids)
  VALUES ($1, $2, $3, $3, $4)
  ${CONVERSATION_SUMMARY_MERGE_SQL}`
