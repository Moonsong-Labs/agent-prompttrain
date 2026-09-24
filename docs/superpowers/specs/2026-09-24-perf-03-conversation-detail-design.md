# Conversation Detail Performance (PERF-03) — Design Spec

**Date**: 2026-09-24
**Status**: Approved

## Summary

Make the dashboard conversation detail page (`/dashboard/conversation/:id`) fast for long conversations by precomputing a small summary of each request's last message at write time, removing full-body transfers from the read path, batching sub-task lookups, and rendering only the active view. Delivered as one PR.

## Problem

Measured against the production database on 2026-09-23 (from a workstation ~90 ms from the DB):

| Conversation              | Stored bodies (compressed) | Page time                    | HTML    |
| ------------------------- | -------------------------- | ---------------------------- | ------- |
| 641 requests, 9 branches  | 893 MB                     | 9.1 s cold / 8.0 s warm      | 2.66 MB |
| 282 requests, 15 branches | 207 MB                     | 4.2–4.9 s (first hit 10.2 s) | 1.21 MB |

The largest conversations active in the last 30 days hold 1.8–2.9 GB of bodies. Each view also added ~150 MB of dashboard RSS.

Root causes in `services/dashboard/src/storage/reader.ts` `getConversationById`:

1. `body -> 'messages' -> -1` is evaluated for **every** request row. PostgreSQL cannot partially read a TOASTed JSONB value, so every body in the conversation is fully decompressed.
2. `CASE WHEN rn = 1 THEN body` ships the full body of each branch's latest request to Node (~19–21 MB), where only one is used to count user messages (`countUserInteractions`).
3. The window-function CTE uses `SELECT *`.

In `services/dashboard/src/routes/conversation-detail.ts`:

4. Tree, timeline and analytics views are all rendered server-side regardless of the active tab (tabs switch client-side via `switchTab`).
5. `getSubtasksForRequest` is awaited sequentially per request (lines ~78 and ~302) with `SELECT *`.
6. `/conversation/:id/messages` and `/partials/analytics/conversation/:id` reload the same heavy query.

## What the page actually needs per request

- From the last message: `role`, whether it has visible text, an 80-char preview (`getLastMessageContent`), `tool_result` blocks (`tool_use_id`, `is_error`, 50-char preview), `tool_use` name/prompt preview.
- From `response_body`: `usage` and `content` (tool_use ids/names, assistant text) — small, unchanged.
- From the latest request of the first branch: count of user messages with visible text.

## Success Criteria

- 641-request conversation page < 1.5 s cold; 282-request conversation < 1 s (post-deploy, post-backfill).
- DB work on the page no longer scales with body size.
- Default (tree) view HTML < 500 KB.
- Dashboard RSS increase per view < 50 MB.
- Rendered output (node types, metrics, previews, timeline) identical to today for the same data.

## Design

### 1. Schema — migration `026-add-last-message-summary.ts`

```sql
SET lock_timeout = '5s';
ALTER TABLE api_requests
  ADD COLUMN IF NOT EXISTS last_message_summary JSONB,
  ADD COLUMN IF NOT EXISTS user_text_message_count INTEGER;
```

- Nullable, no default ⇒ metadata-only, no table rewrite, no index.
- Idempotent; follows the `021-add-project-disabled.ts` pattern (transaction, verification, `down`).
- Must be applied **before** deploying the new proxy and dashboard.
- Recorded in a new ADR (`adr-037-precomputed-last-message-summary.md`) and in `docs/03-Operations/database.md`.

### 2. Shared summary functions — `packages/shared/src/utils/message-summary.ts`

`summarizeLastMessage(message) → { role, content } | null` — same shape as a Claude message so consumers are unchanged. Block rules (order and `type` preserved):

| Block                        | Stored as                                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| string `content`             | `content.trim().slice(0, 200)`                                                                                                                                       |
| `text`                       | `{ type, text: text.trim().slice(0, 200) }`                                                                                                                          |
| `tool_result`                | `{ type, tool_use_id, is_error, content }` — `content` = string source (or `JSON.stringify` of non-string content) sliced to 200 chars; omitted when source is falsy |
| `tool_use`                   | `{ type, id, name, input: { prompt: prompt.slice(0, 200) } }` (`input` only when a prompt exists)                                                                    |
| `image`, `document`, unknown | `{ type }` only                                                                                                                                                      |

