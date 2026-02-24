import { Pool } from 'pg'
import type { Credential, AnthropicCredential, OAuthUsageData } from '@agent-prompttrain/shared'
import {
  getProjectLinkedCredentials,
  getProjectCredentials,
} from '@agent-prompttrain/shared/database/queries'
import { getApiKey } from '../credentials'
import { logger } from '../middleware/logger'

/**
 * Thrown when all accounts in a pool have exceeded their utilization threshold.
 */
export class AccountPoolExhaustedError extends Error {
  readonly statusCode = 429
  readonly estimatedReset: string | null

  constructor(message: string, estimatedReset: string | null = null) {
    super(message)
    this.name = 'AccountPoolExhaustedError'
    this.estimatedReset = estimatedReset
  }
}

/**
 * Result of selecting an account from the pool.
 */
export interface AccountSelection {
  /** The selected credential to use for the request */
  credential: Credential
  /** Highest utilization across 5h and 7d windows (0-100) */
  maxUtilization: number
  /** True if selected from a multi-account pool, false if using default account */
  fromPool: boolean
}

interface UsageCacheEntry {
  usage: OAuthUsageData
  fetchedAt: number
}

const USAGE_CACHE_TTL_MS = 60_000

/**
 * AccountPoolService selects the best account for a project based on real-time
 * OAuth utilization data from the Anthropic API. When a project has 2+ linked
 * accounts, it automatically switches to the least-utilized account that is
 * still under its configured threshold.
 *
 * Uses sticky routing to maintain account affinity per project until the
 * current account exceeds its threshold.
 */
export class AccountPoolService {
  /** Sticky mapping: projectId -> credentialId */
  private stickyMap: Map<string, string> = new Map()

  /** Usage cache: credentialId -> { usage, fetchedAt } */
  private usageCache: Map<string, UsageCacheEntry> = new Map()

  constructor(private readonly pool: Pool) {}

  /**
   * Select the best account for a project.
   *
   * If the project has fewer than 2 linked accounts, falls back to the
   * project's default account (non-pool mode).
   *
   * If the project has 2+ linked accounts, enters pool mode:
   * 1. Checks sticky account first and reuses it if under threshold
   * 2. If sticky is over threshold, evaluates all linked Anthropic accounts
   * 3. Picks the account with the lowest max utilization that is under threshold
   * 4. Throws AccountPoolExhaustedError if no accounts are available
   */
  async selectAccount(projectId: string): Promise<AccountSelection> {
    const linkedCredentials = await getProjectLinkedCredentials(this.pool, projectId)

    // If fewer than 2 linked accounts, use default account (non-pool mode)
    if (linkedCredentials.length < 2) {
      return this.selectDefaultAccount(projectId)
    }

    // Pool mode: filter to Anthropic accounts for usage checks
    const anthropicCredentials = linkedCredentials.filter(
      (c): c is AnthropicCredential => c.provider === 'anthropic'
    )

    // If all linked accounts are Bedrock (no Anthropic accounts for usage checks),
    // fall back to default account
    if (anthropicCredentials.length === 0) {
      logger.info('All linked accounts are Bedrock, falling back to default account', {
        metadata: { projectId, linkedCount: linkedCredentials.length },
      })
      return this.selectDefaultAccount(projectId)
    }

    // Check sticky account first
    const stickyCredentialId = this.stickyMap.get(projectId)
    if (stickyCredentialId) {
      const stickyCredential = anthropicCredentials.find(c => c.id === stickyCredentialId)
      if (stickyCredential) {
        const usage = await this.fetchUsage(stickyCredential)
        const maxUtilization = this.computeMaxUtilization(usage)

        if (maxUtilization < stickyCredential.token_limit_threshold) {
          logger.debug('Reusing sticky account (under threshold)', {
            metadata: {
              projectId,
              accountId: stickyCredential.account_id,
              maxUtilization,
              threshold: stickyCredential.token_limit_threshold,
            },
          })
          return {
            credential: stickyCredential,
            maxUtilization,
            fromPool: true,
          }
        }

        logger.info('Sticky account over threshold, searching pool', {
          metadata: {
            projectId,
            accountId: stickyCredential.account_id,
            maxUtilization,
            threshold: stickyCredential.token_limit_threshold,
          },
        })
      }
    }

    // Fetch usage for all Anthropic accounts in parallel
    const usageResults = await Promise.all(
      anthropicCredentials.map(async credential => {
        const usage = await this.fetchUsage(credential)
        const maxUtilization = this.computeMaxUtilization(usage)
        return { credential, maxUtilization }
      })
    )

    // Filter to accounts under their respective thresholds
    const available = usageResults.filter(
      ({ credential, maxUtilization }) => maxUtilization < credential.token_limit_threshold
    )

    if (available.length === 0) {
      // Find the earliest reset time across all accounts for the error
      const estimatedReset = this.findEarliestReset(anthropicCredentials)

      logger.warn('All accounts in pool exhausted', {
        metadata: {
          projectId,
          accountCount: anthropicCredentials.length,
          utilizations: usageResults.map(r => ({
            accountId: r.credential.account_id,
            maxUtilization: r.maxUtilization,
            threshold: r.credential.token_limit_threshold,
          })),
          estimatedReset,
        },
      })

      throw new AccountPoolExhaustedError(
        `All ${anthropicCredentials.length} accounts in pool for project "${projectId}" have exceeded their utilization threshold`,
        estimatedReset
      )
    }

    // Pick the account with the lowest max utilization
    available.sort((a, b) => a.maxUtilization - b.maxUtilization)
    const best = available[0]

    // Update sticky map
    this.stickyMap.set(projectId, best.credential.id)

    logger.info('Selected account from pool', {
      metadata: {
        projectId,
        accountId: best.credential.account_id,
        maxUtilization: best.maxUtilization,
        threshold: best.credential.token_limit_threshold,
        poolSize: anthropicCredentials.length,
        availableCount: available.length,
      },
    })

    return {
      credential: best.credential,
      maxUtilization: best.maxUtilization,
      fromPool: true,
    }
  }

