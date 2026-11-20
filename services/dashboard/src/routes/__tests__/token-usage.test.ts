import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import type { OAuthUsageDisplay } from '@agent-prompttrain/shared'
import {
  formatTimeLeftPlain,
  renderThresholdNotice,
  renderUsageWindows,
} from '../../components/usage-windows.js'
import { tokenUsageRoutes } from '../token-usage.js'
import { publicTokenUsageRoutes } from '../public-token-usage.js'
import { container } from '../../container.js'
import type { ProxyApiClient } from '../../services/api-client.js'

const NOW = Date.parse('2026-11-20T12:00:00.000Z')
const RESET_2H = '2026-11-20T14:15:00.000Z'
const RESET_3D = '2026-11-23T16:30:00.000Z'

function makeUsage(overrides: Partial<OAuthUsageDisplay> = {}): OAuthUsageDisplay {
  return {
    account_id: 'acct-1',
    provider: 'anthropic',
    available: true,
    fetched_at: '2026-11-20T11:58:00.000Z',
    is_estimated: false,
    thresholds: { five_hour: 90, seven_day: 95 },
    over_threshold: false,
    over_threshold_windows: [],
    blocked_until_iso: null,
    windows: [
      {
        name: '5-Hour Window',
        short_name: '5h',
        utilization: 40,
        resets_at: '02:15 PM',
        resets_at_iso: RESET_2H,
        threshold: 90,
        over_threshold: false,
      },
      {
        name: '7-Day Window',
        short_name: '7d',
        utilization: 55,
        resets_at: 'Nov 23, 04:30 PM',
        resets_at_iso: RESET_3D,
        threshold: 95,
        over_threshold: false,
      },
    ],
    ...overrides,
  }
}

