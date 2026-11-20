import type { BaseCredential, ProviderType } from '../types/credentials.js'
import type {
  AnthropicOAuthUsageResponse,
  OAuthLimitEntry,
  OAuthUsageThresholds,
} from '../types/oauth-usage.js'

/** Minimum linked Anthropic accounts required for automatic pool load balancing (ADR-031). */
export const ACCOUNT_POOL_MIN_ACCOUNTS = 2

/** Default 5-hour / session utilization threshold (0-1 scale, ADR-036). */
export const DEFAULT_FIVE_HOUR_THRESHOLD = 0.9

/** Default 7-day / weekly utilization threshold (0-1 scale, ADR-036). */
export const DEFAULT_SEVEN_DAY_THRESHOLD = 0.95

type ThresholdConfig = Pick<
  BaseCredential,
  'five_hour_limit_threshold' | 'seven_day_limit_threshold'
>

export interface OAuthUsageThresholdSummary {
  thresholds: OAuthUsageThresholds
  fiveHourOverThreshold: boolean
  sevenDayOverThreshold: boolean
  overThreshold: boolean
  overThresholdWindows: string[]
  blockedUntilIso: string | null
}

export interface ScopedLimitThresholdEvaluation {
  threshold: number
  overThreshold: boolean
}

/** Return the linked Anthropic credentials for a project, preserving account order. */
export function getLinkedAnthropicAccounts<T extends { id: string; provider: ProviderType }>(
  accounts: readonly T[],
  linkedAccountIds: readonly string[]
): T[] {
  const linkedIds = new Set(linkedAccountIds)
  return accounts.filter(account => account.provider === 'anthropic' && linkedIds.has(account.id))
}

/**
 * True when the project has enough linked Anthropic accounts to activate
 * AccountPoolService load balancing instead of falling back to default_account_id.
 */
export function hasActiveAccountPool(
  accounts: readonly { id: string; provider: ProviderType }[],
  linkedAccountIds: readonly string[]
): boolean {
  return getLinkedAnthropicAccounts(accounts, linkedAccountIds).length >= ACCOUNT_POOL_MIN_ACCOUNTS
}

export function getFiveHourThreshold(
  credential?: Pick<BaseCredential, 'five_hour_limit_threshold'> | null
): number {
  return Number(credential?.five_hour_limit_threshold ?? DEFAULT_FIVE_HOUR_THRESHOLD)
}

export function getSevenDayThreshold(
  credential?: Pick<BaseCredential, 'seven_day_limit_threshold'> | null
): number {
  return Number(credential?.seven_day_limit_threshold ?? DEFAULT_SEVEN_DAY_THRESHOLD)
}

/** Convert a 0-1 threshold ratio to a clean percentage (e.g. 0.9 -> 90, 0.95 -> 95). */
export function thresholdToPercent(threshold: number): number {
  return Math.round(threshold * 1000) / 10
}

export function isSessionLimit(limit: Pick<OAuthLimitEntry, 'kind' | 'group'>): boolean {
  const kind = limit.kind.toLowerCase()
  const group = limit.group?.toLowerCase() ?? ''
  return kind.includes('session') || kind.includes('hour') || group.includes('session')
}

/**
 * Evaluate account-wide OAuth usage windows against configured pool thresholds.
 * Mirrors AccountPoolService's gating and blocking-reset rules for all-model limits.
 */
export function evaluateOAuthUsageThresholds(
  usage: AnthropicOAuthUsageResponse,
  credential?: ThresholdConfig | null,
  now: number = Date.now()
): OAuthUsageThresholdSummary {
  const fiveHourThreshold = getFiveHourThreshold(credential)
  const sevenDayThreshold = getSevenDayThreshold(credential)

  let fiveHourOverThreshold = false
  let sevenDayOverThreshold = false
  const overThresholdWindows: string[] = []
  const blockingResets: string[] = []

  const addWindow = (label: string) => {
    if (!overThresholdWindows.includes(label)) {
      overThresholdWindows.push(label)
    }
  }

  if (usage.five_hour && usage.five_hour.utilization / 100 >= fiveHourThreshold) {
    fiveHourOverThreshold = true
    addWindow('5-Hour Window')
    if (usage.five_hour.resets_at) {
      blockingResets.push(usage.five_hour.resets_at)
    }
  }

  if (usage.seven_day && usage.seven_day.utilization / 100 >= sevenDayThreshold) {
    sevenDayOverThreshold = true
    addWindow('7-Day Window')
    if (usage.seven_day.resets_at) {
      blockingResets.push(usage.seven_day.resets_at)
    }
  }

  for (const limit of usage.limits ?? []) {
    if (!limit.is_active || limit.scope?.model) {
      continue
    }
    const session = isSessionLimit(limit)
    const threshold = session ? fiveHourThreshold : sevenDayThreshold
    if ((limit.percent ?? 0) / 100 >= threshold) {
      if (session) {
        fiveHourOverThreshold = true
        addWindow('5-Hour Window')
      } else {
        sevenDayOverThreshold = true
        addWindow('7-Day Window')
      }
      if (limit.resets_at) {
        blockingResets.push(limit.resets_at)
      }
    }
  }

  // An account blocked by multiple windows is eligible only after all blocking windows reset.
  const futureTimestamps = blockingResets
    .map(reset => new Date(reset).getTime())
    .filter(timestamp => Number.isFinite(timestamp) && timestamp > now)

  return {
    thresholds: {
      five_hour: thresholdToPercent(fiveHourThreshold),
      seven_day: thresholdToPercent(sevenDayThreshold),
    },
    fiveHourOverThreshold,
    sevenDayOverThreshold,
    overThreshold: overThresholdWindows.length > 0,
    overThresholdWindows,
    blockedUntilIso: futureTimestamps.length
      ? new Date(Math.max(...futureTimestamps)).toISOString()
      : null,
  }
}

/**
 * Evaluate a single model-scoped limit entry against the credential's window threshold.
 */
export function evaluateScopedLimitThreshold(
  limit: OAuthLimitEntry,
  credential?: ThresholdConfig | null
): ScopedLimitThresholdEvaluation {
  const rawThreshold = isSessionLimit(limit)
    ? getFiveHourThreshold(credential)
    : getSevenDayThreshold(credential)

  return {
    threshold: thresholdToPercent(rawThreshold),
    overThreshold: Boolean(limit.is_active) && (limit.percent ?? 0) / 100 >= rawThreshold,
  }
}