Trimming before slicing keeps `hasVisibleText` and the existing previews (trim → 77 chars + `...` when > 80) byte-identical. 200 chars > 81 keeps every length decision unchanged.

Every slice counts UTF-16 code units and drops a trailing high surrogate, so a character above U+FFFF (e.g. an emoji) at the boundary is never split: PostgreSQL rejects a lone surrogate in JSONB. At least 199 units remain, still > 81.

`countUserTextMessages(messages) → number` — count of `role === 'user'` messages where `hasVisibleText` is true. `hasVisibleText` moves from `services/dashboard/src/utils/conversation-metrics.ts` to shared (ADR-001); the dashboard imports it.

`USER_TEXT_MESSAGE_COUNT_SQL` — exported SQL fragment implementing the same rule over `body -> 'messages'` (string content with a non-whitespace char, or an array containing a `text` block with a non-whitespace char). Used by the reader fallback and the backfill. Parity with the JS function is covered by tests; any unavoidable Unicode-whitespace difference is documented.

### 3. Write path — `services/proxy/src/storage/writer.ts` `storeRequest`

- Compute both values from `request.body.messages` (already parsed in memory) and add them to the existing INSERT (two extra parameters; no extra query per request).
- Summary computation is wrapped so any failure stores `NULL` and the INSERT still happens — the summary can never cause a lost request row.
- If PostgreSQL still rejects the INSERT as invalid text (SQLSTATE `22P02`/`22P05`) while summary values are present, it is retried once with both summary columns `NULL` and a warning is logged.
- The writer checks once per process (`information_schema.columns`) whether both columns exist. Without them (migration 026 not applied) it uses the pre-026 INSERT and logs one error, so request rows are kept.

### 4. Read path — `services/dashboard/src/storage/reader.ts`

Requests query:

