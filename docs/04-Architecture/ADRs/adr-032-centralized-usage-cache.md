# ADR-032: Centralized Usage Cache

## Status

Accepted

## Context

The account pool feature ([ADR-031](./adr-031-account-pool-auto-switching.md)) calls Anthropic's OAuth usage API to determine account utilization. Two independent consumers make these calls:

1. **AccountPoolService** — on every proxied request (had a 60-second in-memory cache)
2. **Dashboard API route** `/api/oauth-usage/:accountId` — on every Token Usage page load (no caching)

With multiple accounts and frequent requests, this hammers the Anthropic usage endpoint and triggers rate limits (HTTP 429), degrading both account switching and dashboard experience.

## Decision Drivers

- **API call reduction**: Minimize calls to Anthropic usage endpoint (~60x reduction target)
- **Rate limit resilience**: Graceful degradation when API is unavailable
- **Dashboard freshness**: Users need to know when data was last checked and whether it's estimated
- **Simplicity**: In-memory caching, no external dependencies

## Considered Options

1. **Increase per-consumer cache TTL**
   - Description: Keep separate caches, just increase TTL
   - Pros: Minimal code change
   - Cons: Two caches still make independent API calls; no deduplication

2. **Shared centralized cache (selected)**
   - Description: Single UsageCacheService shared by both consumers
   - Pros: Single source of truth, deduplication, background refresh, extrapolation
   - Cons: More code, new service to maintain

3. **External cache (Redis)**
   - Description: Use Redis for cross-process caching
   - Pros: Survives restarts, works across instances
   - Cons: New dependency, overkill for single-process deployment

## Decision

Extract usage fetching and caching into a single `UsageCacheService` singleton shared by both the account pool and dashboard API route.

### Key Design Decisions

- **5-minute cache TTL** with background refresh at 80% (4 minutes)
- **In-flight request deduplication**: `Map<string, Promise>` ensures at most 1 concurrent API call per credential
- **Rate-limit-aware extrapolation**: On API failure with previous data, estimate `lastValue + (elapsedMinutes / 10) * 2`, capped at 100
- **Force refresh with 30s cooldown**: Dashboard manual refresh bypasses cache but respects cooldown
- **Lazy evaluation in AccountPoolService**: Check sticky account first (1 cache lookup), only fetch all accounts when sticky exceeds threshold
- **Uses existing `AnthropicOAuthUsageResponse` type** from `packages/shared` to preserve all windows including `extra_usage`

### Implementation Details

**Architecture:**

```
AccountPoolService ──┐
                     ├──→ UsageCacheService ──→ Anthropic API
Dashboard API route ─┘         │
                          In-memory cache
                          (5 min TTL, background refresh)
```

**Cache entry shape:**

```typescript
interface CachedUsageEntry {
  usage: AnthropicOAuthUsageResponse | null
  fetchedAt: number
  isEstimated: boolean
  lastSuccessfulUsage?: AnthropicOAuthUsageResponse
}
```

**Fetch flow:**

```
getUsage(credential)
  ├─ Cache hit & age < 4 min (fresh) → return immediately
  ├─ Cache hit & age 4-5 min (stale) → return cached + background refresh
  └─ Cache miss or age > 5 min → blocking fetch (deduplicated)
       ├─ Success → cache with isEstimated=false
       └─ Failure + has lastSuccessfulUsage → extrapolate (isEstimated=true)
       └─ Failure + no previous data → return null (conservative)
```

**Extrapolation behavior during extended outage:** Values increase toward 100% cap. An account at 50% reaches the 80% default threshold after ~2.5 hours. Once the API recovers, the next successful fetch replaces extrapolated data. `extra_usage` (billing data) is never extrapolated.

**Dashboard changes:** The Token Usage page shows relative time ("3 minutes ago"), an "estimated" badge when rate-limited, and a manual refresh button per account.

### Constants

| Constant                       | Value           | Purpose                                   |
| ------------------------------ | --------------- | ----------------------------------------- |
| `USAGE_CACHE_TTL_MS`           | 300,000 (5 min) | Cache entry staleness threshold           |
| `BACKGROUND_REFRESH_THRESHOLD` | 0.8 (4 min)     | When to trigger async background refresh  |
| `EXTRAPOLATION_RATE_PER_10MIN` | 2               | Percentage increase per 10 minutes        |
| `EXTRAPOLATION_CAP`            | 100             | Maximum extrapolated utilization          |
| `FORCE_REFRESH_COOLDOWN_MS`    | 30,000 (30s)    | Minimum interval between manual refreshes |

### Files

| File                                                  | Description                                              |
| ----------------------------------------------------- | -------------------------------------------------------- |
| `services/proxy/src/services/usage-cache-service.ts`  | Centralized cache service                                |
| `services/proxy/src/services/account-pool-service.ts` | Delegates usage fetching to UsageCacheService            |
| `services/proxy/src/routes/api.ts`                    | Dashboard route reads from cache, supports `?force=true` |
| `services/proxy/src/container.ts`                     | Registers UsageCacheService singleton                    |
| `packages/shared/src/types/oauth-usage.ts`            | Added `is_estimated` to `OAuthUsageDisplay`              |
| `services/dashboard/src/routes/token-usage.ts`        | Relative time, estimated badge, refresh button           |
| `services/dashboard/src/services/api-client.ts`       | Passes `force` param                                     |

## Consequences

### Positive

- ~60x fewer API calls to Anthropic usage endpoint
- Graceful degradation via extrapolation instead of failure on rate limits
- Dashboard shows data freshness and estimation status
- No new external dependencies (pure in-memory)
- Background refresh keeps data fresh without blocking requests

### Negative

- Cache is lost on process restart (acceptable — rebuilds within 5 minutes)
- Extrapolated values may diverge from reality during long outages (mitigated by conservative cap at 100%)

### Risks and Mitigations

- **Risk**: Extrapolation underestimates actual usage, allowing requests to an exhausted account
  - **Mitigation**: +2%/10min rate is conservative; threshold provides headroom; recovers on next successful fetch
- **Risk**: 5-minute staleness allows brief over-threshold usage
  - **Mitigation**: Acceptable tradeoff vs. API rate limits; background refresh keeps it closer to real-time

## Links

- [ADR-031: Account Pool Auto-Switching](./adr-031-account-pool-auto-switching.md)

---

Date: 2026-03-12
Authors: AI Agent
