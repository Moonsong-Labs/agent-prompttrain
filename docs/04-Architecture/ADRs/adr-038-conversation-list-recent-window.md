# ADR-038: Conversation List Recent Window

## Status

Accepted (2026-09-25)

## Context

`GET /api/conversations` serves the dashboard landing page. The dashboard always identifies the
signed-in user, and the endpoint only bounded its work to the last 7 days for anonymous callers,
so every signed-in load grouped the whole request history to pick one page of conversation IDs
(6.9 s cold / 1.67 s warm for a user with 29 accessible projects, against ~100 ms when bounded
to 7 days) and ran an exact `COUNT(DISTINCT conversation_id)` over it (1.66 s against ~100 ms).
The anonymous fast path also applied the 7-day bound to the per-conversation aggregates, so
message counts, first-message times, tokens and branches only covered the last 7 days.

## Decision Drivers

- Landing-page latency for signed-in users
- Pages and per-conversation aggregates identical to a full-history listing
- No schema change, migration or write-path change
- A slightly stale total is acceptable; a stale page is not

## Considered Options

1. **Windowed page selection with exact fallback, split total** — select page IDs from the last
   7 days, fall back to full history when the window is short; total = live recent count +
   cached older count.
   - Pros: query-only change; pages stay exact; the common case reads only recent rows.
   - Cons: pages past the window still scan full history; the total may drift within the TTL.
2. **Maintained per-conversation summary table** (last message time, counts) updated on insert.
   - Pros: every page and count is cheap.
   - Cons: write-path change, backfill and migration on a heavily written table.
3. **Cache the whole exact count, or use planner estimates** for the total.
   - Cons: a cached total misses new conversations for the whole TTL; estimates are unreliable
     under project, account and access filters.
4. **Keyset pagination without a total.**
   - Cons: the dashboard shows page numbers and a total; needs a UI change.

## Decision

Option 1, implemented in `services/proxy/src/services/conversation-list.ts`.

- **Page selection.** Without `dateFrom`/`dateTo`, page IDs are selected from requests in the
  last 7 days, ordered by `MAX(timestamp) DESC` then `conversation_id DESC`. Every conversation
  active in the window sorts before every conversation that is not, so a windowed page that
  comes back full equals the same page over full history. A short page re-selects the IDs over
  full history. With explicit dates the IDs are selected within those bounds, as before. The
  `conversation_id` tiebreaker makes the windowed and full-history selections agree when
  last-message times tie.
- **Details.** Aggregates, latest request and first sub-task are computed for the selected IDs
  (`conversation_id = ANY(...)`) over every request that matches the filters, without the window.
- **Total.** With explicit dates, an exact count. Otherwise a live count of conversations active
  in the window plus the count of older ones (total minus recent, computed in one statement),
  cached for one hour per principal, project and account. Concurrent misses share one
  computation and failures are not cached. When a page returns rows, the reported total is at
  least `offset` plus those rows.

## Consequences

- Positive: signed-in landing pages read only recent rows to choose the page and count; anonymous
  aggregates now cover full history.
- Negative: a page not fully inside the window (a user with fewer recent conversations than the
  page size, later pages, filters with little recent activity) still scans full history, after
  the windowed attempt. The first request per key each hour waits for the full older count.
- Drift: within the TTL, conversations that age out of the window are missed (undercount) and
  older conversations that become active again are counted twice (overcount), bounded by one
  hour of activity. The `offset + rows` guard keeps an undercount from hiding the current page.
- The older-count cache is in-process: each proxy replica computes and holds its own, and a
  restart clears it. The endpoint's 15 s whole-response cache still applies on top.

## Links

- [ADR-037: Precomputed Last-Message Summary](./adr-037-precomputed-last-message-summary.md)
- [API Reference: List Conversations](../../02-User-Guide/api-reference.md#list-conversations)
- [Technical Debt Register: Dashboard Overview Performance](../technical-debt.md)
