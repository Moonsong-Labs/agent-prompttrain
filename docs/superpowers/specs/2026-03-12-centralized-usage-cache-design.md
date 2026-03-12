# Centralized Usage Cache Service

**Date:** 2026-03-12
**Status:** Proposed
**Branch:** feat/account-pool-auto-switching

## Problem

The account pool feature calls Anthropic's OAuth usage API (`/api/oauth/usage`) to determine account utilization for auto-switching. Two independent consumers make these calls:

1. **AccountPoolService** - on every proxied request (60-second in-memory cache)
2. **Dashboard API route** `/api/oauth-usage/:accountId` - on every Token Usage page load (no caching)

With multiple accounts and frequent requests, this hammers the Anthropic usage endpoint and triggers rate limits (HTTP 429), which degrades both the account switching and dashboard experience.

## Solution

Extract usage fetching and caching into a single **UsageCacheService** shared by both consumers. Increase the cache TTL to 5 minutes with background refresh, and add rate-limit-aware extrapolation when the API is unavailable.

## Architecture

```
AccountPoolService ──┐
                     ├──→ UsageCacheService ──→ Anthropic API
Dashboard API route ─┘         │
                          In-memory cache
                          (5 min TTL, background refresh)
```

Both the account pool and the dashboard read from the same cache instance. Only one fetch per account per 5 minutes reaches Anthropic.

## Detailed Design

### 1. UsageCacheService

**New file:** `services/proxy/src/services/usage-cache-service.ts`

Singleton service that owns all Anthropic usage API interactions.

#### Raw API Data Type

The cache stores the full Anthropic response, including windows not currently in `OAuthUsageData`. To avoid losing data that the dashboard renders (e.g., `seven_day_oauth_apps`), the cache uses a broader raw type:

```typescript
/** Raw response from Anthropic's /api/oauth/usage endpoint */
type RawOAuthUsageData = {
  five_hour?: { utilization: number; resets_at: string } | null
  seven_day?: { utilization: number; resets_at: string } | null
  seven_day_oauth_apps?: { utilization: number; resets_at: string } | null
  seven_day_opus?: { utilization: number; resets_at: string } | null
  seven_day_sonnet?: { utilization: number; resets_at: string } | null
  iguana_necktie?: { utilization: number; resets_at: string } | null
  extra_usage?: {
    is_enabled: boolean
    monthly_limit: number | null
    used_credits: number | null
    utilization: number | null
  }
}
```

The `AccountPoolService` continues to use only `five_hour` and `seven_day` for threshold decisions. The dashboard uses all available windows for display.

#### Cache Entry Shape

```typescript
type CachedUsageEntry = {
  usage: RawOAuthUsageData | null // Null if never successfully fetched
  fetchedAt: number // Timestamp of last successful API fetch (0 if never fetched)
  isEstimated: boolean // True if value is extrapolated (API was rate-limited)
  lastSuccessfulUsage?: RawOAuthUsageData // Preserved base for extrapolation
}
```

#### Constants

| Constant                       | Value                    | Purpose                                                     |
| ------------------------------ | ------------------------ | ----------------------------------------------------------- |
| `USAGE_CACHE_TTL_MS`           | 300,000 (5 min)          | Time before a cache entry is considered stale               |
| `BACKGROUND_REFRESH_THRESHOLD` | 0.8 (80% of TTL = 4 min) | When to trigger async background refresh                    |
| `EXTRAPOLATION_RATE`           | 2% per 10 min            | Rate of estimated utilization increase on API failure       |
| `EXTRAPOLATION_CAP`            | 100                      | Maximum extrapolated utilization value                      |
| `FORCE_REFRESH_COOLDOWN_MS`    | 30,000 (30s)             | Minimum interval between manual force-refreshes per account |

#### Public API

```typescript
class UsageCacheService {
  /** Get usage for a single account. Returns cached, fresh, or extrapolated data. */
  getUsage(credential: AnthropicCredential): Promise<CachedUsageEntry | null>

  /** Get usage for multiple accounts in parallel. Key is credential.id */
  getUsageMultiple(credentials: AnthropicCredential[]): Promise<Map<string, CachedUsageEntry>>

  /** Force-refresh a single account (for dashboard manual refresh). Rate-limited to once per 30s per account. */
  forceRefresh(credential: AnthropicCredential): Promise<CachedUsageEntry | null>

  /** Clear all cached data (for testing). */
  clearCache(): void
}
```

#### Fetch Flow

```
getUsage(credential)
  ├─ Cache hit & age < 4 min (fresh)?
  │    → return cached immediately
  ├─ Cache hit & age 4-5 min (stale, pre-expiry)?
  │    → return cached AND trigger background refresh (non-blocking, deduplicated)
  └─ Cache miss OR age > 5 min (expired)?
       → fetch from Anthropic API (blocking, deduplicated)
            ├─ Success → cache result with isEstimated=false, return
            └─ Rate limited (429) or error?
                 ├─ Has lastSuccessfulUsage?
                 │    → extrapolate and return with isEstimated=true
                 └─ No previous data?
                      → return null (account treated conservatively)
```

#### Background Refresh Deduplication

To prevent concurrent requests from triggering duplicate API calls, the service maintains a `Map<string, Promise>` of in-flight fetches per credential ID. When a background refresh is triggered:

1. Check if a fetch is already in-flight for this credential
2. If yes, skip (the existing fetch will update the cache)
3. If no, start the fetch and store its promise in the in-flight map
4. On completion (success or failure), remove from the in-flight map

This ensures at most one concurrent API call per credential, regardless of request volume.

#### Extrapolation Logic

When the Anthropic API returns a rate limit error (429) or other fetch failure:

