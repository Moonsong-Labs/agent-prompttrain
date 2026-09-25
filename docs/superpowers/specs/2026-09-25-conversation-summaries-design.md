# Conversation Summaries Table — Design Spec

**Date**: 2026-09-25
**Status**: Approved
**Supersedes**: ADR-038 (conversation list recent window), via a new ADR-039

## Summary

Give the proxy's `GET /api/conversations` (the dashboard landing page) a small, write-maintained `conversation_summaries` table so that page selection and the exact total are index lookups for every request, cold or warm, with no full-history scan and no hourly recompute.

## Problem

PR #213 (merged, ADR-038) selects page IDs from a 7-day window and computes the total as a live 7-day count plus an older-conversation count cached for 1 hour per user and filters. Uncached loads dropped from 1.6–6.9 s to 0.4–0.6 s, but the first load per user per hour — and every load after a proxy restart — still runs an exact `COUNT(DISTINCT conversation_id)` over the full history: ~1.7 s with warm buffers, 6–7 s cold (measured 8.1 s end to end from a workstation). The total can also drift by up to an hour of activity.

Production facts (2026-09-25, read-only): 283,352 conversations over 1.5 M requests; 15 conversations span more than one project (max 3); 24,511 (8.6 %) use more than one account; 17 requests have no `conversation_id`; grouping the whole history by `(conversation_id, project_id)` takes 5.7 s (heap only, no TOAST).

## Success Criteria

- Every `/api/conversations` call (any user, cold or warm, no explicit dates) < 0.5 s end to end in production.
- Page IDs, their order and the total are exact — identical to the request-level reference query.
- A failure to maintain the summary never costs or delays storing a request beyond one round trip.
- Explicit `dateFrom`/`dateTo` requests and the flag-off path behave exactly as today.

## Design

### 1. Schema — migration `027-add-conversation-summaries.ts`

```sql
CREATE TABLE IF NOT EXISTS conversation_summaries (
  conversation_id   UUID         NOT NULL,
  project_id        VARCHAR(255) NOT NULL,
  first_activity_at TIMESTAMPTZ  NOT NULL,
  last_activity_at  TIMESTAMPTZ  NOT NULL,
  account_ids       TEXT[]       NOT NULL DEFAULT '{}',
  PRIMARY KEY (conversation_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_summaries_last_activity
  ON conversation_summaries (last_activity_at DESC, conversation_id DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_summaries_project_last_activity
  ON conversation_summaries (project_id, last_activity_at DESC, conversation_id DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_summaries_account_ids
  ON conversation_summaries USING GIN (account_ids);
```

- One row per conversation per project: the 15 cross-project conversations keep today's privacy semantics (visible if any of its projects is accessible; details still come only from accessible requests).
- The table holds only what page selection, totals and filters need. Per-conversation details (message counts, tokens, branches, models, latest request, sub-task parent) keep coming from `api_requests` for the selected IDs.
- `project_id` uses the same slug as `api_requests.project_id` (no FK, consistent with `api_requests`).
- Idempotent (`IF NOT EXISTS`), `SET LOCAL lock_timeout = '5s'`, `up`/`down`, same pattern as migration 026. Empty at creation, so effectively instant.
- Estimated size: ~283 k rows, ~30–50 MB including indexes.

### 2. Write path — `services/proxy/src/storage/writer.ts`

After the `api_requests` INSERT in `StorageWriter.storeRequest` succeeds (including its existing 22P02/22P05 retry and pre-026 fallback), and only when `request.conversationId` is set, run one upsert:

```sql
INSERT INTO conversation_summaries AS cs
  (conversation_id, project_id, first_activity_at, last_activity_at, account_ids)
VALUES ($1, $2, $3, $3, $4)            -- $3 = request timestamp, $4 = {accountId} or {}
ON CONFLICT (conversation_id, project_id) DO UPDATE SET
  first_activity_at = LEAST(cs.first_activity_at, EXCLUDED.first_activity_at),
  last_activity_at  = GREATEST(cs.last_activity_at, EXCLUDED.last_activity_at),
  account_ids = CASE WHEN EXCLUDED.account_ids <@ cs.account_ids THEN cs.account_ids
                     ELSE ARRAY(SELECT DISTINCT unnest(cs.account_ids || EXCLUDED.account_ids)) END
```

- The timestamp is the request's own `timestamp` — the value the list orders by today (`MAX(api_requests.timestamp)`).
- Order-independent and idempotent (`LEAST`/`GREATEST`/set union): live writes, retries, duplicate request ids (the INSERT is `ON CONFLICT (request_id) DO NOTHING`) and the backfill converge in any order.
- Separate statement, awaited, errors caught and logged: it can never fail or lose the request row. Cost: one extra round trip (~1–3 ms in-region).
- If `conversation_summaries` does not exist (migration 027 not applied), the upsert is skipped and one loud error is logged per writer (same once-per-process detection pattern as `hasSummaryColumns`).
- Contention: concurrent requests in one conversation (parallel sub-agents share `conversation_id`) serialize briefly on the row lock; acceptable.

### 3. Backfill and reconcile — `scripts/db/backfill-conversation-summaries.ts`

- Derives rows from `api_requests` with one grouped statement per time chunk:
  `INSERT INTO conversation_summaries (…) SELECT conversation_id, project_id, MIN(timestamp), MAX(timestamp), COALESCE(ARRAY_AGG(DISTINCT account_id) FILTER (WHERE account_id IS NOT NULL), '{}') FROM api_requests WHERE conversation_id IS NOT NULL AND timestamp >= $from AND timestamp < $to GROUP BY 1, 2 ON CONFLICT … DO UPDATE` with the same merge rules as the write path.
