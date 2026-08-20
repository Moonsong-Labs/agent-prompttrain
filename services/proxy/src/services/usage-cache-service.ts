import type { Pool } from 'pg'
import type { AnthropicCredential, AnthropicOAuthUsageResponse } from '@agent-prompttrain/shared'
import { getApiKey } from '../credentials'
import { logger } from '../middleware/logger'
import { AccountPoolStateService, type SharedUsageState } from './account-pool-state-service'

export interface CachedUsageEntry {
  usage: AnthropicOAuthUsageResponse | null
  fetchedAt: number
  isEstimated: boolean
  lastSuccessfulUsage?: AnthropicOAuthUsageResponse
  nextRefreshAt?: number
  failureCount?: number
}

const USAGE_CACHE_TTL_MS = 300_000
const BACKGROUND_REFRESH_AT_MS = USAGE_CACHE_TTL_MS * 0.8
const EXTRAPOLATION_RATE_PER_10MIN = 2
const EXTRAPOLATION_CAP = 100
const FAILURE_BACKOFF_BASE_MS = 30_000
const FAILURE_BACKOFF_MAX_MS = 900_000
const SHARED_REFRESH_WAIT_MS = 100
const SHARED_REFRESH_WAIT_ATTEMPTS = 20

const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

/**
 * Shared Anthropic OAuth usage cache. PostgreSQL owns durable successful data,
 * refresh leases, and failure backoff; the local map is only a hot cache.
 */
export class UsageCacheService {
  private readonly cache = new Map<string, CachedUsageEntry>()
  private readonly inFlight = new Map<string, Promise<CachedUsageEntry | null>>()
  private readonly localLastForceRefresh = new Map<string, number>()
  readonly stateService: AccountPoolStateService

  constructor(
    private readonly pool?: Pool | null,
    stateService?: AccountPoolStateService
  ) {
    this.stateService = stateService ?? new AccountPoolStateService(pool)
  }

  async getUsage(credential: AnthropicCredential): Promise<CachedUsageEntry | null> {
    if (!this.stateService.isPersistent) {
      return this.getUsageLocally(credential)
    }

    const now = Date.now()
    const local = this.cache.get(credential.id)
    if (local?.fetchedAt && now - local.fetchedAt < BACKGROUND_REFRESH_AT_MS) {
      return local
    }

    const shared = await this.stateService.getUsageState(credential.id)
    const sharedEntry = shared ? this.entryFromSharedState(shared) : null
    if (sharedEntry) {
      this.cache.set(credential.id, sharedEntry)
    }

    const entry = sharedEntry ?? local ?? null
    const age = entry?.fetchedAt ? now - entry.fetchedAt : Number.POSITIVE_INFINITY
    const refreshDue = !shared?.nextRefreshAt || shared.nextRefreshAt <= now

    if (!refreshDue) {
      return entry
    }

    if (entry && age < USAGE_CACHE_TTL_MS) {
      this.triggerBackgroundRefresh(credential)
      return entry
    }

    const refreshed = await this.fetchWithDeduplication(credential)
    if (refreshed) {
      return refreshed
    }

    if (entry) {
      return entry
    }

    return this.waitForSharedRefresh(credential.id)
  }

  async getUsageMultiple(
    credentials: AnthropicCredential[]
  ): Promise<Map<string, CachedUsageEntry>> {
    const entries = await Promise.all(
      credentials.map(async credential => ({
        id: credential.id,
        entry: await this.getUsage(credential),
      }))
    )
    const results = new Map<string, CachedUsageEntry>()
    for (const { id, entry } of entries) {
      if (entry) {
        results.set(id, entry)
      }
    }
    return results
  }

  async forceRefresh(credential: AnthropicCredential): Promise<CachedUsageEntry | null> {
    if (!this.stateService.isPersistent) {
      const now = Date.now()
      const lastForceRefresh = this.localLastForceRefresh.get(credential.id) ?? 0
      if (now - lastForceRefresh < 30_000) {
        return this.cache.get(credential.id) ?? null
      }
      this.localLastForceRefresh.set(credential.id, now)
      return this.fetchWithDeduplication(credential, true)
    }

    const refreshed = await this.fetchWithDeduplication(credential, true)
    if (refreshed) {
      return refreshed
    }
    const shared = await this.stateService.getUsageState(credential.id)
    return shared ? this.entryFromSharedState(shared) : (this.cache.get(credential.id) ?? null)
  }