1. Look up `lastSuccessfulUsage` and `fetchedAt` from the cache entry
2. Calculate `elapsedMinutes = (now - fetchedAt) / 60000`
3. For each **non-null** utilization window in `lastSuccessfulUsage`: `estimated = lastValue + (elapsedMinutes / 10) * 2`
4. Windows that were null in the last successful response remain null (no extrapolation from zero)
5. Cap each extrapolated window at 100
6. Store as a new cache entry with `isEstimated: true`
7. Preserve `lastSuccessfulUsage` and original `fetchedAt` so future extrapolations always use the real base

**Extended outage behavior:** During prolonged API unavailability, extrapolation will eventually push all accounts to 100% utilization (cap). This is intentional -- the system conservatively treats accounts as fully utilized rather than making optimistic assumptions. For example, an account at 50% would reach the 80% default threshold after ~2.5 hours of outage, and hit 100% after ~4 hours. Once the API recovers, the next successful fetch replaces the extrapolated data.

**`extra_usage` is not extrapolated** -- it represents billing data, not rate windows. It is preserved as-is from `lastSuccessfulUsage` during extrapolation.

#### Instantiation and Wiring

`UsageCacheService` is instantiated once in `AuthenticationService` (which already creates `AccountPoolService`) and passed to both:

- `AccountPoolService` via constructor injection
- The proxy API route via the container (registered as a singleton so the dashboard route can access it)

This mirrors the existing pattern where `AuthenticationService` owns service creation and the container provides shared access.

### 2. AccountPoolService Changes

**Modified file:** `services/proxy/src/services/account-pool-service.ts`

- Remove the internal `usageCache` map and `fetchUsage()` method
- Accept `UsageCacheService` as a constructor dependency
- Delegate all usage fetching to `UsageCacheService.getUsage()` / `getUsageMultiple()`
- Add lazy evaluation: check sticky account first, only fetch all accounts when sticky exceeds threshold

#### Lazy Evaluation Flow

```
selectAccount(projectId)
  ├─ Has sticky account?
  │    ├─ Fetch sticky usage only (single cache lookup)
  │    ├─ Under threshold? → return sticky (fast path)
  │    └─ Over threshold? → fetch ALL accounts → pick lowest
  └─ No sticky?
       → fetch ALL accounts → pick lowest → set sticky
```

This reduces the common case from N API calls (all accounts) to 1 cache lookup (sticky only).

### 3. Dashboard API Route Changes

**Modified file:** `services/proxy/src/routes/api.ts` (route `/api/oauth-usage/:accountId`)

- Remove the direct `fetch('https://api.anthropic.com/api/oauth/usage')` call
- Read from `UsageCacheService` instead
- Include `fetched_at` and `is_estimated` in the response payload
- Add optional `?force=true` query parameter to trigger `forceRefresh()`

#### Updated Response Shape

```json
{
  "success": true,
  "data": {
    "account_id": "acc_123",
    "provider": "anthropic",
    "available": true,
    "windows": [
      {
        "name": "5-Hour Window",
        "short_name": "5h",
        "utilization": 67,
        "resets_at": "2h 15m",
        "resets_at_iso": "2026-03-12T18:00:00Z"
      }
    ],
    "fetched_at": "2026-03-12T15:45:00Z",
    "is_estimated": false
  }
}
```

When `is_estimated` is true, the dashboard displays the value differently (see section 4).

### 4. Dashboard Token Usage Page Changes

**Modified file:** `services/dashboard/src/routes/token-usage.ts`

Display the cache freshness and estimation status:

- **Normal:** "82% | Last checked: 2 minutes ago"
- **Estimated:** "~67% (estimated) | Last checked: 15 minutes ago (API rate limited)"
- **Manual refresh:** Add a refresh button/link per account that calls the API with `?force=true`

The `fetched_at` field is already partially rendered at line 532 of the current code. This change extends it to also show:

- Relative time ("3 minutes ago") instead of absolute time
- An "(estimated)" badge when `is_estimated` is true

## Files Changed

| File                                                                 | Change                                                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `services/proxy/src/services/usage-cache-service.ts`                 | **New** - Centralized cache service                                                            |
| `services/proxy/src/services/account-pool-service.ts`                | Remove internal cache, delegate to UsageCacheService, add lazy eval, adapt `findEarliestReset` |
| `services/proxy/src/routes/api.ts`                                   | `/api/oauth-usage/:accountId` reads from cache, adds `?force=true` support                     |
| `packages/shared/src/types/credentials.ts`                           | Add `RawOAuthUsageData` type, add `is_estimated` and `fetched_at` to `OAuthUsageDisplay`       |
| `services/dashboard/src/routes/token-usage.ts`                       | Display relative `fetched_at` time, estimated badge, refresh button                            |
| `services/proxy/src/services/__tests__/usage-cache-service.test.ts`  | **New** - Unit tests for cache, TTL, background refresh, extrapolation, deduplication          |
| `services/proxy/src/services/__tests__/account-pool-service.test.ts` | Update to mock UsageCacheService instead of fetch                                              |

## Impact

- **API call reduction:** ~60x fewer calls to Anthropic usage endpoint (from every 60s per account to every 5 min, with most served from cache)
- **Rate limit resilience:** Graceful degradation via extrapolation instead of failure
- **Dashboard accuracy:** Users see when data was last checked and whether it's estimated
- **No new dependencies:** Pure in-memory caching, no external cache needed

## Out of Scope

- Persistent cache across process restarts (in-memory is sufficient for this use case)
- Dashboard auto-refresh via WebSocket/SSE (existing polling pattern is adequate)
- Configurable TTL via environment variables (can be added later if needed)
