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
      if (!window) {
        return window
      }
      return {
        utilization: Math.min(EXTRAPOLATION_CAP, window.utilization + increase),
        resets_at: window.resets_at,
      }
    }

    const extrapolated: AnthropicOAuthUsageResponse = {
      five_hour: extrapolateWindow(base.five_hour) ?? null,
      seven_day: extrapolateWindow(base.seven_day) ?? null,
      seven_day_oauth_apps: extrapolateWindow(base.seven_day_oauth_apps) ?? null,
      seven_day_opus: extrapolateWindow(base.seven_day_opus) ?? null,
      seven_day_sonnet: extrapolateWindow(base.seven_day_sonnet) ?? null,
      iguana_necktie: extrapolateWindow(base.iguana_necktie) ?? null,
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
