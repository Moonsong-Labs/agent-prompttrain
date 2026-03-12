# Centralized Usage Cache Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Anthropic usage API calls by ~60x via a shared in-memory cache with 5-min TTL, background refresh, deduplication, and rate-limit-aware extrapolation.

**Architecture:** Extract fetch+cache logic from `AccountPoolService` into a new `UsageCacheService` singleton. Both the account pool (proxy requests) and dashboard API route share this cache. On API rate-limit errors, extrapolate from the last known value (+2%/10min). Dashboard displays cache freshness and estimation status.

**Tech Stack:** TypeScript, Bun runtime, Hono framework, bun:test

**Spec:** `docs/superpowers/specs/2026-03-12-centralized-usage-cache-design.md`

---

## Chunk 1: Shared Types and UsageCacheService

### Task 1: Add `is_estimated` to OAuthUsageDisplay

**Files:**

- Modify: `packages/shared/src/types/oauth-usage.ts:50-61`

**Note:** The cache will use the existing `AnthropicOAuthUsageResponse` type (already defined in `packages/shared/src/types/oauth-usage.ts:30-45`) instead of creating a duplicate `AnthropicOAuthUsageResponse` type.

- [ ] **Step 1: Add optional `is_estimated` field to `OAuthUsageDisplay`**

In `packages/shared/src/types/oauth-usage.ts`, add to the `OAuthUsageDisplay` interface (after `fetched_at` on line 60):

```typescript
  /** Whether this data is extrapolated due to API rate limiting */
  is_estimated?: boolean
```

Note: This is optional (`?`) so existing code that constructs `OAuthUsageDisplay` without `is_estimated` continues to typecheck. The dashboard treats `undefined` as `false`.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (optional field is additive, no breaking changes)

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types/oauth-usage.ts
git commit -m "feat(shared): add optional is_estimated to OAuthUsageDisplay"
```

---

### Task 2: Create UsageCacheService with tests (core cache + fetch)

**Files:**

- Create: `services/proxy/src/services/usage-cache-service.ts`
- Create: `services/proxy/src/services/__tests__/usage-cache-service.test.ts`

- [ ] **Step 1: Write the test file with tests for cache miss, cache hit, and TTL expiry**

Create `services/proxy/src/services/__tests__/usage-cache-service.test.ts`:

```typescript
import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test'
import type { AnthropicCredential, AnthropicOAuthUsageResponse } from '@agent-prompttrain/shared'

// ── Mock functions ──────────────────────────────────────────────────────────

const mockGetApiKey = mock<(credId: string, pool: any) => Promise<string | null>>(
  (credId: string) => Promise.resolve(`token-${credId}`)
)

mock.module('../../credentials', () => ({
  getApiKey: mockGetApiKey,
}))

mock.module('../../middleware/logger', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  },
}))

import { UsageCacheService } from '../usage-cache-service'

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCredential(overrides: Partial<AnthropicCredential> = {}): AnthropicCredential {
  return {
    id: 'cred-1',
    account_id: 'acct-1',
    account_name: 'Test Account',
    provider: 'anthropic',
    token_limit_threshold: 0.8,
    oauth_access_token: 'access-token',
    oauth_refresh_token: 'refresh-token',
    oauth_expires_at: new Date(Date.now() + 3600_000),
    oauth_scopes: ['default'],
    oauth_is_max: false,
    last_refresh_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

function makeRawUsage(fiveHour = 50, sevenDay = 30): AnthropicOAuthUsageResponse {
  return {
    five_hour: { utilization: fiveHour, resets_at: '2026-03-12T18:00:00Z' },
    seven_day: { utilization: sevenDay, resets_at: '2026-03-15T00:00:00Z' },
    seven_day_opus: null,
    seven_day_sonnet: null,
  }
}

function mockFetchSuccess(usage: AnthropicOAuthUsageResponse = makeRawUsage()) {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify(usage), { status: 200 }))
  ) as unknown as typeof globalThis.fetch
}

function mockFetchRateLimit() {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response('Rate limited', { status: 429 }))
  ) as unknown as typeof globalThis.fetch
}