  getCachedUsage(credentialId: string): CachedUsageEntry | null {
    return this.cache.get(credentialId) ?? null
  }

  async getLastKnownUsage(credentialId: string): Promise<CachedUsageEntry | null> {
    const local = this.cache.get(credentialId)
    if (local) {
      return local
    }
    const shared = await this.stateService.getUsageState(credentialId)
    return shared ? this.entryFromSharedState(shared) : null
  }

  clearCache(): void {
    this.cache.clear()
    this.inFlight.clear()
    this.localLastForceRefresh.clear()
  }

  private async getUsageLocally(credential: AnthropicCredential): Promise<CachedUsageEntry | null> {
    const cached = this.cache.get(credential.id)
    const now = Date.now()
    if (cached?.fetchedAt) {
      const age = now - cached.fetchedAt
      if (age < BACKGROUND_REFRESH_AT_MS) {
        return cached
      }
      if (age < USAGE_CACHE_TTL_MS) {
        this.triggerBackgroundRefresh(credential)
        return cached
      }
    }
    return this.fetchWithDeduplication(credential)
  }

  private triggerBackgroundRefresh(credential: AnthropicCredential): void {
    if (this.inFlight.has(credential.id)) {
      return
    }
    this.fetchWithDeduplication(credential).catch(() => undefined)
  }

  private async fetchWithDeduplication(
    credential: AnthropicCredential,
    force = false
  ): Promise<CachedUsageEntry | null> {
    const existing = this.inFlight.get(credential.id)
    if (existing) {
      return existing
    }

    const promise = this.refreshUsage(credential, force)
    this.inFlight.set(credential.id, promise)
    try {
      return await promise
    } finally {
      this.inFlight.delete(credential.id)
    }
  }

  private async refreshUsage(
    credential: AnthropicCredential,
    force: boolean
  ): Promise<CachedUsageEntry | null> {
    if (this.stateService.isPersistent) {
      const claimed = await this.stateService.claimUsageRefresh(credential.id, force)
      if (!claimed) {
        const shared = await this.stateService.getUsageState(credential.id)
        return shared ? this.entryFromSharedState(shared) : null
      }
    }

    return this.doFetch(credential)
  }

