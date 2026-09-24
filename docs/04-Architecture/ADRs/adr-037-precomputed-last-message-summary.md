# ADR-037: Precomputed Last-Message Summary

## Status

Accepted (2026-09-24)

## Context

The conversation detail page derives node types, previews, tool-execution metrics and a
user-interaction count from each request's last message. It extracted that message with
`body -> 'messages' -> -1`, and PostgreSQL cannot read part of a TOASTed JSONB value, so every
view decompressed every stored body in the conversation (hundreds of MB to GB for long
Claude Code sessions, 8–9 s for a 641-request conversation).

## Decision Drivers

- Page cost must not grow with stored body size
- Rendered output must stay identical
- No table rewrite or long lock on `api_requests`
- History must be fillable without a production outage

## Considered Options

1. **Columns on `api_requests`** — two nullable columns filled at INSERT time.
   - Pros: no join, same shape as the old `last_message` field, metadata-only migration.
   - Cons: backfill updates are mostly non-HOT on a heavily indexed table.
2. **Side table keyed by `request_id`** — cheap backfill inserts.
   - Cons: a second write per request and another table to keep consistent.
3. **Typed scalar columns** (role, preview, tool-result ids/flags, count).
   - Cons: every consumer must change shape; highest risk to identical output.

## Decision

Option 1. The proxy stores `last_message_summary` (a truncated copy of the last message: text
trimmed and clipped to 200 UTF-16 code units per field without splitting a surrogate pair,
tool-result ids/error flags, tool-use names, no binary payloads) and `user_text_message_count` in the same INSERT. The logic lives in
`packages/shared/src/utils/message-summary.ts`, with a SQL twin (`userTextMessageCountSql`)
used by the dashboard fallback and the backfill. Readers prefer the stored columns and fall
back to body extraction only for rows without a summary. `scripts/db/backfill-last-message-summary.ts`
fills recent history (default 90 days), dry-run by default.

## Consequences

- Positive: the conversation page reads only small columns for summarised rows.
- Negative: summaries duplicate a small, truncated part of each body (~0.2–2 KB per row).
- Deployment order: migration 026 → proxy and dashboard → backfill. A proxy started before the
  migration stores requests without summaries and logs an error until the migration is applied
  and the proxy is restarted.
- Summary failures store NULL and never block the request INSERT; an INSERT that PostgreSQL
  rejects as invalid text (`22P02`/`22P05`) is retried once without the summary.