function mockFetchError() {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response('Internal Server Error', { status: 500 }))
  ) as unknown as typeof globalThis.fetch
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('UsageCacheService', () => {
  let service: UsageCacheService
  const fakePool = null as any

  beforeEach(() => {
    service = new UsageCacheService(fakePool)
    mockGetApiKey.mockReset()
    mockGetApiKey.mockImplementation((credId: string) => Promise.resolve(`token-${credId}`))
  })

  describe('getUsage - cache miss', () => {
    test('fetches from Anthropic API on first call', async () => {
      const usage = makeRawUsage(60, 40)
      mockFetchSuccess(usage)
      const cred = makeCredential()

      const result = await service.getUsage(cred)

      expect(result).not.toBeNull()
      expect(result!.usage).not.toBeNull()
      expect(result!.usage!.five_hour!.utilization).toBe(60)
      expect(result!.usage!.seven_day!.utilization).toBe(40)
      expect(result!.isEstimated).toBe(false)
      expect(result!.fetchedAt).toBeGreaterThan(0)
      expect((globalThis.fetch as any).mock.calls.length).toBe(1)
    })
  })

  describe('getUsage - cache hit (fresh)', () => {
    test('returns cached data without API call on second request', async () => {
      mockFetchSuccess(makeRawUsage(60, 40))
      const cred = makeCredential()

      await service.getUsage(cred)
      const callsAfterFirst = (globalThis.fetch as any).mock.calls.length

      const result = await service.getUsage(cred)
      const callsAfterSecond = (globalThis.fetch as any).mock.calls.length

      expect(result).not.toBeNull()
      expect(callsAfterSecond).toBe(callsAfterFirst) // No new fetch
    })
  })

  describe('getUsage - API failure returns null when no previous data', () => {
    test('returns null on first fetch failure', async () => {
      mockFetchError()
      const cred = makeCredential()

      const result = await service.getUsage(cred)

      expect(result).toBeNull()
    })
  })

  describe('clearCache', () => {
    test('forces re-fetch after clearing', async () => {
      mockFetchSuccess(makeRawUsage(60, 40))
      const cred = makeCredential()

      await service.getUsage(cred)
      const callsAfterFirst = (globalThis.fetch as any).mock.calls.length

      service.clearCache()

      await service.getUsage(cred)
      const callsAfterClear = (globalThis.fetch as any).mock.calls.length

      expect(callsAfterClear).toBeGreaterThan(callsAfterFirst)
    })
  })

  describe('getUsageMultiple', () => {
    test('returns map keyed by credential.id', async () => {
      const cred1 = makeCredential({ id: 'cred-1' })
      const cred2 = makeCredential({ id: 'cred-2' })
      mockFetchSuccess(makeRawUsage(50, 30))

      const results = await service.getUsageMultiple([cred1, cred2])

      expect(results.size).toBe(2)
      expect(results.has('cred-1')).toBe(true)
      expect(results.has('cred-2')).toBe(true)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test services/proxy/src/services/__tests__/usage-cache-service.test.ts`
Expected: FAIL (module `../usage-cache-service` not found)

- [ ] **Step 3: Write the UsageCacheService implementation**

Create `services/proxy/src/services/usage-cache-service.ts`:

```typescript
import { Pool } from 'pg'
import type { AnthropicCredential, AnthropicOAuthUsageResponse } from '@agent-prompttrain/shared'
import { getApiKey } from '../credentials'
import { logger } from '../middleware/logger'

export interface CachedUsageEntry {
  usage: AnthropicOAuthUsageResponse | null
  fetchedAt: number
  isEstimated: boolean
  lastSuccessfulUsage?: AnthropicOAuthUsageResponse
}

/** Window keys used for utilization display (excludes extra_usage) */
type UsageWindowKey = Exclude<keyof AnthropicOAuthUsageResponse, 'extra_usage'>

/** 5 minutes */
const USAGE_CACHE_TTL_MS = 300_000

/** Trigger background refresh at 80% of TTL (4 minutes) */
const BACKGROUND_REFRESH_THRESHOLD = 0.8

/** Extrapolation: +2% per 10 minutes */
const EXTRAPOLATION_RATE_PER_10MIN = 2

/** Max extrapolated utilization */
const EXTRAPOLATION_CAP = 100

/** Minimum interval between force-refreshes per account */
const FORCE_REFRESH_COOLDOWN_MS = 30_000

const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

/**
 * Centralized cache for Anthropic OAuth usage data.
 * Shared by AccountPoolService (proxy requests) and dashboard API route.
 *
 * Features:
 * - 5-minute TTL with background refresh at 4 minutes
 * - In-flight request deduplication (at most 1 API call per credential)
 * - Rate-limit-aware extrapolation (+2%/10min from last known value)
 * - Force-refresh with 30s cooldown for dashboard manual refresh
 */
export class UsageCacheService {
  private cache: Map<string, CachedUsageEntry> = new Map()
  private inFlight: Map<string, Promise<CachedUsageEntry | null>> = new Map()
  private lastForceRefresh: Map<string, number> = new Map()

  constructor(private readonly pool: Pool) {}

  /**
   * Get usage for a single account. Returns cached, fresh, or extrapolated data.
   */
  async getUsage(credential: AnthropicCredential): Promise<CachedUsageEntry | null> {
    const cached = this.cache.get(credential.id)
    const now = Date.now()

    if (cached && cached.fetchedAt > 0) {
      const age = now - cached.fetchedAt
      const backgroundThreshold = USAGE_CACHE_TTL_MS * BACKGROUND_REFRESH_THRESHOLD

      // Fresh: return immediately
      if (age < backgroundThreshold) {
        return cached
      }

      // Stale but not expired: return cached + trigger background refresh
      if (age < USAGE_CACHE_TTL_MS) {
        this.triggerBackgroundRefresh(credential)
        return cached
      }
    }

    // Cache miss or expired: blocking fetch
    return this.fetchWithDeduplication(credential)
  }

  /**
   * Get usage for multiple accounts in parallel. Key is credential.id.
   */
  async getUsageMultiple(
    credentials: AnthropicCredential[]
  ): Promise<Map<string, CachedUsageEntry>> {
    const results = new Map<string, CachedUsageEntry>()
    const entries = await Promise.all(
      credentials.map(async cred => {
        const entry = await this.getUsage(cred)
        return { id: cred.id, entry }
      })
    )
    for (const { id, entry } of entries) {
      if (entry) {
        results.set(id, entry)
      }
    }
    return results
  }

  /**
   * Force-refresh a single account (for dashboard manual refresh).
   * Rate-limited to once per 30s per account.
   */
  async forceRefresh(credential: AnthropicCredential): Promise<CachedUsageEntry | null> {
    const now = Date.now()
    const lastRefresh = this.lastForceRefresh.get(credential.id) ?? 0

    if (now - lastRefresh < FORCE_REFRESH_COOLDOWN_MS) {
      // Return current cached value if within cooldown
      return this.cache.get(credential.id) ?? null
    }

    this.lastForceRefresh.set(credential.id, now)
    // Expire the cache entry to force a fresh fetch, but preserve
    // lastSuccessfulUsage so extrapolation works if the fetch fails
    const existing = this.cache.get(credential.id)
    if (existing) {
      existing.fetchedAt = 0 // Mark as expired
    }
    return this.fetchWithDeduplication(credential)
  }

  /**
   * Clear all cached data. Useful for testing.
   */
  clearCache(): void {
    this.cache.clear()
    this.inFlight.clear()
    this.lastForceRefresh.clear()
  }

  /**
   * Trigger a non-blocking background refresh for a credential.
   * Deduplicated: skips if a fetch is already in-flight.
   */
  private triggerBackgroundRefresh(credential: AnthropicCredential): void {
    if (this.inFlight.has(credential.id)) {
      return // Already refreshing
    }

    // Fire and forget - don't await
    this.fetchWithDeduplication(credential).catch(() => {
      // Errors handled inside fetchWithDeduplication
    })
  }

  /**
   * Fetch usage from Anthropic API with in-flight deduplication.
   * At most one concurrent API call per credential.
   */
  private async fetchWithDeduplication(
    credential: AnthropicCredential
  ): Promise<CachedUsageEntry | null> {
    const existing = this.inFlight.get(credential.id)
    if (existing) {
      return existing
    }

    const promise = this.doFetch(credential)
    this.inFlight.set(credential.id, promise)

    try {
      return await promise
    } finally {
      this.inFlight.delete(credential.id)
    }
  }

  /**
   * Perform the actual API fetch and update the cache.
   */
  private async doFetch(credential: AnthropicCredential): Promise<CachedUsageEntry | null> {
    try {
      const token = await getApiKey(credential.id, this.pool)
      if (!token) {
        logger.warn('Failed to get OAuth token for usage fetch', {
          metadata: { accountId: credential.account_id, credentialId: credential.id },
        })
        return this.handleFetchFailure(credential.id)
      }

      const response = await fetch(ANTHROPIC_USAGE_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'anthropic-beta': OAUTH_BETA_HEADER,
        },
      })

      if (!response.ok) {
        const errorText = await response.text()
        logger.warn('Failed to fetch OAuth usage from Anthropic', {
          metadata: {
            accountId: credential.account_id,
            credentialId: credential.id,
            status: response.status,
            error: errorText,
          },
        })
        return this.handleFetchFailure(credential.id)
      }

      const rawData = (await response.json()) as AnthropicOAuthUsageResponse
      const now = Date.now()

      const entry: CachedUsageEntry = {
        usage: rawData,
        fetchedAt: now,
        isEstimated: false,
        lastSuccessfulUsage: rawData,
      }

      this.cache.set(credential.id, entry)
      return entry
    } catch (error) {
      logger.warn('Error fetching OAuth usage', {
        metadata: {
          accountId: credential.account_id,
          credentialId: credential.id,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      return this.handleFetchFailure(credential.id)
    }
  }

  /**
   * Handle a fetch failure. If we have previous successful data,
   * extrapolate; otherwise return null.
   */
  private handleFetchFailure(credentialId: string): CachedUsageEntry | null {
    const cached = this.cache.get(credentialId)

    if (cached?.lastSuccessfulUsage && cached.fetchedAt > 0) {
      return this.extrapolate(credentialId, cached)
    }

    return null
  }

  /**
   * Extrapolate usage from last known values.
   * Formula: estimated = lastValue + (elapsedMinutes / 10) * 2
   * Only non-null windows are extrapolated. Capped at 100.
   */
  private extrapolate(credentialId: string, cached: CachedUsageEntry): CachedUsageEntry {
    const base = cached.lastSuccessfulUsage!
    const elapsedMinutes = (Date.now() - cached.fetchedAt) / 60_000
    const increase = (elapsedMinutes / 10) * EXTRAPOLATION_RATE_PER_10MIN

    const extrapolateWindow = (
      window: { utilization: number; resets_at: string } | null | undefined
    ) => {
      if (!window) return window
      return {
        utilization: Math.min(EXTRAPOLATION_CAP, window.utilization + increase),
        resets_at: window.resets_at,
      }
    }

    const extrapolated: AnthropicOAuthUsageResponse = {
      five_hour: extrapolateWindow(base.five_hour) ?? null,
      seven_day: extrapolateWindow(base.seven_day) ?? null,
      seven_day_oauth_apps: extrapolateWindow(base.seven_day_oauth_apps),
      seven_day_opus: extrapolateWindow(base.seven_day_opus),
      seven_day_sonnet: extrapolateWindow(base.seven_day_sonnet),
      iguana_necktie: extrapolateWindow(base.iguana_necktie),
      // extra_usage is billing data, not extrapolated
      extra_usage: base.extra_usage,
    }

    const entry: CachedUsageEntry = {
      usage: extrapolated,
      fetchedAt: cached.fetchedAt, // Preserve original fetch time
      isEstimated: true,
      lastSuccessfulUsage: cached.lastSuccessfulUsage,
    }

    this.cache.set(credentialId, entry)
    return entry
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test services/proxy/src/services/__tests__/usage-cache-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/proxy/src/services/usage-cache-service.ts services/proxy/src/services/__tests__/usage-cache-service.test.ts packages/shared/src/types/
git commit -m "feat(proxy): add UsageCacheService with 5-min TTL, deduplication, and extrapolation"
```

---

### Task 3: Add extrapolation and deduplication tests

**Files:**

- Modify: `services/proxy/src/services/__tests__/usage-cache-service.test.ts`

- [ ] **Step 1: Add extrapolation tests**

Append these test suites to the existing `describe('UsageCacheService')` block:

```typescript
describe('extrapolation on API failure', () => {
  test('extrapolates from last known value when API returns 429', async () => {
    const cred = makeCredential()

    // First call succeeds
    mockFetchSuccess(makeRawUsage(50, 30))
    const first = await service.getUsage(cred)
    expect(first!.isEstimated).toBe(false)
    const originalFetchedAt = first!.fetchedAt

    // Expire the cache by clearing and setting up a stale entry
    service.clearCache()

    // Re-seed with a stale entry that has lastSuccessfulUsage
    // We simulate this by doing a successful fetch, then expiring + failing
    mockFetchSuccess(makeRawUsage(50, 30))
    await service.getUsage(cred)

    // Now make the API return 429
    mockFetchRateLimit()

    // Clear cache to force re-fetch (which will fail and extrapolate)
    service.clearCache()
    // But we need lastSuccessfulUsage... let's test via a different approach:
    // Directly test handleFetchFailure by having a successful fetch then a failure

    // Reset: fresh service
    service = new UsageCacheService(null as any)
    mockGetApiKey.mockImplementation((credId: string) => Promise.resolve(`token-${credId}`))

    // Successful fetch first
    mockFetchSuccess(makeRawUsage(50, 30))
    await service.getUsage(cred)

    // Now expire and fail: we manipulate by clearing and re-calling with failure
    // The service caches lastSuccessfulUsage, so on failure it extrapolates
    // We need to wait for cache to expire... use internal manipulation
    const cache = (service as any).cache as Map<string, any>
    const entry = cache.get(cred.id)!
    entry.fetchedAt = Date.now() - 600_000 // 10 minutes ago

    mockFetchRateLimit()
    const result = await service.getUsage(cred)

    expect(result).not.toBeNull()
    expect(result!.isEstimated).toBe(true)
    // 50 + (10 min / 10) * 2 = 52
    expect(result!.usage!.five_hour!.utilization).toBe(52)
    // 30 + (10 min / 10) * 2 = 32
    expect(result!.usage!.seven_day!.utilization).toBe(32)
  })

  test('caps extrapolated values at 100', async () => {
    const cred = makeCredential()

    mockFetchSuccess(makeRawUsage(95, 90))
    await service.getUsage(cred)

    // Make entry very stale
    const cache = (service as any).cache as Map<string, any>
    const entry = cache.get(cred.id)!
    entry.fetchedAt = Date.now() - 3_600_000 // 1 hour ago

    mockFetchRateLimit()
    const result = await service.getUsage(cred)

    expect(result!.isEstimated).toBe(true)
    expect(result!.usage!.five_hour!.utilization).toBe(100) // Capped
    expect(result!.usage!.seven_day!.utilization).toBe(100) // Capped
  })

  test('preserves null windows during extrapolation', async () => {
    const cred = makeCredential()
    const usageWithNulls: AnthropicOAuthUsageResponse = {
      five_hour: { utilization: 50, resets_at: '2026-03-12T18:00:00Z' },
      seven_day: null,
      seven_day_opus: null,
      seven_day_sonnet: null,
    }

    mockFetchSuccess(usageWithNulls)
    await service.getUsage(cred)

    const cache = (service as any).cache as Map<string, any>
    cache.get(cred.id)!.fetchedAt = Date.now() - 600_000

    mockFetchRateLimit()
    const result = await service.getUsage(cred)

    expect(result!.isEstimated).toBe(true)
    expect(result!.usage!.five_hour!.utilization).toBe(52) // Extrapolated
    expect(result!.usage!.seven_day).toBeNull() // Stays null
  })

  test('does not extrapolate extra_usage', async () => {
    const cred = makeCredential()
    const usageWithExtra: AnthropicOAuthUsageResponse = {
      five_hour: { utilization: 50, resets_at: '2026-03-12T18:00:00Z' },
      seven_day: null,
      extra_usage: {
        is_enabled: true,
        monthly_limit: 100,
        used_credits: 50,
        utilization: 50,
      },
    }

    mockFetchSuccess(usageWithExtra)
    await service.getUsage(cred)

    const cache = (service as any).cache as Map<string, any>
    cache.get(cred.id)!.fetchedAt = Date.now() - 600_000

    mockFetchRateLimit()
    const result = await service.getUsage(cred)

    expect(result!.usage!.extra_usage!.utilization).toBe(50) // Unchanged
  })
})

describe('background refresh (stale but not expired)', () => {
  test('returns cached data and triggers background fetch when age is 4-5 min', async () => {
    const cred = makeCredential()
    mockFetchSuccess(makeRawUsage(50, 30))
    await service.getUsage(cred)

    // Age the entry to 4.5 minutes (between background threshold and TTL)
    const cache = (service as any).cache as Map<string, any>
    cache.get(cred.id)!.fetchedAt = Date.now() - 270_000 // 4.5 min

    // Mock a new fetch that returns updated data
    mockFetchSuccess(makeRawUsage(65, 45))
    const result = await service.getUsage(cred)

    // Should return the OLD cached value immediately
    expect(result!.usage!.five_hour!.utilization).toBe(50)

    // But a background fetch was triggered - wait a tick for it to complete
    await new Promise(resolve => setTimeout(resolve, 10))

    // Now the cache should have the NEW data
    const fresh = await service.getUsage(cred)
    expect(fresh!.usage!.five_hour!.utilization).toBe(65)
  })
})

describe('TTL expiry (blocking re-fetch)', () => {
  test('performs blocking fetch when cache entry is older than 5 min', async () => {
    const cred = makeCredential()
    mockFetchSuccess(makeRawUsage(50, 30))
    await service.getUsage(cred)

    // Age the entry past TTL
    const cache = (service as any).cache as Map<string, any>
    cache.get(cred.id)!.fetchedAt = Date.now() - 400_000 // 6.7 min

    mockFetchSuccess(makeRawUsage(75, 55))
    const result = await service.getUsage(cred)

    // Should return the NEW data (blocking fetch)
    expect(result!.usage!.five_hour!.utilization).toBe(75)
  })
})

describe('getApiKey returns null', () => {
  test('returns null when OAuth token cannot be obtained', async () => {
    const cred = makeCredential()
    mockGetApiKey.mockImplementation(() => Promise.resolve(null))

    const result = await service.getUsage(cred)
    expect(result).toBeNull()
  })
})

describe('deduplication', () => {
  test('concurrent getUsage calls result in only one fetch', async () => {
    const cred = makeCredential()
    mockFetchSuccess(makeRawUsage(50, 30))

    // Fire 5 concurrent requests
    const results = await Promise.all([
      service.getUsage(cred),
      service.getUsage(cred),
      service.getUsage(cred),
      service.getUsage(cred),
      service.getUsage(cred),
    ])

    // All should return valid data
    for (const r of results) {
      expect(r).not.toBeNull()
      expect(r!.usage!.five_hour!.utilization).toBe(50)
    }

    // Only 1 actual fetch call
    expect((globalThis.fetch as any).mock.calls.length).toBe(1)
  })
})

describe('forceRefresh', () => {
  test('bypasses cache and fetches fresh data', async () => {
    const cred = makeCredential()
    mockFetchSuccess(makeRawUsage(50, 30))
    await service.getUsage(cred)

    mockFetchSuccess(makeRawUsage(70, 60))
    const result = await service.forceRefresh(cred)

    expect(result!.usage!.five_hour!.utilization).toBe(70)
  })

  test('returns cached data when within cooldown period', async () => {
    const cred = makeCredential()
    mockFetchSuccess(makeRawUsage(50, 30))
    await service.getUsage(cred)

    // First force refresh
    mockFetchSuccess(makeRawUsage(70, 60))
    await service.forceRefresh(cred)

    // Second force refresh within 30s - should return cached
    mockFetchSuccess(makeRawUsage(90, 80))
    const result = await service.forceRefresh(cred)

    expect(result!.usage!.five_hour!.utilization).toBe(70) // Not 90
  })
})
```

- [ ] **Step 2: Run all usage cache service tests**

Run: `bun test services/proxy/src/services/__tests__/usage-cache-service.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add services/proxy/src/services/__tests__/usage-cache-service.test.ts
git commit -m "test(proxy): add extrapolation, deduplication, and force-refresh tests for UsageCacheService"
```

---

## Chunk 2: Wire UsageCacheService into AccountPoolService and Container

### Task 4: Refactor AccountPoolService to use UsageCacheService

**Files:**

- Modify: `services/proxy/src/services/account-pool-service.ts`
- Modify: `services/proxy/src/services/__tests__/account-pool-service.test.ts`

- [ ] **Step 1: Update AccountPoolService to accept UsageCacheService**

In `services/proxy/src/services/account-pool-service.ts`:

1. Remove the `UsageCacheEntry` interface (lines 36-39)
2. Remove `USAGE_CACHE_TTL_MS` constant (line 41)
3. Remove `private usageCache: Map<string, UsageCacheEntry>` (line 57)
4. Add `UsageCacheService` import and constructor parameter:

```typescript
import { UsageCacheService, type CachedUsageEntry } from './usage-cache-service'
```

Update constructor:

```typescript
constructor(
  private readonly pool: Pool,
  private readonly usageCacheService: UsageCacheService
) {}
```

5. Replace `fetchUsage` calls with `usageCacheService.getUsage()`:

In `selectAccount`, the sticky check (lines 97-98) becomes:

```typescript
const cachedEntry = await this.usageCacheService.getUsage(stickyCredential)
const maxUtilization = this.computeMaxUtilization(cachedEntry?.usage ?? null)
```

The parallel fetch-all (lines 128-134) becomes:

```typescript
const usageMap = await this.usageCacheService.getUsageMultiple(anthropicCredentials)
const usageResults = anthropicCredentials.map(credential => {
  const entry = usageMap.get(credential.id)
  const maxUtilization = this.computeMaxUtilization(entry?.usage ?? null)
  return { credential, maxUtilization }
})
```

6. Update `computeMaxUtilization` to accept `AnthropicOAuthUsageResponse | null`:

```typescript
import type { AnthropicOAuthUsageResponse } from '@agent-prompttrain/shared'

private computeMaxUtilization(usage: AnthropicOAuthUsageResponse | null): number {
  if (!usage) return 1
  const fiveHour = (usage.five_hour?.utilization ?? 0) / 100
  const sevenDay = (usage.seven_day?.utilization ?? 0) / 100
  return Math.max(fiveHour, sevenDay)
}
```

7. Update `findEarliestReset` to read from `usageCacheService` cache entries passed as parameter instead of internal `usageCache`:

The method currently accesses `this.usageCache.get(credential.id)`. Since we're passing usage results through `getUsageMultiple`, change the method to accept the usage map:

```typescript
private findEarliestReset(
  credentials: AnthropicCredential[],
  usageMap: Map<string, CachedUsageEntry>
): string | null {
  let earliest: string | null = null
  for (const credential of credentials) {
    const cached = usageMap.get(credential.id)
    if (!cached?.usage) continue
    const resetTimes = [
      cached.usage.five_hour?.resets_at,
      cached.usage.seven_day?.resets_at,
    ].filter((t): t is string => t !== null && t !== undefined)
    for (const resetTime of resetTimes) {
      if (!earliest || resetTime < earliest) {
        earliest = resetTime
      }
    }
  }
  return earliest
}
```

Update the call site to pass `usageMap`:

```typescript
const usageMap = await this.usageCacheService.getUsageMultiple(anthropicCredentials)
// ... filter available ...
const estimatedReset = this.findEarliestReset(anthropicCredentials, usageMap)
```

8. Remove `fetchUsage`, `cacheFailure`, and `clearUsageCache` methods entirely.

- [ ] **Step 2: Update AccountPoolService tests**

In `services/proxy/src/services/__tests__/account-pool-service.test.ts`:

1. Add a mock for `UsageCacheService`:

```typescript
import { UsageCacheService, type CachedUsageEntry } from '../usage-cache-service'

// Create a mock UsageCacheService
function createMockUsageCacheService(): UsageCacheService {
  const service = new UsageCacheService(null as any)
  return service
}
```

2. Update `beforeEach` to pass `UsageCacheService` to `AccountPoolService`:

```typescript
let usageCacheService: UsageCacheService

beforeEach(() => {
  usageCacheService = createMockUsageCacheService()
  service = new AccountPoolService(fakePool, usageCacheService)
  // ... rest of resets
})
```

3. Replace `mockFetchWithUsage` with setting up the `UsageCacheService`'s mock fetch. Since `UsageCacheService` itself calls `fetch`, the existing `globalThis.fetch` mocks still work -- the test setup just needs to pass the service through.

4. Replace `service.clearUsageCache()` calls with `usageCacheService.clearCache()`.

5. Remove the `mockFetchFailure` helper since API failures now go through `UsageCacheService` (the mock fetch still works for this).

- [ ] **Step 3: Run all account pool tests**

Run: `bun test services/proxy/src/services/__tests__/account-pool-service.test.ts`
Expected: PASS

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/proxy/src/services/account-pool-service.ts services/proxy/src/services/__tests__/account-pool-service.test.ts
git commit -m "refactor(proxy): delegate AccountPoolService usage fetching to UsageCacheService"
```

---

### Task 5: Wire UsageCacheService into Container and AuthenticationService

**Files:**

- Modify: `services/proxy/src/container.ts`
- Modify: `services/proxy/src/services/AuthenticationService.ts`

- [ ] **Step 1: Add UsageCacheService to Container**

In `services/proxy/src/container.ts`:

1. Add import:

```typescript
import { UsageCacheService } from './services/usage-cache-service.js'
```

2. Add private field in `Container` class (after line 44):

```typescript
private usageCacheService?: UsageCacheService
```

3. Initialize in `initializeServices` (after `this.pool` check, before `AuthenticationService` creation around line 136):

```typescript
this.usageCacheService = new UsageCacheService(this.pool)
this.authenticationService = new AuthenticationService(this.pool, this.usageCacheService)
```

4. Add getter in `Container` class:

```typescript
getUsageCacheService(): UsageCacheService | undefined {
  return this.usageCacheService
}
```

5. Add `this.usageCacheService = undefined` in `cleanup()`.

6. Add getter in `LazyContainer` class:

```typescript
getUsageCacheService(): UsageCacheService | undefined {
  return this.ensureInstance().getUsageCacheService()
}
```

- [ ] **Step 2: Update AuthenticationService to accept and pass UsageCacheService**

In `services/proxy/src/services/AuthenticationService.ts`:

1. Add import:

```typescript
import { UsageCacheService } from './usage-cache-service'
```

2. Update constructor:

```typescript
constructor(
  private readonly pool: Pool,
  private readonly usageCacheService: UsageCacheService
) {
  this.accountPoolService = new AccountPoolService(this.pool, this.usageCacheService)
}
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add services/proxy/src/container.ts services/proxy/src/services/AuthenticationService.ts
git commit -m "feat(proxy): wire UsageCacheService into Container and AuthenticationService"
```

---

## Chunk 3: Dashboard API Route and UI Changes

### Task 6: Refactor dashboard API route to use UsageCacheService

**Files:**

- Modify: `services/proxy/src/routes/api.ts:1421-1570` (the `/api/oauth-usage/:accountId` route)

- [ ] **Step 1: Replace direct Anthropic fetch with UsageCacheService**

In `services/proxy/src/routes/api.ts`, replace the `/api/oauth-usage/:accountId` route handler (lines 1424-end of route). The new handler should:

1. Get `UsageCacheService` from the container
2. Get the credential (existing logic)
3. Check for `?force=true` query param
4. Call `usageCacheService.getUsage()` or `usageCacheService.forceRefresh()`
5. Transform `CachedUsageEntry` to `OAuthUsageDisplay` response format
6. Include `is_estimated` and `fetched_at` from the cache entry

Replace the route body starting at line 1440 (after credential lookup) with:

```typescript
// Get the usage cache service from container
const usageCacheService = container.getUsageCacheService()
if (!usageCacheService) {
  return c.json({ success: false, error: 'Usage cache service not available' }, 503)
}

// Check if it's an Anthropic credential
if (credential.provider !== 'anthropic') {
  return c.json({
    success: true,
    data: {
      account_id: accountId,
      provider: credential.provider,
      available: false,
      error: 'OAuth usage is only available for Anthropic accounts',
      windows: [],
      fetched_at: new Date().toISOString(),
      is_estimated: false,
    },
  })
}

const forceRefresh = c.req.query('force') === 'true'
const entry = forceRefresh
  ? await usageCacheService.forceRefresh(credential as AnthropicCredential)
  : await usageCacheService.getUsage(credential as AnthropicCredential)

if (!entry || !entry.usage) {
  return c.json({
    success: true,
    data: {
      account_id: accountId,
      provider: 'anthropic',
      available: false,
      error: 'Failed to fetch usage data',
      windows: [],
      fetched_at: new Date().toISOString(),
      is_estimated: false,
    },
  })
}

// Transform raw usage to display format (same window mappings as before)
type WindowKey =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_oauth_apps'
  | 'seven_day_opus'
  | 'seven_day_sonnet'
const windowMappings: Array<{
  key: WindowKey
  name: string
  shortName: string
}> = [
  { key: 'five_hour', name: '5-Hour Window', shortName: '5h' },
  { key: 'seven_day', name: '7-Day Window', shortName: '7d' },
  { key: 'seven_day_oauth_apps', name: '7-Day OAuth Apps', shortName: '7d OAuth' },
  { key: 'seven_day_opus', name: '7-Day Opus', shortName: '7d Opus' },
  { key: 'seven_day_sonnet', name: '7-Day Sonnet', shortName: '7d Sonnet' },
]

const windows = []
for (const mapping of windowMappings) {
  const windowData = entry.usage[mapping.key] as
    | { utilization: number; resets_at: string }
    | null
    | undefined
  if (windowData && typeof windowData === 'object' && 'utilization' in windowData) {
    const resetDate = new Date(windowData.resets_at)
    windows.push({
      name: mapping.name,
      short_name: mapping.shortName,
      utilization: windowData.utilization,
      resets_at: formatResetTime(resetDate),
      resets_at_iso: windowData.resets_at,
    })
  }
}

return c.json({
  success: true,
  data: {
    account_id: accountId,
    provider: 'anthropic',
    available: true,
    windows,
    fetched_at: new Date(entry.fetchedAt).toISOString(),
    is_estimated: entry.isEstimated,
    extra_usage: entry.usage.extra_usage ?? undefined,
  },
})
```

- [ ] **Step 2: Add AnthropicCredential import if not already present**

Ensure the route file has access to `AnthropicCredential` type. Add at the top:

```typescript
import type { AnthropicCredential } from '@agent-prompttrain/shared'
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add services/proxy/src/routes/api.ts
git commit -m "refactor(proxy): use UsageCacheService in oauth-usage API route with force-refresh support"
```

---

### Task 7: Update dashboard Token Usage page to show cache freshness

**Files:**

- Modify: `services/dashboard/src/routes/token-usage.ts`

- [ ] **Step 1: Add relative time helper function**

Add this helper near the top of the file (after the existing `formatTimeLeft` function):

```typescript
function formatRelativeTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()

  if (diffMs < 60_000) return 'just now'
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
```

- [ ] **Step 2: Update the account detail page (single account view)**

In the section around line 528-532 where `fetched_at` is currently rendered as absolute time:

Replace:

```typescript
Data from Anthropic OAuth API • Updated:
${new Date(oauthUsage.fetched_at).toLocaleTimeString()}
```

With:

```typescript
Data from Anthropic OAuth API${oauthUsage.is_estimated ? ' <span style="background: #fef3c7; color: #92400e; padding: 2px 8px; border-radius: 4px; font-weight: 600;">estimated</span>' : ''} • Last checked: ${formatRelativeTime(oauthUsage.fetched_at)}
<a href="/dashboard/token-usage?accountId=${encodeURIComponent(accountId)}&force=true" style="margin-left: 8px; color: #3b82f6; text-decoration: underline; font-size: 12px;">↻ Refresh</a>
```

- [ ] **Step 3: Handle `?force=true` in the dashboard route**

In the account detail route handler (around line 466), pass the force parameter through to the API client:

```typescript
const forceRefresh = c.req.query('force') === 'true'
apiClient.getOAuthUsage(accountId, forceRefresh),
```

Update `ProxyApiClient.getOAuthUsage` in `services/dashboard/src/services/api-client.ts` to accept and pass the force parameter:

```typescript
async getOAuthUsage(accountId: string, force = false): Promise<OAuthUsageDisplay | null> {
  try {
    const url = new URL(`/api/oauth-usage/${encodeURIComponent(accountId)}`, this.baseUrl)
    if (force) url.searchParams.set('force', 'true')
    // ... rest unchanged
```

- [ ] **Step 4: Update the overview page (multi-account list view)**

In the multi-account view (around line 363-396), the `oauthUsage` display already shows bars. Add the estimated indicator below the bars if `oauthUsage.is_estimated` is true. This is in the card rendering template -- after the windows grid, add:

```typescript
${oauthUsage.is_estimated ? `<div style="font-size: 11px; color: #92400e; margin-top: 4px;">⚠ Estimated (API rate limited) • Last checked: ${formatRelativeTime(oauthUsage.fetched_at)}</div>` : ''}
```

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add services/dashboard/src/routes/token-usage.ts services/dashboard/src/services/api-client.ts
git commit -m "feat(dashboard): show cache freshness, estimated badge, and refresh button on Token Usage page"
```

---

### Task 8: Final validation

**Files:** None (verification only)

- [ ] **Step 1: Run all unit tests**

Run: `bun test`
Expected: PASS

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Verify no regressions in existing tests**

Run: `bun test services/proxy/src/services/__tests__/account-pool-service.test.ts`
Expected: PASS (all 9 existing scenarios pass with refactored code)

Run: `bun test services/proxy/src/services/__tests__/usage-cache-service.test.ts`
Expected: PASS (all cache, extrapolation, deduplication, and force-refresh tests pass)