describe('usage-windows threshold notice', () => {
  it('formats plain remaining durations cleanly', () => {
    expect(formatTimeLeftPlain(RESET_2H, NOW)).toBe('2h 15m')
    expect(formatTimeLeftPlain(RESET_3D, NOW)).toBe('3d 4h 30m')
    expect(formatTimeLeftPlain('2026-11-20T12:00:25.000Z', NOW)).toBe('<1m')
    expect(formatTimeLeftPlain('2026-11-20T11:59:00.000Z', NOW)).toBeNull()
    expect(formatTimeLeftPlain(null, NOW)).toBeNull()
  })

  it('returns empty string when account is below threshold', () => {
    expect(renderThresholdNotice(makeUsage(), 'regular', NOW)).toBe('')
    expect(renderThresholdNotice(null, 'regular', NOW)).toBe('')
    expect(renderThresholdNotice({ ...makeUsage(), available: false }, 'regular', NOW)).toBe('')
  })

  it('renders an account-wide pause notice when 5-hour window exceeds threshold', () => {
    const usage = makeUsage({
      over_threshold: true,
      over_threshold_windows: ['5-Hour Window'],
      blocked_until_iso: RESET_2H,
      windows: [
        {
          name: '5-Hour Window',
          short_name: '5h',
          utilization: 92.4,
          resets_at: '02:15 PM',
          resets_at_iso: RESET_2H,
          threshold: 90,
          over_threshold: true,
        },
        {
          name: '7-Day Window',
          short_name: '7d',
          utilization: 55,
          resets_at: 'Nov 23, 04:30 PM',
          resets_at_iso: RESET_3D,
          threshold: 95,
          over_threshold: false,
        },
      ],
    })

    const notice = renderThresholdNotice(usage, 'regular', NOW)
    expect(notice).toContain('data-testid="threshold-notice"')
    expect(notice).toContain('Over threshold')
    expect(notice).toContain('5-Hour Window ≥ 90%')
    expect(notice).toContain("account can't be used until reset (2h 15m left)")
  })

  it('renders both blocking windows and uses the latest reset time when both exceed threshold', () => {
    const usage = makeUsage({
      over_threshold: true,
      over_threshold_windows: ['5-Hour Window', '7-Day Window'],
      blocked_until_iso: RESET_3D,
      windows: [
        {
          name: '5-Hour Window',
          short_name: '5h',
          utilization: 95,
          resets_at: '02:15 PM',
          resets_at_iso: RESET_2H,
          threshold: 90,
          over_threshold: true,
        },
        {
          name: '7-Day Window',
          short_name: '7d',
          utilization: 97,
          resets_at: 'Nov 23, 04:30 PM',
          resets_at_iso: RESET_3D,
          threshold: 95,
          over_threshold: true,
        },
      ],
    })

    const notice = renderThresholdNotice(usage, 'compact', NOW)
    expect(notice).toContain('5-Hour Window ≥ 90%, 7-Day Window ≥ 95%')
    expect(notice).toContain("account can't be used until reset (3d 4h 30m left)")
  })

  it('renders a model-scoped warning notice when only a model-scoped limit exceeds threshold', () => {
    const usage = makeUsage({
      over_threshold: false,
      windows: [
        {
          name: '5-Hour Window',
          short_name: '5h',
          utilization: 20,
          resets_at: '02:15 PM',
          resets_at_iso: RESET_2H,
          threshold: 90,
          over_threshold: false,
        },
        {
          name: '7-Day Fable',
          short_name: '7d Fable',
          utilization: 98,
          resets_at: 'Nov 23, 04:30 PM',
          resets_at_iso: RESET_3D,
          threshold: 95,
          over_threshold: true,
          scoped_model: 'Fable',
        },
      ],
    })

    const notice = renderThresholdNotice(usage, 'regular', NOW)
    expect(notice).toContain('Over threshold for Fable')
    expect(notice).toContain('7-Day Fable ≥ 95%')
    expect(notice).toContain("can't be used for this model until reset (3d 4h 30m left)")
  })

  it('falls back to default thresholds when proxy response omits over_threshold fields', () => {
    const legacyUsage: OAuthUsageDisplay = {
      account_id: 'acct-legacy',
      provider: 'anthropic',
      available: true,
      fetched_at: '2026-11-20T11:58:00.000Z',
      windows: [
        {
          name: '5-Hour Window',
          short_name: '5h',
          utilization: 91,
          resets_at: '02:15 PM',
          resets_at_iso: RESET_2H,
        },
      ],
    }

    const notice = renderThresholdNotice(legacyUsage, 'regular', NOW)
    expect(notice).toContain('5-Hour Window ≥ 90%')
    expect(notice).toContain("account can't be used until reset (2h 15m left)")
  })

  it('colors custom over-threshold window bars red even below 80%', () => {
    const usage = makeUsage({
      over_threshold: true,
      windows: [
        {
          name: '5-Hour Window',
          short_name: '5h',
          utilization: 75,
          resets_at: '02:15 PM',
          resets_at_iso: RESET_2H,
          threshold: 70,
          over_threshold: true,
        },
      ],
    })
    expect(renderUsageWindows(usage)).toContain('background: #ef4444;')
  })
})

