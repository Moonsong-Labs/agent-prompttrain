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