  private async doFetch(credential: AnthropicCredential): Promise<CachedUsageEntry | null> {
    try {
      const token = await getApiKey(credential.id, this.pool as Pool)
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
            retryAfter: response.headers.get('retry-after'),
            error: errorText,
          },
        })
        return this.handleFetchFailure(
          credential.id,
          this.parseRetryAfter(response.headers.get('retry-after'))
        )
      }

      const usage = (await response.json()) as AnthropicOAuthUsageResponse
      const now = Date.now()
      const nextRefreshAt = now + BACKGROUND_REFRESH_AT_MS
      const entry: CachedUsageEntry = {
        usage,
        fetchedAt: now,
        isEstimated: false,
        lastSuccessfulUsage: usage,
        nextRefreshAt,
        failureCount: 0,
      }

      this.cache.set(credential.id, entry)
      if (this.stateService.isPersistent) {
        await this.stateService.saveUsageSuccess(credential.id, usage, now, nextRefreshAt)
      }
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

  private async handleFetchFailure(
    credentialId: string,
    retryAfterMs: number | null = null
  ): Promise<CachedUsageEntry | null> {
    let cached = this.cache.get(credentialId) ?? null
    let failureCount = cached?.failureCount ?? 0

    if (this.stateService.isPersistent) {
      const shared = await this.stateService.getUsageState(credentialId)
      if (shared) {
        cached = this.entryFromSharedState(shared)
        failureCount = shared.failureCount
      }

      const backoff = this.failureBackoffMs(failureCount + 1)
      const nextRefreshAt = Date.now() + Math.max(backoff, retryAfterMs ?? 0)
      const persistedFailureCount = await this.stateService.saveUsageFailure(
        credentialId,
        nextRefreshAt
      )

      if (!cached?.lastSuccessfulUsage || !cached.fetchedAt) {
        return null
      }
      const estimated = this.extrapolate(cached, nextRefreshAt, persistedFailureCount)
      this.cache.set(credentialId, estimated)
      return estimated
    }

    if (!cached?.lastSuccessfulUsage || !cached.fetchedAt) {
      return null
    }
    const estimated = this.extrapolate(
      cached,
      Date.now() + FAILURE_BACKOFF_BASE_MS,
      failureCount + 1
    )
    this.cache.set(credentialId, estimated)
    return estimated
  }

  private entryFromSharedState(shared: SharedUsageState): CachedUsageEntry | null {
    if (!shared.usage || !shared.fetchedAt) {
      return null
    }
    const base: CachedUsageEntry = {
      usage: shared.usage,
      fetchedAt: shared.fetchedAt,
      isEstimated: false,
      lastSuccessfulUsage: shared.usage,
      nextRefreshAt: shared.nextRefreshAt,
      failureCount: shared.failureCount,
    }
    return shared.failureCount > 0
      ? this.extrapolate(base, shared.nextRefreshAt, shared.failureCount)
      : base
  }

  private extrapolate(
    cached: CachedUsageEntry,
    nextRefreshAt: number,
    failureCount: number
  ): CachedUsageEntry {
    const base = cached.lastSuccessfulUsage
    if (!base) {
      throw new Error('Cannot extrapolate usage without a successful baseline')
    }
    const elapsedMinutes = Math.max(0, Date.now() - cached.fetchedAt) / 60_000
    const increase = (elapsedMinutes / 10) * EXTRAPOLATION_RATE_PER_10MIN
    const extrapolateValue = (value: number): number =>
      Math.min(EXTRAPOLATION_CAP, value + increase)
    const extrapolateWindow = (
      window: { utilization: number; resets_at: string } | null | undefined
    ) =>
      window
        ? { utilization: extrapolateValue(window.utilization), resets_at: window.resets_at }
        : window

    const usage: AnthropicOAuthUsageResponse = {
      five_hour: extrapolateWindow(base.five_hour) ?? null,
      seven_day: extrapolateWindow(base.seven_day) ?? null,
      seven_day_oauth_apps: extrapolateWindow(base.seven_day_oauth_apps) ?? null,
      seven_day_opus: extrapolateWindow(base.seven_day_opus) ?? null,
      seven_day_sonnet: extrapolateWindow(base.seven_day_sonnet) ?? null,
      iguana_necktie: extrapolateWindow(base.iguana_necktie) ?? null,
      limits: base.limits?.map(limit => ({
        ...limit,
        percent: limit.percent === null ? null : extrapolateValue(limit.percent),
      })),
      extra_usage: base.extra_usage,
    }

    return {
      usage,
      fetchedAt: cached.fetchedAt,
      isEstimated: true,
      lastSuccessfulUsage: base,
      nextRefreshAt,
      failureCount,
    }
  }

  private failureBackoffMs(failureCount: number): number {
    const exponential = Math.min(
      FAILURE_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, failureCount - 1)),
      FAILURE_BACKOFF_MAX_MS
    )
    return Math.floor(exponential * (1 + Math.random() * 0.25))
  }

  private parseRetryAfter(value: string | null): number | null {
    if (!value) {
      return null
    }
    const seconds = Number(value)
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000)
    }
    const timestamp = new Date(value).getTime()
    return Number.isNaN(timestamp) ? null : Math.max(0, timestamp - Date.now())
  }

  private async waitForSharedRefresh(credentialId: string): Promise<CachedUsageEntry | null> {
    for (let attempt = 0; attempt < SHARED_REFRESH_WAIT_ATTEMPTS; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, SHARED_REFRESH_WAIT_MS))
      const shared = await this.stateService.getUsageState(credentialId)
      const entry = shared ? this.entryFromSharedState(shared) : null
      if (entry) {
        this.cache.set(credentialId, entry)
        return entry
      }
    }
    return null
  }
}
