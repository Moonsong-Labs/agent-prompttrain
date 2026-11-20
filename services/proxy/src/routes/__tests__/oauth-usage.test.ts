import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import type {
  AnthropicCredential,
  AnthropicOAuthUsageResponse,
  OAuthUsageApiResponse,
} from '@agent-prompttrain/shared'
import { apiRoutes } from '../api.js'
import { container } from '../../container.js'
import { apiResponseCache } from '../../services/response-cache.js'
import type { UsageCacheService, CachedUsageEntry } from '../../services/usage-cache-service.js'

const FUTURE_5H = '2027-02-24T12:00:00.000Z'
const FUTURE_7D = '2027-02-28T00:00:00.000Z'
const FUTURE_FABLE = '2027-03-01T00:00:00.000Z'

function makeCredential(overrides: Partial<AnthropicCredential> = {}): AnthropicCredential {
  return {
    id: 'cred-1',
    account_id: 'acct-1',
    account_name: 'Account 1',
    provider: 'anthropic',
    token_limit_threshold: 0.95,
    five_hour_limit_threshold: 0.9,
    seven_day_limit_threshold: 0.95,
    oauth_access_token: 'tok',
    oauth_refresh_token: 'ref',
    oauth_expires_at: new Date('2027-01-01T00:00:00Z'),
    oauth_scopes: ['default'],
    oauth_is_max: true,
    last_refresh_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function makeUsage(
  overrides: Partial<AnthropicOAuthUsageResponse> = {}
): AnthropicOAuthUsageResponse {
  return {
    five_hour: { utilization: 40, resets_at: FUTURE_5H },
    seven_day: { utilization: 50, resets_at: FUTURE_7D },
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
    ...overrides,
  }
}

describe('GET /api/oauth-usage/:accountId threshold metadata', () => {
  let usageEntry: CachedUsageEntry | null
  let credentialRow: AnthropicCredential | null
  let usageCacheSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    apiResponseCache.clear()
    usageEntry = null
    credentialRow = makeCredential()

    const mockUsageCache = {
      getUsage: async () => usageEntry,
      forceRefresh: async () => usageEntry,
    } as unknown as UsageCacheService

    usageCacheSpy = spyOn(container, 'getUsageCacheService').mockReturnValue(mockUsageCache)
  })

  afterEach(() => {
    usageCacheSpy.mockRestore()
    apiResponseCache.clear()
  })

  function createApp() {
    const mockPool = {
      query: async () => ({ rows: credentialRow ? [credentialRow] : [] }),
    } as unknown as Pool

    const app = new Hono<{ Variables: { pool?: Pool } }>()
    app.use('*', async (c, next) => {
      c.set('pool', mockPool)
      await next()
    })
    app.route('/api', apiRoutes)
    return app
  }

  it('includes threshold metadata and over_threshold=false when under configured thresholds', async () => {
    usageEntry = {
      usage: makeUsage({
        five_hour: { utilization: 50, resets_at: FUTURE_5H },
        seven_day: { utilization: 60, resets_at: FUTURE_7D },
      }),
      fetchedAt: Date.now(),
      isEstimated: false,
    }

    const res = await createApp().request('/api/oauth-usage/acct-1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as OAuthUsageApiResponse

    expect(body.success).toBe(true)
    expect(body.data?.thresholds).toEqual({ five_hour: 90, seven_day: 95 })
    expect(body.data?.over_threshold).toBe(false)
    expect(body.data?.over_threshold_windows).toEqual([])
    expect(body.data?.blocked_until_iso).toBeNull()
    expect(body.data?.windows[0]).toMatchObject({
      short_name: '5h',
      threshold: 90,
      over_threshold: false,
    })
    expect(body.data?.windows[1]).toMatchObject({
      short_name: '7d',
      threshold: 95,
      over_threshold: false,
    })
  })

  it('marks account over_threshold using credential-specific thresholds and exposes blocked_until_iso', async () => {
    credentialRow = makeCredential({
      five_hour_limit_threshold: 0.8,
      seven_day_limit_threshold: 0.85,
    })
    usageEntry = {
      usage: makeUsage({
        five_hour: { utilization: 82, resets_at: FUTURE_5H },
        seven_day: { utilization: 40, resets_at: FUTURE_7D },
      }),
      fetchedAt: Date.now(),
      isEstimated: false,
    }

    const res = await createApp().request('/api/oauth-usage/acct-1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as OAuthUsageApiResponse

    expect(body.data?.thresholds).toEqual({ five_hour: 80, seven_day: 85 })
    expect(body.data?.over_threshold).toBe(true)
    expect(body.data?.over_threshold_windows).toEqual(['5-Hour Window'])
    expect(body.data?.blocked_until_iso).toBe(FUTURE_5H)
    expect(body.data?.windows[0]).toMatchObject({
      short_name: '5h',
      threshold: 80,
      over_threshold: true,
    })
  })

  it('keeps account over_threshold=false while marking saturated model-scoped limit on its window', async () => {
    usageEntry = {
      usage: makeUsage({
        five_hour: { utilization: 20, resets_at: FUTURE_5H },
        seven_day: { utilization: 30, resets_at: FUTURE_7D },
        limits: [
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 98,
            severity: 'exceeded',
            resets_at: FUTURE_FABLE,
            scope: { model: { id: null, display_name: 'Fable' }, surface: null },
            is_active: true,
          },
        ],
      }),
      fetchedAt: Date.now(),
      isEstimated: false,
    }

    const res = await createApp().request('/api/oauth-usage/acct-1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as OAuthUsageApiResponse

    expect(body.data?.over_threshold).toBe(false)
    expect(body.data?.blocked_until_iso).toBeNull()
    const scopedWindow = body.data?.windows.find(w => w.short_name === '7d Fable')
    expect(scopedWindow).toMatchObject({
      name: '7-Day Fable',
      threshold: 95,
      over_threshold: true,
      scoped_model: 'Fable',
      resets_at_iso: FUTURE_FABLE,
    })
  })
})
