# ADR-039: Conversation Summaries Table

## Status

Accepted (2026-09-25). Supersedes [ADR-038](./adr-038-conversation-list-recent-window.md).

## Context

`GET /api/conversations` serves the dashboard landing page. ADR-038 selects page IDs from a 7-day
window and totals a live 7-day count plus an older-conversation count cached for one hour per
principal and filters. Uncached loads dropped from 1.6-6.9 s to 0.4-0.6 s, but the first load per
key each hour, and every load after a proxy restart, still runs an exact
`COUNT(DISTINCT conversation_id)` over the full history (about 1.7 s warm, 6-7 s cold), and the
total can drift by up to an hour of activity. Production holds about 283,000 conversations over
1.5 million requests; 15 conversations span more than one project and 8.6% use more than one
account.

## Decision Drivers

- Every call without explicit dates under 0.5 s, cold or warm
- Page IDs, their order and the total identical to the request-level listing
- Maintaining the summary never costs or delays storing a request beyond one round trip
- Explicit `dateFrom`/`dateTo` requests and the flag-off path unchanged

## Considered Options

1. **Write-maintained `conversation_summaries` table**, one row per conversation and project.
   - Pros: page selection and totals are index lookups; exact.
   - Cons: an upsert per stored request, a migration and a backfill.
2. **Keep ADR-038 with a longer or pre-warmed older-count cache.**
   - Cons: still a full-history count per key and per restart; more drift.
3. **Materialized view refreshed on a schedule.**
   - Cons: a full recompute per refresh (grouping the history takes about 6 s); stale in between.
4. **Per-conversation rollups (counts, tokens, branches) in the table as well.**
   - Pros: would also remove the details query.
   - Cons: far more write-path logic for a query already bounded to one page.

## Decision

Option 1.

- **Schema** (migration 027): `conversation_summaries (conversation_id, project_id, first_activity_at, last_activity_at, account_ids)` with primary key `(conversation_id, project_id)`, btree indexes on `(last_activity_at DESC, conversation_id DESC)` and `(project_id, last_activity_at DESC, conversation_id DESC)`, and a GIN index on `account_ids`. One row per project keeps the privacy rule of ADR-029: a conversation is listed when any of its projects is accessible, ordered by its activity in those projects, and its details still come only from accessible requests.
- **Write path**: after `StorageWriter.storeRequest` has stored a request row with a `conversation_id`, one awaited upsert keeps the earliest first activity, the latest last activity (the request's own `timestamp`) and the union of accounts; updates that would change nothing are skipped. The merge is order-independent and idempotent, so live writes, retries and the backfill converge in any order. Upsert errors are logged and never fail the request; a missing table is detected once per writer and logged once.
- **Backfill and reconcile**: `scripts/db/backfill-conversation-summaries.ts` upserts one grouped statement per 7-day chunk of `api_requests` (or since `--since`) with the same merge rules. Dry-run by default, safe while the proxy writes and safe to re-run.
- **Read path**: with `CONVERSATION_SUMMARIES_ENABLED=true` and no `dateFrom`/`dateTo`, the caller's accessible projects are resolved first and intersected with `projectId`. Page IDs are read newest first with `LIMIT offset + limit + 32`, de-duplicated per conversation (keeping its newest row) and re-read with a doubled limit when duplicates exceed that slack; the total is an exact `COUNT(DISTINCT conversation_id)` over the same rows. With an `accountId` filter the page IDs keep ADR-038's request-level selection, because a row's `last_activity_at` covers every account while the list orders by the filtered account's own last request; the total still comes from the table. Details, the response shape and the 15 s response cache are unchanged.
- **Rollout**: apply the migration, deploy with the flag off (the table starts being maintained), run the backfill, check with `scripts/db/verify-conversation-summaries.ts` (read-only), then enable the flag. Rollback: set it back to `false`.

## Consequences

- Positive: every call without explicit dates selects its page and counts its total with index lookups on a small table, cold or warm, and the total is exact.
- Negative: one extra round trip per stored request with a conversation; concurrent requests in one conversation (parallel sub-agents) briefly serialize on its row; about 30-50 MB of table and indexes.
- Account-filtered pages still select their IDs from `api_requests` (the ADR-038 cost).
- The table only gains and widens rows on its own. `rebuild-conversations.ts` refreshes the rows of every conversation it re-keys, old and new id, from `api_requests` (`refreshConversationSummaries`, batches of 1000, its own transaction per batch). Requests inserted outside the proxy (SQL seeds, `copy-conversation.ts`) are still missing until the backfill runs again; a re-key or delete by any other means outside the proxy leaves stale rows that only a rebuild removes: turn the flag off, run `SET lock_timeout = '5s'; TRUNCATE conversation_summaries;` (so it cannot queue behind a long reader such as the verify snapshot and block live upserts), re-run the backfill with `--execute` and verify before turning it back on.
- Backfill runbook: run it off-peak with `--chunk-days 1` in production, since each chunk holds row locks on every conversation it touches (including re-runs) until it commits, and live upserts of those conversations wait for it; start it only after every proxy task runs the version that maintains the table, since requests stored by an old task after their chunk has run are otherwise missing until the next backfill; and `--since` filters on the request's own timestamp, not on when it was stored, so a full backfill (no `--since`) is needed after `copy-conversation.ts` or SQL seeds.
- The ADR-038 window path and the flag stay until a follow-up removes them, once production has run with the flag on.

## Links

- [ADR-038: Conversation List Recent Window](./adr-038-conversation-list-recent-window.md)
- [ADR-029: Project Privacy Model](./adr-029-project-privacy-model.md)
- [Database Schema: conversation_summaries](../../03-Operations/database.md#conversation_summaries)
- [API Reference: List Conversations](../../02-User-Guide/api-reference.md#list-conversations)
- [Environment Variables](../../06-Reference/environment-vars.md)
- [Scripts: backfill and verify](../../../scripts/README.md)
