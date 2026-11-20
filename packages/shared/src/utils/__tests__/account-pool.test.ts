import { describe, it, expect } from 'bun:test'
import {
  ACCOUNT_POOL_MIN_ACCOUNTS,
  DEFAULT_FIVE_HOUR_THRESHOLD,
  DEFAULT_SEVEN_DAY_THRESHOLD,
  getLinkedAnthropicAccounts,
  hasActiveAccountPool,
  getFiveHourThreshold,
  getSevenDayThreshold,
  thresholdToPercent,
  isSessionLimit,
  evaluateOAuthUsageThresholds,
  evaluateScopedLimitThreshold,
} from '../account-pool.js'
import type { AnthropicOAuthUsageResponse, OAuthLimitEntry } from '../../types/oauth-usage.js'

function makeUsage(
  overrides: Partial<AnthropicOAuthUsageResponse> = {}
): AnthropicOAuthUsageResponse {
  return {
    five_hour: { utilization: 40, resets_at: '2026-11-20T15:00:00.000Z' },
    seven_day: { utilization: 50, resets_at: '2026-11-25T00:00:00.000Z' },
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

describe('account-pool helpers', () => {
  describe('hasActiveAccountPool / getLinkedAnthropicAccounts', () => {
    const accounts = [
      { id: 'a1', provider: 'anthropic' as const, account_name: 'Anthropic 1' },
      { id: 'a2', provider: 'anthropic' as const, account_name: 'Anthropic 2' },
      { id: 'b1', provider: 'bedrock' as const, account_name: 'Bedrock 1' },
      { id: 'b2', provider: 'bedrock' as const, account_name: 'Bedrock 2' },
    ]

    it('returns false when fewer than 2 Anthropic accounts are linked', () => {
      expect(ACCOUNT_POOL_MIN_ACCOUNTS).toBe(2)
      expect(hasActiveAccountPool(accounts, [])).toBe(false)
      expect(hasActiveAccountPool(accounts, ['a1'])).toBe(false)
      expect(hasActiveAccountPool(accounts, ['a1', 'b1'])).toBe(false)
      expect(hasActiveAccountPool(accounts, ['b1', 'b2'])).toBe(false)
    })

    it('returns true and filters to Anthropic accounts when 2+ Anthropic accounts are linked', () => {
      expect(hasActiveAccountPool(accounts, ['a1', 'a2'])).toBe(true)
      expect(hasActiveAccountPool(accounts, ['a1', 'a2', 'b1'])).toBe(true)

      const linked = getLinkedAnthropicAccounts(accounts, ['a2', 'b1', 'a1'])
      expect(linked.map(a => a.id)).toEqual(['a1', 'a2'])
    })
  })

  describe('threshold helpers', () => {
    it('falls back to default thresholds when credential fields are absent', () => {
      expect(getFiveHourThreshold()).toBe(DEFAULT_FIVE_HOUR_THRESHOLD)
      expect(getSevenDayThreshold()).toBe(DEFAULT_SEVEN_DAY_THRESHOLD)
      expect(getFiveHourThreshold(null)).toBe(0.9)
      expect(getSevenDayThreshold(null)).toBe(0.95)
    })

    it('coerces DECIMAL string thresholds from PostgreSQL cleanly', () => {
      const pgRow = {
        five_hour_limit_threshold: '0.80' as unknown as number,
        seven_day_limit_threshold: '0.85' as unknown as number,
      }
      expect(getFiveHourThreshold(pgRow)).toBe(0.8)
      expect(getSevenDayThreshold(pgRow)).toBe(0.85)
    })

    it('formats ratios as clean percentages without floating-point drift', () => {
      expect(thresholdToPercent(0.9)).toBe(90)
      expect(thresholdToPercent(0.95)).toBe(95)
      expect(thresholdToPercent(0.57)).toBe(57)
      expect(thresholdToPercent(0.875)).toBe(87.5)
    })

    it('identifies session vs weekly limit entries', () => {
      expect(isSessionLimit({ kind: 'session', group: 'session' })).toBe(true)
      expect(isSessionLimit({ kind: 'five_hour', group: null })).toBe(true)
      expect(isSessionLimit({ kind: 'weekly_all', group: 'weekly' })).toBe(false)
      expect(isSessionLimit({ kind: 'weekly_scoped', group: 'weekly' })).toBe(false)
    })
  })

  describe('evaluateOAuthUsageThresholds', () => {
    const now = Date.parse('2026-11-20T12:00:00.000Z')

    it('reports below threshold when both 5h and 7d are under default gates', () => {
      const result = evaluateOAuthUsageThresholds(
        makeUsage({
          five_hour: { utilization: 89.9, resets_at: '2026-11-20T15:00:00.000Z' },
          seven_day: { utilization: 94.9, resets_at: '2026-11-25T00:00:00.000Z' },
        }),
        null,
        now
      )

      expect(result).toEqual({
        thresholds: { five_hour: 90, seven_day: 95 },
        fiveHourOverThreshold: false,
        sevenDayOverThreshold: false,
        overThreshold: false,
        overThresholdWindows: [],
        blockedUntilIso: null,
      })
    })

    it('flags 5-hour window at or above threshold with its reset time', () => {
      const result = evaluateOAuthUsageThresholds(
        makeUsage({
          five_hour: { utilization: 90, resets_at: '2026-11-20T15:00:00.000Z' },
          seven_day: { utilization: 50, resets_at: '2026-11-25T00:00:00.000Z' },
        }),
        null,
        now
      )

      expect(result.overThreshold).toBe(true)
      expect(result.fiveHourOverThreshold).toBe(true)
      expect(result.sevenDayOverThreshold).toBe(false)
      expect(result.overThresholdWindows).toEqual(['5-Hour Window'])
      expect(result.blockedUntilIso).toBe('2026-11-20T15:00:00.000Z')
    })

    it('flags 7-day window at or above custom threshold', () => {
      const result = evaluateOAuthUsageThresholds(
        makeUsage({
          five_hour: { utilization: 20, resets_at: '2026-11-20T15:00:00.000Z' },
          seven_day: { utilization: 86, resets_at: '2026-11-25T00:00:00.000Z' },
        }),
        { five_hour_limit_threshold: 0.8, seven_day_limit_threshold: 0.85 },
        now
      )

      expect(result.thresholds).toEqual({ five_hour: 80, seven_day: 85 })
      expect(result.overThreshold).toBe(true)
      expect(result.fiveHourOverThreshold).toBe(false)
      expect(result.sevenDayOverThreshold).toBe(true)
      expect(result.overThresholdWindows).toEqual(['7-Day Window'])
      expect(result.blockedUntilIso).toBe('2026-11-25T00:00:00.000Z')
    })

    it('picks the latest blocking reset when both 5h and 7d exceed threshold', () => {
      const result = evaluateOAuthUsageThresholds(
        makeUsage({
          five_hour: { utilization: 92, resets_at: '2026-11-20T15:00:00.000Z' },
          seven_day: { utilization: 97, resets_at: '2026-11-25T00:00:00.000Z' },
        }),
        null,
        now
      )

      expect(result.overThreshold).toBe(true)
      expect(result.overThresholdWindows).toEqual(['5-Hour Window', '7-Day Window'])
      expect(result.blockedUntilIso).toBe('2026-11-25T00:00:00.000Z')
    })

    it('returns null blockedUntilIso when blocking reset timestamp is in the past', () => {
      const result = evaluateOAuthUsageThresholds(
        makeUsage({
          five_hour: { utilization: 95, resets_at: '2026-11-20T11:00:00.000Z' },
        }),
        null,
        now
      )

      expect(result.overThreshold).toBe(true)
      expect(result.blockedUntilIso).toBeNull()
    })

    it('does not treat model-scoped limits as account-wide blocks', () => {
      const result = evaluateOAuthUsageThresholds(
        makeUsage({
          five_hour: { utilization: 20, resets_at: '2026-11-20T15:00:00.000Z' },
          seven_day: { utilization: 30, resets_at: '2026-11-25T00:00:00.000Z' },
          limits: [
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: 100,
              severity: 'exceeded',
              resets_at: '2026-11-26T00:00:00.000Z',
              scope: { model: { id: null, display_name: 'Fable' }, surface: null },
              is_active: true,
            },
          ],
        }),
        null,
        now
      )

      expect(result.overThreshold).toBe(false)
      expect(result.overThresholdWindows).toEqual([])
      expect(result.blockedUntilIso).toBeNull()
    })

    it('evaluates unscoped active limits[] entries against window thresholds', () => {
      const result = evaluateOAuthUsageThresholds(
        makeUsage({
          five_hour: null,
          seven_day: null,
          limits: [
            {
              kind: 'weekly_all',
              group: 'weekly',
              percent: 96,
              severity: 'warning',
              resets_at: '2026-11-25T00:00:00.000Z',
              scope: null,
              is_active: true,
            },
          ],
        }),
        null,
        now
      )

      expect(result.overThreshold).toBe(true)
      expect(result.sevenDayOverThreshold).toBe(true)
      expect(result.overThresholdWindows).toEqual(['7-Day Window'])
      expect(result.blockedUntilIso).toBe('2026-11-25T00:00:00.000Z')
    })
  })

  describe('evaluateScopedLimitThreshold', () => {
    const baseScopedLimit: OAuthLimitEntry = {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 96,
      severity: 'exceeded',
      resets_at: '2026-11-26T00:00:00.000Z',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: true,
    }

    it('marks active scoped limit over threshold when percent >= threshold', () => {
      expect(evaluateScopedLimitThreshold(baseScopedLimit)).toEqual({
        threshold: 95,
        overThreshold: true,
      })
    })

    it('does not mark inactive scoped limit as over threshold', () => {
      expect(evaluateScopedLimitThreshold({ ...baseScopedLimit, is_active: false })).toEqual({
        threshold: 95,
        overThreshold: false,
      })
    })

    it('uses 5-hour threshold for session-scoped limits', () => {
      expect(
        evaluateScopedLimitThreshold(
          { ...baseScopedLimit, kind: 'session_scoped', group: 'session', percent: 91 },
          { five_hour_limit_threshold: 0.9, seven_day_limit_threshold: 0.95 }
        )
      ).toEqual({
        threshold: 90,
        overThreshold: true,
      })
    })
  })
})