  /**
   * Fall back to the project's default account (non-pool mode).
   */
  private async selectDefaultAccount(projectId: string): Promise<AccountSelection> {
    const credentials = await getProjectCredentials(this.pool, projectId)

    if (credentials.length === 0) {
      throw new Error(`No default credential found for project "${projectId}"`)
    }

    const credential = credentials[0]
    return {
      credential,
      maxUtilization: 0,
      fromPool: false,
    }
  }

  /**
   * Compute the maximum utilization across 5-hour and 7-day windows.
   * Returns 100 (treat as over threshold) if usage data is null (conservative).
   */
  private computeMaxUtilization(usage: OAuthUsageData | null): number {
    if (!usage) {
      return 100
    }

    return Math.max(usage.five_hour?.utilization ?? 0, usage.seven_day?.utilization ?? 0)
  }

  /**
   * Find the earliest reset time from cached usage data for the given credentials.
   * Returns null if no reset times are available.
   */
  private findEarliestReset(credentials: AnthropicCredential[]): string | null {
    let earliest: string | null = null

    for (const credential of credentials) {
      const cached = this.usageCache.get(credential.id)
      if (!cached) {
        continue
      }

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

  /**
   * Fetch OAuth usage data for an Anthropic credential.
   * Results are cached with a 60-second TTL per account.
   *
   * On error, logs a warning and returns null (conservative approach:
   * the caller treats null as over-threshold).
   */
  private async fetchUsage(credential: AnthropicCredential): Promise<OAuthUsageData | null> {
    // Check cache
    const cached = this.usageCache.get(credential.id)
    if (cached && Date.now() - cached.fetchedAt < USAGE_CACHE_TTL_MS) {
      return cached.usage
    }

    try {
      // Get a fresh OAuth token (handles refresh automatically)
      const token = await getApiKey(credential.id, this.pool)
      if (!token) {
        logger.warn('Failed to get OAuth token for usage fetch', {
          metadata: {
            accountId: credential.account_id,
            credentialId: credential.id,
          },
        })
        return null
      }

      const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'anthropic-beta': 'oauth-2025-04-20',
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
        return null
      }

      const rawData = (await response.json()) as {
        five_hour?: { utilization: number; resets_at: string } | null
        seven_day?: { utilization: number; resets_at: string } | null
        seven_day_opus?: { utilization: number; resets_at: string } | null
        seven_day_sonnet?: { utilization: number; resets_at: string } | null
      }

      const usage: OAuthUsageData = {
        five_hour: rawData.five_hour ?? null,
        seven_day: rawData.seven_day ?? null,
        seven_day_opus: rawData.seven_day_opus ?? null,
        seven_day_sonnet: rawData.seven_day_sonnet ?? null,
      }

      // Update cache
      this.usageCache.set(credential.id, {
        usage,
        fetchedAt: Date.now(),
      })

      return usage
    } catch (error) {
      logger.warn('Error fetching OAuth usage', {
        metadata: {
          accountId: credential.account_id,
          credentialId: credential.id,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      return null
    }
  }

  /**
   * Clear sticky routing state. Useful for testing.
   */
  clearStickyState(): void {
    this.stickyMap.clear()
  }

  /**
   * Clear the usage cache. Useful for testing.
   */
  clearUsageCache(): void {
    this.usageCache.clear()
  }
}
