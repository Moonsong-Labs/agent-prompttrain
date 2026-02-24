import { describe, test, expect, beforeEach, mock } from 'bun:test'
import type { AnthropicCredential, BedrockCredential, Credential } from '@agent-prompttrain/shared'

// ── Mock functions ──────────────────────────────────────────────────────────

const mockGetProjectLinkedCredentials = mock<
  (pool: any, projectId: string) => Promise<Credential[]>
>(() => Promise.resolve([]))

const mockGetProjectCredentials = mock<(pool: any, projectId: string) => Promise<Credential[]>>(
  () => Promise.resolve([])
)

const mockGetApiKey = mock<(credId: string, pool: any) => Promise<string | null>>(
  (credId: string) => Promise.resolve(`token-${credId}`)
)

// ── Module mocks (must run before importing the service) ────────────────────

mock.module('@agent-prompttrain/shared/database/queries', () => ({
  getProjectLinkedCredentials: mockGetProjectLinkedCredentials,
  getProjectCredentials: mockGetProjectCredentials,
}))

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

// ── Import service under test (after mocks) ─────────────────────────────────

import { AccountPoolService, AccountPoolExhaustedError } from '../account-pool-service'

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeAnthropicCredential(
  overrides: Partial<AnthropicCredential> = {}
): AnthropicCredential {
  return {
    id: 'cred-1',
    account_id: 'acct-1',
    account_name: 'Test Account 1',
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

function makeBedrockCredential(overrides: Partial<BedrockCredential> = {}): BedrockCredential {
  return {
    id: 'cred-bedrock',
    account_id: 'acct-bedrock',
    account_name: 'Bedrock Account',
    provider: 'bedrock',
    token_limit_threshold: 0.8,
    aws_region: 'us-east-1',
    aws_api_key: 'fake-key',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

function makeUsageResponse(fiveHour = 0.5, sevenDay = 0.3) {
  return {
    five_hour: { utilization: fiveHour, resets_at: '2026-02-24T12:00:00Z' },
    seven_day: { utilization: sevenDay, resets_at: '2026-02-28T00:00:00Z' },
    seven_day_opus: null,
    seven_day_sonnet: null,
  }
}

function mockFetchWithUsage(usageByCredId: Record<string, ReturnType<typeof makeUsageResponse>>) {
  globalThis.fetch = mock((url: string | URL | Request, options?: RequestInit) => {
    const authHeader = (options?.headers as Record<string, string>)?.Authorization ?? ''
    // mockGetApiKey returns `token-{credId}`, extract the credId
    const token = authHeader.replace('Bearer token-', '')
    const usage = usageByCredId[token] ?? makeUsageResponse()
    return Promise.resolve(new Response(JSON.stringify(usage), { status: 200 }))
  }) as unknown as typeof globalThis.fetch
}

function mockFetchFailure() {
  globalThis.fetch = mock(() => {
    return Promise.resolve(new Response('Internal Server Error', { status: 500 }))
  }) as unknown as typeof globalThis.fetch
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AccountPoolService', () => {
  let service: AccountPoolService
  const fakePool = null as any

  beforeEach(() => {
    service = new AccountPoolService(fakePool)
    mockGetProjectLinkedCredentials.mockReset()
    mockGetProjectCredentials.mockReset()
    mockGetApiKey.mockReset()
    mockGetApiKey.mockImplementation((credId: string) => Promise.resolve(`token-${credId}`))
  })

  // ── Scenario 1: 0-1 linked accounts ──────────────────────────────────────

  describe('0-1 linked accounts (non-pool mode)', () => {
    test('returns default account with fromPool: false when 0 linked accounts', async () => {
      const defaultCred = makeAnthropicCredential({ id: 'default-cred' })
      mockGetProjectLinkedCredentials.mockImplementation(() => Promise.resolve([]))
      mockGetProjectCredentials.mockImplementation(() => Promise.resolve([defaultCred]))

      const result = await service.selectAccount('project-1')

      expect(result.fromPool).toBe(false)
      expect(result.credential.id).toBe('default-cred')
      expect(result.maxUtilization).toBe(0)
    })

    test('returns default account with fromPool: false when 1 linked account', async () => {
      const cred1 = makeAnthropicCredential({ id: 'cred-1' })
      const defaultCred = makeAnthropicCredential({ id: 'default-cred' })
      mockGetProjectLinkedCredentials.mockImplementation(() => Promise.resolve([cred1]))
      mockGetProjectCredentials.mockImplementation(() => Promise.resolve([defaultCred]))

      const result = await service.selectAccount('project-1')

      expect(result.fromPool).toBe(false)
      expect(result.credential.id).toBe('default-cred')
      expect(result.maxUtilization).toBe(0)
    })

    test('throws if no default credential exists', async () => {
      mockGetProjectLinkedCredentials.mockImplementation(() => Promise.resolve([]))
      mockGetProjectCredentials.mockImplementation(() => Promise.resolve([]))

      await expect(service.selectAccount('project-1')).rejects.toThrow(
        'No default credential found for project "project-1"'
      )
    })
  })

  // ── Scenario 2: 2+ accounts, sticky under threshold ─────────────────────

  describe('sticky account under threshold', () => {
    test('returns sticky account on second call when still under threshold', async () => {
      const cred1 = makeAnthropicCredential({ id: 'cred-1', account_id: 'acct-1' })
      const cred2 = makeAnthropicCredential({ id: 'cred-2', account_id: 'acct-2' })
      mockGetProjectLinkedCredentials.mockImplementation(() => Promise.resolve([cred1, cred2]))

      // cred-1 has lower utilization, so it should be selected first
      mockFetchWithUsage({
        'cred-1': makeUsageResponse(0.3, 0.2),
        'cred-2': makeUsageResponse(0.5, 0.4),
      })

      const first = await service.selectAccount('project-1')
      expect(first.credential.id).toBe('cred-1')
      expect(first.fromPool).toBe(true)

      // Second call should reuse sticky (cred-1) because it is still under threshold
      const second = await service.selectAccount('project-1')
      expect(second.credential.id).toBe('cred-1')
      expect(second.fromPool).toBe(true)
    })
  })

  // ── Scenario 3: Sticky over 5h threshold ─────────────────────────────────

  describe('sticky over 5-hour threshold', () => {
    test('switches to least-loaded alternative when sticky exceeds threshold on 5h', async () => {
      const cred1 = makeAnthropicCredential({
        id: 'cred-1',
        account_id: 'acct-1',
        token_limit_threshold: 0.8,
      })
      const cred2 = makeAnthropicCredential({
        id: 'cred-2',
        account_id: 'acct-2',
        token_limit_threshold: 0.8,
      })
      mockGetProjectLinkedCredentials.mockImplementation(() => Promise.resolve([cred1, cred2]))

      // First call: cred-1 has lower usage, gets selected & becomes sticky
      mockFetchWithUsage({
        'cred-1': makeUsageResponse(0.3, 0.2),
        'cred-2': makeUsageResponse(0.5, 0.4),
      })
      const first = await service.selectAccount('project-1')
      expect(first.credential.id).toBe('cred-1')

      // Now cred-1 five_hour spikes above threshold, cred-2 is still under
      service.clearUsageCache()
      mockFetchWithUsage({
        'cred-1': makeUsageResponse(0.85, 0.2), // 5h over 0.80 threshold
        'cred-2': makeUsageResponse(0.5, 0.4),
      })

      const second = await service.selectAccount('project-1')
      expect(second.credential.id).toBe('cred-2')
      expect(second.fromPool).toBe(true)
    })
  })

  // ── Scenario 4: Sticky over 7d threshold ─────────────────────────────────

  describe('sticky over 7-day threshold', () => {
    test('switches even if 5h is fine when 7d exceeds threshold', async () => {
      const cred1 = makeAnthropicCredential({
        id: 'cred-1',
        account_id: 'acct-1',
        token_limit_threshold: 0.8,
      })
      const cred2 = makeAnthropicCredential({
        id: 'cred-2',
        account_id: 'acct-2',
        token_limit_threshold: 0.8,
      })
      mockGetProjectLinkedCredentials.mockImplementation(() => Promise.resolve([cred1, cred2]))

      // First call: cred-1 is lower
      mockFetchWithUsage({
        'cred-1': makeUsageResponse(0.3, 0.2),
        'cred-2': makeUsageResponse(0.5, 0.4),
      })
      const first = await service.selectAccount('project-1')
      expect(first.credential.id).toBe('cred-1')

      // Now cred-1 seven_day goes over threshold, but five_hour stays low
      service.clearUsageCache()
      mockFetchWithUsage({
        'cred-1': makeUsageResponse(0.3, 0.85), // 7d over 0.80 threshold
        'cred-2': makeUsageResponse(0.5, 0.4),
      })

      const second = await service.selectAccount('project-1')
      expect(second.credential.id).toBe('cred-2')
    })
  })

  // ── Scenario 5: All accounts exhausted ───────────────────────────────────

  describe('all accounts exhausted', () => {
    test('throws AccountPoolExhaustedError with resets_at', async () => {
      const cred1 = makeAnthropicCredential({
        id: 'cred-1',
        account_id: 'acct-1',
        token_limit_threshold: 0.8,
      })
      const cred2 = makeAnthropicCredential({
        id: 'cred-2',
        account_id: 'acct-2',
        token_limit_threshold: 0.8,
      })
      mockGetProjectLinkedCredentials.mockImplementation(() => Promise.resolve([cred1, cred2]))

      // Both accounts over threshold
      mockFetchWithUsage({
        'cred-1': makeUsageResponse(0.9, 0.85),
        'cred-2': makeUsageResponse(0.95, 0.88),
      })

      try {
        await service.selectAccount('project-1')
        // Should not reach here
        expect(true).toBe(false)
      } catch (error) {
        expect(error).toBeInstanceOf(AccountPoolExhaustedError)
        const poolError = error as AccountPoolExhaustedError
        expect(poolError.statusCode).toBe(429)
        expect(poolError.estimatedReset).toBe('2026-02-24T12:00:00Z')
        expect(poolError.message).toContain('project-1')
        expect(poolError.message).toContain('2')
      }
    })
  })

  // ── Scenario 6: Cache expiry ─────────────────────────────────────────────

  describe('usage cache expiry', () => {
    test('re-fetches from API after clearUsageCache()', async () => {
      const cred1 = makeAnthropicCredential({ id: 'cred-1' })
      const cred2 = makeAnthropicCredential({ id: 'cred-2' })
      mockGetProjectLinkedCredentials.mockImplementation(() => Promise.resolve([cred1, cred2]))

      mockFetchWithUsage({
        'cred-1': makeUsageResponse(0.3, 0.2),
        'cred-2': makeUsageResponse(0.5, 0.4),
      })

      await service.selectAccount('project-1')

      // fetch was called for both credentials during the pool evaluation
      const fetchCallCount = (globalThis.fetch as any).mock.calls.length

      // Second call uses cache, so no new fetches
      await service.selectAccount('project-1')
      const fetchCallCountAfterCachedCall = (globalThis.fetch as any).mock.calls.length
      // The sticky path fetches usage for the sticky credential only (cached hit)
      // so total fetch count should stay the same
      expect(fetchCallCountAfterCachedCall).toBe(fetchCallCount)

      // Clear cache and call again - should trigger new fetches
      service.clearUsageCache()
      await service.selectAccount('project-1')
      const fetchCallCountAfterCacheClear = (globalThis.fetch as any).mock.calls.length
      // After cache clear, sticky check re-fetches (1 call), and since it's under threshold, returns
      expect(fetchCallCountAfterCacheClear).toBeGreaterThan(fetchCallCount)
    })
  })

  // ── Scenario 7: Anthropic API failure ────────────────────────────────────

  describe('Anthropic API failure (conservative)', () => {
    test('treats account as over threshold when API returns error', async () => {
      const cred1 = makeAnthropicCredential({
        id: 'cred-1',
        account_id: 'acct-1',
        token_limit_threshold: 0.8,
      })
      const cred2 = makeAnthropicCredential({
        id: 'cred-2',
        account_id: 'acct-2',
        token_limit_threshold: 0.8,
      })
      mockGetProjectLinkedCredentials.mockImplementation(() => Promise.resolve([cred1, cred2]))

      // Both accounts fail to return usage
      mockFetchFailure()

      try {
        await service.selectAccount('project-1')
        expect(true).toBe(false)
      } catch (error) {
        // null usage -> maxUtilization = 100 -> all over threshold -> exhausted
        expect(error).toBeInstanceOf(AccountPoolExhaustedError)
      }
    })

    test('treats account as over threshold when getApiKey returns null', async () => {
      const cred1 = makeAnthropicCredential({
        id: 'cred-1',
        token_limit_threshold: 0.8,
      })
      const cred2 = makeAnthropicCredential({
        id: 'cred-2',
        token_limit_threshold: 0.8,
      })
      mockGetProjectLinkedCredentials.mockImplementation(() => Promise.resolve([cred1, cred2]))
      mockGetApiKey.mockImplementation(() => Promise.resolve(null))

      try {
        await service.selectAccount('project-1')
        expect(true).toBe(false)
      } catch (error) {
        expect(error).toBeInstanceOf(AccountPoolExhaustedError)
      }
    })
  })

  // ── Scenario 8: Bedrock accounts skipped ─────────────────────────────────

  describe('Bedrock accounts skipped', () => {
    test('only Anthropic accounts participate in pool', async () => {
      const anthropicCred = makeAnthropicCredential({ id: 'cred-anth', account_id: 'acct-anth' })
      const bedrockCred = makeBedrockCredential({ id: 'cred-bedrock', account_id: 'acct-bedrock' })
      mockGetProjectLinkedCredentials.mockImplementation(() =>
        Promise.resolve([anthropicCred, bedrockCred])
      )

      mockFetchWithUsage({
        'cred-anth': makeUsageResponse(0.3, 0.2),
      })

      const result = await service.selectAccount('project-1')
      expect(result.credential.id).toBe('cred-anth')
      expect(result.fromPool).toBe(true)
    })

    test('falls back to default account when all linked accounts are Bedrock', async () => {
      const bedrock1 = makeBedrockCredential({ id: 'bedrock-1' })
      const bedrock2 = makeBedrockCredential({ id: 'bedrock-2' })
      const defaultCred = makeAnthropicCredential({ id: 'default-cred' })

      mockGetProjectLinkedCredentials.mockImplementation(() =>
        Promise.resolve([bedrock1, bedrock2])
      )
      mockGetProjectCredentials.mockImplementation(() => Promise.resolve([defaultCred]))

      const result = await service.selectAccount('project-1')
      expect(result.fromPool).toBe(false)
      expect(result.credential.id).toBe('default-cred')
    })
  })

  // ── Scenario 9: clearStickyState() / clearUsageCache() ──────────────────

  describe('clearStickyState() / clearUsageCache()', () => {
    test('clearStickyState() resets sticky mapping', async () => {
      const cred1 = makeAnthropicCredential({ id: 'cred-1', account_id: 'acct-1' })
      const cred2 = makeAnthropicCredential({ id: 'cred-2', account_id: 'acct-2' })
      mockGetProjectLinkedCredentials.mockImplementation(() => Promise.resolve([cred1, cred2]))

      // cred-1 gets selected (lower utilization)
      mockFetchWithUsage({
        'cred-1': makeUsageResponse(0.3, 0.2),
        'cred-2': makeUsageResponse(0.5, 0.4),
      })

      const first = await service.selectAccount('project-1')
      expect(first.credential.id).toBe('cred-1')

      // Clear sticky and cache, now cred-2 is lower
      service.clearStickyState()
      service.clearUsageCache()
      mockFetchWithUsage({
        'cred-1': makeUsageResponse(0.7, 0.6),
        'cred-2': makeUsageResponse(0.2, 0.1),
      })

      const second = await service.selectAccount('project-1')
      expect(second.credential.id).toBe('cred-2')
    })

    test('clearUsageCache() forces fresh API calls', async () => {
      const cred1 = makeAnthropicCredential({ id: 'cred-1' })
      const cred2 = makeAnthropicCredential({ id: 'cred-2' })
      mockGetProjectLinkedCredentials.mockImplementation(() => Promise.resolve([cred1, cred2]))

      mockFetchWithUsage({
        'cred-1': makeUsageResponse(0.3, 0.2),
        'cred-2': makeUsageResponse(0.5, 0.4),
      })

      await service.selectAccount('project-1')

      // Record fetch calls so far
      const callsAfterFirst = (globalThis.fetch as any).mock.calls.length

      // Clear cache
      service.clearUsageCache()

      // Now the next call must re-fetch
      await service.selectAccount('project-1')
      const callsAfterSecond = (globalThis.fetch as any).mock.calls.length

      // At minimum, sticky check will re-fetch for the sticky credential
      expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst)
    })
  })
})