- Explicit column list in the window CTE (window over `COALESCE(branch_id, 'main')` ordered by `timestamp DESC`).
- `last_message` = `CASE WHEN last_message_summary IS NOT NULL THEN last_message_summary ELSE body -> 'messages' -> -1 END` — only legacy rows are decompressed.
- No full `body` is returned. For `rn = 1` rows only: `user_text_message_count` = stored value, or `USER_TEXT_MESSAGE_COUNT_SQL` when NULL (legacy). Returning it only for `rn = 1` preserves today's selection semantics exactly.
- `countUserInteractions` (`utils/conversation-metrics.ts`) uses `user_text_message_count` of the same selected request (first branch's latest, as today); falls back to `body.messages` when present. The questionable "first branch" selection is preserved and flagged in the PR, not changed.

Sub-tasks:

- New `getSubtasksForRequests(requestIds: string[])` — one query, `WHERE parent_task_request_id = ANY($1)`, selecting only `request_id, conversation_id, is_subtask, parent_task_request_id, timestamp`.
- The route calls it once and reuses the map at both former call sites. The single-request `getSubtasksForRequest` stays for `/api/requests/:id/subtasks`.

### 5. Rendering — `services/dashboard/src/routes/conversation-detail.ts`

- Extract `filterRequestsByBranch(requests, selectedBranch)` and `buildSubtasksMap(requests, subtasksByRequest)` (in `services/dashboard/src/utils/conversation-timeline.ts`), used by both the main route and `/conversation/:id/messages`, so both produce identical timeline HTML (the `/messages` route currently omits sub-task info).
- Timeline panel is server-rendered only when `view=timeline`; otherwise it contains a placeholder that htmx loads from `/dashboard/conversation/:id/messages?branch=…` the first time `switchTab('timeline')` runs.
- Tree SVG (default view) and the already-lazy analytics panel stay as is. If the tree SVG alone exceeds 500 KB on the 641-request conversation, report it rather than expand scope.
- Extract the tree node last-message classification into a pure `classifyLastMessage(lastMessage)` helper (enables parity testing; behaviour unchanged).
- Access control: unchanged.

### 6. Backfill — `scripts/db/backfill-last-message-summary.ts`

- `package.json`: `db:backfill:last-message-summary`.
- Dry-run by default (reads, reports counts and summary sizes, writes nothing); `--execute` required to write.
- Options: `--days 90` (default), `--batch-size 200`, `--sleep-ms 250`, `--max-batches N`, `--before <ts>` (resume).
- Keyset pagination newest-first on `(timestamp, request_id)` over `timestamp >= now() - N days AND last_message_summary IS NULL` (uses the timestamp index).
- Per batch selects only `request_id`, `body -> 'messages' -> -1`, and `USER_TEXT_MESSAGE_COUNT_SQL` — decompression stays server-side; only the last message and an integer cross the network. Summarises in JS with the shared function, then one `UPDATE … FROM (VALUES …) … WHERE a.last_message_summary IS NULL` per batch (idempotent, resumable, never overwrites writer-populated rows).
- Safety: prints masked DB host and row estimate; refuses `--execute` on a read-only session; `statement_timeout 120s`, `lock_timeout 5s`, `application_name = backfill-last-message-summary`; Ctrl-C finishes the current batch and prints the resume cursor; progress with rows/s and ETA.
- Expected 90-day cost: ~515k rows; ~240 GB of compressed bodies read once server-side; ~515k mostly non-HOT updates (dead tuples and index entries reclaimed by autovacuum; transient heap growth < 1 GB; each update re-inserts its entries in every index, including the GIN index on `response_body`, which does not shrink — pilot with `--max-batches 50 --execute` first); ~1–2 h throttled; run off-peak (busiest hour is 20:00 UTC).
- Operated by a human against production; never run automatically.

## Testing & Verification

Test-first for every unit:

1. **Shared unit tests** — `summarizeLastMessage` (string, whitespace-only, 200-char boundary, tool_result string/array/is_error/falsy, tool_use with/without prompt, image/document/unknown, null/empty), `countUserTextMessages`, `hasVisibleText`.
2. **Parity unit test** — fixture corpus of realistic Claude Code last messages; `classifyLastMessage`, `getLastMessageContent`, `findToolExecutions`, `findReplyIntervals` produce deep-equal results on full message vs summary.
3. **Writer unit test** — INSERT includes both values; summariser failure ⇒ NULLs and INSERT still executes.
4. **DB integration test** (local Docker Postgres 16, database name ending `_test`) — migration 026 idempotent; reader derived fields identical for summarised vs legacy rows; SQL count == JS count on fixtures; backfill dry-run writes 0 rows, `--execute` fills, re-run is a no-op and never overwrites; batched sub-task lookup equals per-request lookups.
5. **Route test** — `view=tree` response has no timeline markup and a correct lazy placeholder; lazy `/messages` output is byte-identical to the server-rendered timeline for the same branch.

Quality gates (every step):

- `bun run typecheck` clean; `bun run lint` 0 errors and no new warnings in touched files; `prettier --check` on touched files.
- CI unit suite + new tests pass; new test paths confirmed included by `test:ci`.
- Integration test passes on local Docker Postgres (never production).
- `bun run test:e2e:smoke` and conversation journeys green with managed servers on the local `_test` DB; `bun run docker:validate` passes.
- Production parity check (read-only sandbox): ≥ 2,000 recent rows — derived fields from the summary match those from the full last message 100%; SQL vs JS count equal on ≥ 50 rows.
- Pre-deploy performance proxy (read-only sandbox): post-backfill query shape (no per-row extraction) < 500 ms DB time on the 641-request conversation.
- Independent code review with no unresolved Critical/Important findings.
- One PR, conventional commits, CI green.

Post-deploy (human-run): re-run the latency matrix against the success criteria above.

## Deployment Order

1. Apply migration 026.
2. Deploy proxy and dashboard together.
3. Run the backfill dry-run, then `--execute` off-peak.
4. Re-measure.

The dashboard is correct at every step: rows without a summary use the legacy extraction.

## Out of Scope

- Access-control changes on the conversation page.
- Changing which request `countUserInteractions` selects.
- Compression, response caching, NodeCache cloning, and other list/overview queries.
- Retention or deduplication of stored bodies.
