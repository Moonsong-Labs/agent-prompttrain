import { describe, test, expect, beforeEach, mock } from 'bun:test'
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
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    iguana_necktie: null,
    extra_usage: {
      is_enabled: false,
      monthly_limit: null,
      used_credits: null,
      utilization: null,
    },
  }
}

function mockFetchSuccess(usage: AnthropicOAuthUsageResponse = makeRawUsage()) {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify(usage), { status: 200 }))
  ) as unknown as typeof globalThis.fetch
}

function mockFetchError() {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response('Internal Server Error', { status: 500 }))
  ) as unknown as typeof globalThis.fetch
}

function mockFetchRateLimit() {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response('Rate limited', { status: 429 }))
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

  describe('extrapolation on API failure', () => {
    test('extrapolates from last known value when API returns 429', async () => {
      const cred = makeCredential()

      // Successful fetch first
      mockFetchSuccess(makeRawUsage(50, 30))
      await service.getUsage(cred)

      // Expire and fail: manipulate cache to simulate 10 minutes elapsed
      const cache = (service as any).cache as Map<string, any>
      const entry = cache.get(cred.id)!
      entry.fetchedAt = Date.now() - 600_000 // 10 minutes ago

      mockFetchRateLimit()
      const result = await service.getUsage(cred)

      expect(result).not.toBeNull()
      expect(result!.isEstimated).toBe(true)
      // 50 + (10 min / 10) * 2 ≈ 52 (tiny float variance from Date.now())
      expect(result!.usage!.five_hour!.utilization).toBeCloseTo(52, 0)
      // 30 + (10 min / 10) * 2 ≈ 32
      expect(result!.usage!.seven_day!.utilization).toBeCloseTo(32, 0)
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
        seven_day_oauth_apps: null,
        seven_day_opus: null,
        seven_day_sonnet: null,
        iguana_necktie: null,
        extra_usage: {
          is_enabled: false,
          monthly_limit: null,
          used_credits: null,
          utilization: null,
        },
      }

      mockFetchSuccess(usageWithNulls)
      await service.getUsage(cred)

      const cache = (service as any).cache as Map<string, any>
      cache.get(cred.id)!.fetchedAt = Date.now() - 600_000

      mockFetchRateLimit()
      const result = await service.getUsage(cred)

      expect(result!.isEstimated).toBe(true)
      expect(result!.usage!.five_hour!.utilization).toBeCloseTo(52, 0) // Extrapolated
      expect(result!.usage!.seven_day).toBeNull() // Stays null
    })

    test('does not extrapolate extra_usage', async () => {
      const cred = makeCredential()
      const usageWithExtra: AnthropicOAuthUsageResponse = {
        five_hour: { utilization: 50, resets_at: '2026-03-12T18:00:00Z' },
        seven_day: null,
        seven_day_oauth_apps: null,
        seven_day_opus: null,
        seven_day_sonnet: null,
        iguana_necktie: null,
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
})
