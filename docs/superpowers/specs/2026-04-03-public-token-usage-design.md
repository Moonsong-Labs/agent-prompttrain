# Public Token Usage Page — Design Spec

**Date**: 2026-04-03
**Status**: Approved

## Summary

A public (unauthenticated) page at `/public/token-usage` on the dashboard service showing Anthropic API rate limit utilization for all accounts. Shows only OAuth usage progress bars (5h and 7d windows) with time remaining and last-checked timestamps.

## Requirements

1. Public route on dashboard service — no authentication required
2. Per-account display: account name, 5-hour window bar + time left, 7-day window bar + time left
3. "Last checked" timestamp per account (from Anthropic API `fetched_at`)
4. Data sourced from Anthropic OAuth usage API (same as existing token usage dashboard)
5. No project breakdowns, no charts, no raw token counts, no account IDs

## Architecture

### Route

- **Path**: `/public/token-usage`
- **Service**: Dashboard (port 3001)
- **Auth**: None — route registered before auth middleware in `app.ts`

### Data Flow

1. Dashboard route handler creates/uses `ProxyApiClient` (server-side)
2. Fetches all accounts via `getAccountsTokenUsage()` to get account list and names
3. Fetches OAuth usage for each account via `getOAuthUsage(accountId)` in parallel
4. Renders server-side HTML with progress bars and timestamps
5. API key stays server-side — never exposed to the browser

### Files to Create/Modify

| File                                                  | Action | Purpose                                      |
| ----------------------------------------------------- | ------ | -------------------------------------------- |
| `services/dashboard/src/routes/public-token-usage.ts` | Create | Public page route and rendering              |
| `services/dashboard/src/app.ts`                       | Modify | Register public route before auth middleware |

### UI Design

- Standalone HTML page with inline styles (no shared layout/nav)
- Minimal title: "Token Usage Status"
- Per account: name row with 5h and 7d progress bars side by side
- Progress bar colors: green (<50%), orange (50-80%), red (>80%)
- Time left displayed next to each bar
- "Last checked: X minutes ago" below each account
- Estimated data indicator when API is rate-limited
- Responsive layout, clean typography

### Security Considerations

- No sensitive data exposed (only utilization percentages and reset times)
- No account IDs shown in HTML (only display names from credentials)
- API key used server-side only via `ProxyApiClient`
- No links to authenticated dashboard pages
