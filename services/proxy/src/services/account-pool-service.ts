import { Pool } from 'pg'
import type {
  Credential,
  AnthropicCredential,
  AnthropicOAuthUsageResponse,
} from '@agent-prompttrain/shared'
import {
  getProjectLinkedCredentials,
  getProjectCredentials,
} from '@agent-prompttrain/shared/database/queries'
import { UsageCacheService, type CachedUsageEntry } from './usage-cache-service'
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
  /** Highest utilization across 5h and 7d windows (0-1, normalized) */
  maxUtilization: number
  /** True if selected from a multi-account pool, false if using default account */
  fromPool: boolean
}

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

  constructor(
    private readonly pool: Pool,
    private readonly usageCacheService: UsageCacheService
  ) {}

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
    // Try pool mode: check if project has 2+ linked accounts
    let linkedCredentials: Credential[] = []
    try {
      linkedCredentials = await getProjectLinkedCredentials(this.pool, projectId)
    } catch {
      // project_accounts table may not exist yet — fall back to default account
    }

    // Filter to Anthropic accounts (only these support usage checks for pool mode)
    const anthropicCredentials = linkedCredentials.filter(
      (c): c is AnthropicCredential => c.provider === 'anthropic'
    )

    // Pool mode requires 2+ Anthropic accounts; otherwise use default account
    if (anthropicCredentials.length < 2) {
      return this.selectDefaultAccount(projectId)
    }

    // Check sticky account first
    const stickyCredentialId = this.stickyMap.get(projectId)
    if (stickyCredentialId) {
      const stickyCredential = anthropicCredentials.find(c => c.id === stickyCredentialId)
      if (stickyCredential) {
        const cachedEntry = await this.usageCacheService.getUsage(stickyCredential)
        const maxUtilization = this.computeMaxUtilization(cachedEntry?.usage ?? null)

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
    const usageMap = await this.usageCacheService.getUsageMultiple(anthropicCredentials)
    const usageResults = anthropicCredentials.map(credential => {
      const entry = usageMap.get(credential.id)
      const maxUtilization = this.computeMaxUtilization(entry?.usage ?? null)
      return { credential, maxUtilization }
    })

    // Filter to accounts under their respective thresholds
    const available = usageResults.filter(
      ({ credential, maxUtilization }) => maxUtilization < credential.token_limit_threshold
    )

    if (available.length === 0) {
      // Find the earliest reset time across all accounts for the error
      const estimatedReset = this.findEarliestReset(anthropicCredentials, usageMap)

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
   * Returns 1 (treat as over threshold) if usage data is null (conservative).
   */
  private computeMaxUtilization(usage: AnthropicOAuthUsageResponse | null): number {
    if (!usage) {
      return 1
    }

    // API returns utilization as 0-100, normalize to 0-1 to match token_limit_threshold
    const fiveHour = (usage.five_hour?.utilization ?? 0) / 100
    const sevenDay = (usage.seven_day?.utilization ?? 0) / 100
    return Math.max(fiveHour, sevenDay)
  }

  /**
   * Find the earliest reset time from cached usage data for the given credentials.
   * Returns null if no reset times are available.
   */
  private findEarliestReset(
    credentials: AnthropicCredential[],
    usageMap: Map<string, CachedUsageEntry>
  ): string | null {
    let earliest: string | null = null

    for (const credential of credentials) {
      const cached = usageMap.get(credential.id)
      if (!cached?.usage) {
        continue
      }

      const resetTimes = [
        cached.usage.five_hour?.resets_at,
        cached.usage.seven_day?.resets_at,
      ].filter((t): t is string => t !== null && t !== undefined)

      for (const resetTime of resetTimes) {
        if (!earliest || new Date(resetTime).getTime() < new Date(earliest).getTime()) {
          earliest = resetTime
        }
      }
    }

    return earliest
  }

  /**
   * Clear sticky routing state. Useful for testing.
   */
  clearStickyState(): void {
    this.stickyMap.clear()
  }
}
