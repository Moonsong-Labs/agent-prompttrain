# Account Pool Auto-Switching Design

**Date**: 2026-02-24
**Status**: Approved (Revised)

## Problem

Projects with high usage hit Claude's token rate limits (5-hour and 7-day windows), blocking work. There is no automatic failover to alternative accounts.

## Solution

Add an `AccountPoolService` that automatically selects the best account from a project's linked accounts based on real-time utilization data from the Anthropic OAuth usage API. Projects with 2+ linked accounts get automatic pool switching; projects with 0-1 accounts retain current fixed-account behavior.

## Design Decisions

- **Usage source**: Anthropic OAuth usage API (`/api/oauth/usage`) — returns real utilization percentages for 5h and 7d windows
- **Trigger**: Switch when EITHER the 5-hour OR 7-day utilization exceeds the per-account threshold
- **Threshold config**: Per-account `token_limit_threshold` in `credentials` table (percentage, default 0.80)
- **Selection strategy**: Sticky least-loaded — stay on current account until threshold exceeded, then switch to least-loaded alternative
- **Caching**: 60-second in-memory cache per account to avoid hammering the Anthropic API
- **Exhaustion behavior**: Return HTTP 429 with estimated availability time (from `resets_at`)
- **Pool activation**: Implicit — projects with 2+ linked accounts use the pool; 0-1 accounts use `default_account_id` directly

## Architecture

### Anthropic OAuth Usage API

Already used by the dashboard (`GET /api/oauth-usage/:accountId`). Returns:

```typescript
{
  five_hour?: { utilization: number; resets_at: string } | null
  seven_day?: { utilization: number; resets_at: string } | null
  seven_day_opus?: { utilization: number; resets_at: string } | null
  seven_day_sonnet?: { utilization: number; resets_at: string } | null
}
```

Where `utilization` is a 0-1 float (e.g., 0.82 = 82% used).

### Database Schema Changes

Add one column to `credentials` table:

```sql
ALTER TABLE credentials
  ADD COLUMN token_limit_threshold DECIMAL(3,2) NOT NULL DEFAULT 0.80;
```

- `token_limit_threshold`: Utilization percentage at which to switch (0.80 = 80%)
- CHECK constraint: `token_limit_threshold > 0 AND token_limit_threshold <= 1`

No `token_limit` or `token_limit_window_hours` columns needed — Anthropic already knows the limits.

### AccountPoolService

New file: `services/proxy/src/services/account-pool-service.ts`

**Core algorithm:**

```
selectAccount(projectId):
  1. Get linked credentials for project
     - If 0-1 -> use default_account_id (no pooling)
     - If 2+ -> continue with pool logic

  2. Get stickyAccountId from in-memory map

  3. If sticky exists and is in linked accounts:
     a. Get cached or fresh usage (Anthropic OAuth API, 60s cache)
     b. If max(five_hour.utilization, seven_day.utilization) < threshold
        -> return sticky account

  4. If no sticky or sticky exceeded threshold:
     a. Fetch usage for ALL linked accounts (parallel API calls, cached)
     b. For each: compute max utilization across 5h and 7d windows
     c. Filter to accounts under their threshold
     d. Pick the one with lowest max utilization
     e. Update sticky map -> return selected account

  5. If all accounts over threshold:
     a. Use earliest resets_at from all accounts
     b. Throw AccountPoolExhaustedError -> HTTP 429
```

**Caching:**

```
Map<accountId, { usage: OAuthUsageData, fetchedAt: number }>
TTL: 60 seconds
```

On each check: if cache hit and age < 60s, use cached. Otherwise call Anthropic API and update cache.

### AuthenticationService Integration

```
authenticate(context):
  1. If MSL-Account header -> use explicit account (unchanged)
  2. Get project's linked accounts
     - If 0-1 accounts -> use default_account_id directly (current behavior)
     - If 2+ accounts -> delegate to AccountPoolService.selectAccount()
  3. Fetch credential, refresh token, build headers (unchanged)
```

### Error Response (all accounts exhausted)

```json
HTTP 429
{
  "type": "error",
  "error": {
    "type": "rate_limit_error",
    "message": "All accounts for project 'marketing-prod' have exceeded their token usage threshold. Earliest reset: 2h 15m (5-hour window)."
  }
}
```

### Logging

- `INFO` when switching: `"Account switch: project=X from=A to=B reason=threshold_exceeded 5h=82% 7d=45%"`
- `WARN` when all accounts exhausted
- `DEBUG` when cache hit/miss on usage fetch

### Out of Scope

- Reactive 429 handling from Claude API
- New dashboard UI pages
- Priority ordering of accounts
- Changes to client-facing API contract (transparent to clients)
- Bedrock account pooling (OAuth usage API is Anthropic-only)