- Chunks default to 7 days, walking the whole history (or `--since <ts>` for a reconcile of recent activity); dry-run by default (reports chunk counts), `--execute` to write; `statement_timeout 120s`, `lock_timeout 5s`, `application_name = backfill-conversation-summaries`; refuses `--execute` on a read-only session; masked DB host; progress per chunk. Expected production runtime ~1 minute.
- Safe to run while the proxy is writing (merge rules), safe to re-run.
- `package.json`: `db:backfill:conversation-summaries`.

### 4. Read path — `services/proxy/src/services/conversation-list.ts`

New path, used when `CONVERSATION_SUMMARIES_ENABLED === 'true'` and the request has no `dateFrom`/`dateTo`:

1. **Accessible projects.** Resolve the principal's accessible project slugs with the existing privacy rule (public projects, or private projects where the principal is a member), intersected with `projectId` when given. Anonymous requests have no project restriction (as today).
2. **Page IDs.**

   ```sql
   SELECT conversation_id, last_activity_at FROM conversation_summaries
   WHERE [project_id = ANY($projects)] [AND $accountId = ANY(account_ids)]
   ORDER BY last_activity_at DESC, conversation_id DESC
   LIMIT $offset + $limit + 32
   ```

   De-duplicate by `conversation_id` keeping the first (newest) occurrence; if fewer than `offset + limit` distinct IDs remain and the scan returned its full limit, re-scan with a doubled limit until satisfied or exhausted; slice `[offset, offset + limit)`. Ordering and tiebreak are identical to the request-level path.

   **Amendment (approved 2026-09-25):** with an `accountId` filter the request-level list orders conversations by their last request _with that account_, which `last_activity_at` (all accounts) cannot reproduce for multi-account conversations (8.6 %). Account-filtered requests therefore keep the #213 request-level page selection; only their exact total comes from the table (`account_ids @> ARRAY[$accountId]`, served by the GIN index).

3. **Total.** `SELECT COUNT(DISTINCT conversation_id) FROM conversation_summaries WHERE …same filters…` — exact.
4. **Details.** Unchanged: the existing `fetchDetails` query over `api_requests` for the selected IDs with the same filters and privacy.
5. The response shape, the 15 s route response cache and its key are unchanged.

Unchanged paths:

- Flag off (default): exactly the #213 behaviour (window + fallback + older-count cache).
- Explicit `dateFrom`/`dateTo`: the existing exact request-level path.

The flag is read per call (so tests can toggle it) and documented in `docs/06-Reference/environment-vars.md`. A follow-up PR removes the window path and the flag once production has run with the flag on.

### 5. Documentation

- New `docs/04-Architecture/ADRs/adr-039-conversation-summaries-table.md` (Accepted, 2026-09-25) and its README row; ADR-038 status changed to "Superseded by ADR-039".
- `docs/03-Operations/database.md`: table definition.
- `docs/02-User-Guide/api-reference.md`: the `/api/conversations` total is exact when the summary table is enabled.
- `scripts/README.md`: backfill and verify scripts.

## Rollout

1. Apply migration 027.
2. Deploy the proxy with the flag off (the table starts being maintained; reads unchanged).
3. Run the backfill (`--execute`).
4. Verify with `scripts/db/verify-conversation-summaries.ts` (read-only; see Testing).
5. Set `CONVERSATION_SUMMARIES_ENABLED=true` in a new proxy task-definition revision and redeploy. Rollback: set it back to false.
6. Measure `listConversations` against production (read-only), cold and warm.

Each production step is executed only after explicit human approval.

## Testing & Verification

Test-first for every unit:

1. **Writer unit tests** — the upsert runs after a successful INSERT and only with a `conversation_id`; it is not run when the INSERT fails; an upsert error is swallowed and logged without affecting the stored row; with the table missing it is skipped and one error is logged once.
2. **Reader unit tests** (mock pool) — flag on: page IDs and total come only from `conversation_summaries` (no `api_requests` scan for them); cross-project duplicates are de-duplicated; the re-scan triggers when duplicates exceed the slack; `projectId`, `accountId` and privacy filters apply; the total is exact; flag off and explicit dates use the existing paths (all existing tests still pass).
3. **Backfill unit tests** — argument parsing and chunk planning.
4. **DB integration test** (local Docker Postgres, database name ending in `_test`, skipped otherwise) — seed through the real `StorageWriter.storeRequest` (cross-project and multi-account conversations, out-of-order timestamps, requests without a conversation): table rows equal a grouped reference computed from `api_requests`; listing with the flag on matches the request-level reference for pages 1–3 under anonymous, member, non-member, `projectId` and `accountId`; backfill is idempotent and converges with live upserts in either order; migration 027 runs twice.
5. **E2E** — `scripts/e2e/setup-database.ts` runs the backfill after seeding; `@smoke|@journey` pass with the flag off and with it on.
6. **Verify script** `scripts/db/verify-conversation-summaries.ts` (read-only; sets its own read-only session) — for sampled principals plus anonymous, a `projectId` filter and an `accountId` filter: pages 1–3 IDs/order and totals from the table equal the request-level reference; conversation counts match `api_requests` except rows newer than the check start; prints ids/counts only; exit 1 on mismatch.

Quality gates (every task): `bun run typecheck`; `bun run lint` 0 errors and ≤ 245 warnings; `prettier --check` and the invisible-character grep on changed files; `test:ci`; the DB integration suites; E2E. Every Bun command runs with `bun --no-env-file` or an explicit dead `DATABASE_URL` (the repository `.env` points at production and Bun auto-loads it). No production access during implementation.

## Out of Scope

- Removing the #213 window path and the flag (follow-up).
- Storing per-conversation rollups in the table.
- Any other endpoint, and access-control changes.