describe('token usage routes threshold notice rendering', () => {
  const futureReset = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()

  const overUsage: OAuthUsageDisplay = makeUsage({
    account_id: 'acct-over',
    over_threshold: true,
    over_threshold_windows: ['5-Hour Window'],
    blocked_until_iso: futureReset,
    windows: [
      {
        name: '5-Hour Window',
        short_name: '5h',
        utilization: 93,
        resets_at: 'soon',
        resets_at_iso: futureReset,
        threshold: 90,
        over_threshold: true,
      },
      {
        name: '7-Day Window',
        short_name: '7d',
        utilization: 45,
        resets_at: 'later',
        resets_at_iso: futureReset,
        threshold: 95,
        over_threshold: false,
      },
    ],
  })

  const okUsage: OAuthUsageDisplay = makeUsage({
    account_id: 'acct-ok',
    over_threshold: false,
    over_threshold_windows: [],
    blocked_until_iso: null,
    windows: [
      {
        name: '5-Hour Window',
        short_name: '5h',
        utilization: 30,
        resets_at: 'soon',
        resets_at_iso: futureReset,
        threshold: 90,
        over_threshold: false,
      },
    ],
  })

  const mockApiClient = {
    getAccountsTokenUsage: async () => ({
      tokenLimit: 140000,
      accounts: [
        {
          accountId: 'acct-over',
          outputTokens: 50000,
          inputTokens: 10000,
          requestCount: 10,
          lastRequestTime: new Date().toISOString(),
          remainingTokens: 90000,
          percentageUsed: 35.7,
          trainIds: [],
          miniSeries: [],
        },
        {
          accountId: 'acct-ok',
          outputTokens: 20000,
          inputTokens: 5000,
          requestCount: 5,
          lastRequestTime: new Date().toISOString(),
          remainingTokens: 120000,
          percentageUsed: 14.3,
          trainIds: [],
          miniSeries: [],
        },
      ],
    }),
    getSlidingWindowUsage: async () => ({
      accountId: 'acct-over',
      params: { days: 7, bucketMinutes: 60, windowHours: 5 },
      data: [],
    }),
    getOAuthUsage: async (accountId: string) => (accountId === 'acct-over' ? overUsage : okUsage),
    getTokenUsageWindow: async (params: { accountId: string }) => ({
      accountId: params.accountId,
      projectId: '',
      model: '',
      windowStart: new Date(Date.now() - 5 * 3600_000).toISOString(),
      windowEnd: new Date().toISOString(),
      totalInputTokens: 1000,
      totalOutputTokens: 2000,
      totalTokens: 3000,
      totalRequests: 2,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    }),
    getDailyTokenUsage: async () => ({ usage: [] }),
    getRateLimitConfigs: async () => ({ configs: [] }),
  } as unknown as ProxyApiClient

  let originalGetApiClient: typeof container.getApiClient

  beforeEach(() => {
    originalGetApiClient = container.getApiClient
    ;(container as unknown as { getApiClient: () => ProxyApiClient }).getApiClient = () =>
      mockApiClient
  })

  afterEach(() => {
    ;(container as unknown as { getApiClient: typeof container.getApiClient }).getApiClient =
      originalGetApiClient
  })

  function createDashboardApp() {
    const app = new Hono<{ Variables: { apiClient?: ProxyApiClient } }>()
    app.use('*', async (c, next) => {
      c.set('apiClient', mockApiClient)
      await next()
    })
    app.route('/dashboard', tokenUsageRoutes)
    app.route('/public', publicTokenUsageRoutes)
    return app
  }

  it('shows threshold notice on /dashboard/token-usage overview only for over-threshold accounts', async () => {
    const app = createDashboardApp()
    const res = await app.request('/dashboard/token-usage')

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('data-testid="threshold-notice"')
    expect(body).toContain("account can't be used until reset")
    // Only one account is over threshold
    expect(body.match(/data-testid="threshold-notice"/g)?.length).toBe(1)
  })

  it('shows threshold notice on /dashboard/token-usage?accountId=... when over threshold and hides it otherwise', async () => {
    const app = createDashboardApp()

    const overRes = await app.request('/dashboard/token-usage?accountId=acct-over')
    expect(overRes.status).toBe(200)
    const overBody = await overRes.text()
    expect(overBody).toContain('data-testid="threshold-notice"')
    expect(overBody).toContain('5-Hour Window ≥ 90%')
    expect(overBody).toContain("account can't be used until reset")

    const okRes = await app.request('/dashboard/token-usage?accountId=acct-ok')
    expect(okRes.status).toBe(200)
    expect(await okRes.text()).not.toContain('data-testid="threshold-notice"')
  })

  it('shows threshold notice on /public/token-usage only for over-threshold accounts', async () => {
    const app = createDashboardApp()
    const res = await app.request('/public/token-usage')

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('data-testid="threshold-notice"')
    expect(body).toContain('5-Hour Window ≥ 90%')
    expect(body).toContain("account can't be used until reset")
    expect(body.match(/data-testid="threshold-notice"/g)?.length).toBe(1)
  })
})
