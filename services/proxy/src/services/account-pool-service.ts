import type { Pool } from 'pg'
import {
  getRetryAfter,
  type Credential,
  type AnthropicCredential,
  type AnthropicOAuthUsageResponse,
  type OAuthLimitEntry,
  type UpstreamError,
} from '@agent-prompttrain/shared'
import {
  getProjectLinkedCredentials,
  getProjectCredentials,
} from '@agent-prompttrain/shared/database/queries'
import { UsageCacheService, type CachedUsageEntry } from './usage-cache-service'
import { AccountPoolStateService, type AccountCandidate } from './account-pool-state-service'
import { logger } from '../middleware/logger'

const DEFAULT_FIVE_HOUR_THRESHOLD = 0.9
const DEFAULT_SEVEN_DAY_THRESHOLD = 0.95
const FALLBACK_COOLDOWN_MS = 60_000

export class AccountPoolExhaustedError extends Error {
  readonly statusCode = 429
  readonly retryAfterSeconds: number | null

  constructor(
    message: string,
    readonly estimatedReset: string | null = null
  ) {
    super(message)
    this.name = 'AccountPoolExhaustedError'
    this.retryAfterSeconds = estimatedReset
      ? Math.max(0, Math.ceil((new Date(estimatedReset).getTime() - Date.now()) / 1000))
      : null
  }
}

export interface AccountSelection {
  credential: Credential
  maxUtilization: number
  fromPool: boolean
  reserved: boolean
}

export interface AccountSelectionOptions {
  excludeCredentialIds?: string[]
}

interface UsageEvaluation {
  maxUtilization: number
  pressure: number
  available: boolean
}

/** Selects and reserves Anthropic accounts using shared PostgreSQL state. */
export class AccountPoolService {
  private readonly stateService: AccountPoolStateService

  constructor(
    private readonly pool: Pool,
    private readonly usageCacheService: UsageCacheService,
    stateService?: AccountPoolStateService
  ) {
    this.stateService = stateService ?? usageCacheService.stateService
  }

  async selectAccount(
    projectId: string,
    model?: string,
    options: AccountSelectionOptions = {}
  ): Promise<AccountSelection> {
    let linkedCredentials: Credential[] = []
    try {
      linkedCredentials = await getProjectLinkedCredentials(this.pool, projectId)
    } catch {
      // A rolling deployment may not have project_accounts yet.
    }

    const allAnthropicCredentials = linkedCredentials.filter(
      (credential): credential is AnthropicCredential => credential.provider === 'anthropic'
    )
    const excluded = new Set(options.excludeCredentialIds ?? [])

    if (allAnthropicCredentials.length < 2) {
      return this.selectDefaultAccount(projectId, model, excluded)
    }

    const credentials = allAnthropicCredentials.filter(credential => !excluded.has(credential.id))
    const usageMap = await this.usageCacheService.getUsageMultiple(credentials)
    const evaluated = credentials.map(credential => ({
      credential,
      evaluation: this.evaluateUsage(credential, usageMap.get(credential.id)?.usage ?? null, model),
    }))
    const available = evaluated.filter(result => result.evaluation.available)

    if (available.length === 0) {
      const estimatedReset = this.findEarliestReset(credentials, usageMap, model)
      this.logExhaustion(projectId, evaluated, estimatedReset)
      throw new AccountPoolExhaustedError(
        `All ${allAnthropicCredentials.length} accounts in pool for project "${projectId}" are unavailable or over their utilization thresholds`,
        estimatedReset
      )
    }

    const candidates: AccountCandidate[] = available.map(({ credential, evaluation }) => ({
      credentialId: credential.id,
      pressure: evaluation.pressure,
    }))
    const reservation = await this.stateService.reserveBestAccount(projectId, model, candidates)
    if (!reservation.credentialId) {
      this.logExhaustion(projectId, evaluated, reservation.earliestCooldownReset)
      throw new AccountPoolExhaustedError(
        `All ${allAnthropicCredentials.length} accounts in pool for project "${projectId}" are cooling down after upstream rate limits`,
        reservation.earliestCooldownReset
      )
    }

    const selected = available.find(result => result.credential.id === reservation.credentialId)
    if (!selected) {
      throw new Error(`Reserved credential ${reservation.credentialId} was not a pool candidate`)
    }
    const { credential, evaluation } = selected

    logger.info('Selected account from pool', {
      metadata: {
        projectId,
        accountId: credential.account_id,
        maxUtilization: evaluation.maxUtilization,
        fiveHourThreshold: this.fiveHourThreshold(credential),
        sevenDayThreshold: this.sevenDayThreshold(credential),
        poolSize: allAnthropicCredentials.length,
        availableCount: available.length,
      },
    })

    return {
      credential,
      maxUtilization: evaluation.maxUtilization,
      fromPool: true,
      reserved: true,
    }
  }

  async releaseAccount(credentialId: string): Promise<void> {
    await this.stateService.releaseAccount(credentialId)
  }

  async markRateLimited(
    credentialId: string,
    model: string | undefined,
    error: UpstreamError
  ): Promise<string> {
    const retryAfterMs = getRetryAfter(error)
    const headerReset = this.findHeaderReset(error.upstreamHeaders)
    const usageReset = await this.findCredentialReset(credentialId, model)
    const resetTimestamp =
      retryAfterMs !== null
        ? Date.now() + retryAfterMs
        : (headerReset ?? usageReset ?? Date.now() + FALLBACK_COOLDOWN_MS)
    const cooldownUntil = new Date(Math.max(Date.now(), resetTimestamp))
    const retryAfterSeconds = Math.max(0, Math.ceil((cooldownUntil.getTime() - Date.now()) / 1000))

    await this.stateService.markCooldown(
      credentialId,
      model,
      cooldownUntil,
      retryAfterSeconds,
      error.message
    )

    logger.warn('Account placed in shared model cooldown after upstream 429', {
      metadata: {
        credentialId,
        model: model ?? '*',
        cooldownUntil: cooldownUntil.toISOString(),
        retryAfterSeconds,
      },
    })
    return cooldownUntil.toISOString()
  }

  clearStickyState(): void {
    this.stateService.clearInMemoryState()
  }

  private async selectDefaultAccount(
    projectId: string,
    model: string | undefined,
    excluded: Set<string>
  ): Promise<AccountSelection> {
    const credentials = await getProjectCredentials(this.pool, projectId)
    if (credentials.length === 0) {
      throw new Error(`No default credential found for project "${projectId}"`)
    }

    const credential = credentials[0]
    if (excluded.has(credential.id)) {
      throw new AccountPoolExhaustedError(
        `No alternative account is available for project "${projectId}"`
      )
    }

    if (credential.provider !== 'anthropic') {
      return { credential, maxUtilization: 0, fromPool: false, reserved: false }
    }

    const reservation = await this.stateService.reserveBestAccount(projectId, model, [
      { credentialId: credential.id, pressure: 0 },
    ])
    if (!reservation.credentialId) {
      throw new AccountPoolExhaustedError(
        `The account for project "${projectId}" is cooling down after an upstream rate limit`,
        reservation.earliestCooldownReset
      )
    }

    return { credential, maxUtilization: 0, fromPool: false, reserved: true }
  }

  private evaluateUsage(
    credential: AnthropicCredential,
    usage: AnthropicOAuthUsageResponse | null,
    model?: string
  ): UsageEvaluation {
    if (!usage) {
      return { maxUtilization: 1, pressure: Number.POSITIVE_INFINITY, available: false }
    }

    let fiveHour = (usage.five_hour?.utilization ?? 0) / 100
    let sevenDay = (usage.seven_day?.utilization ?? 0) / 100

    for (const limit of usage.limits ?? []) {
      if (!this.limitApplies(limit, model)) {
        continue
      }
      const utilization = (limit.percent ?? 0) / 100
      if (this.isSessionLimit(limit)) {
        fiveHour = Math.max(fiveHour, utilization)
      } else {
        sevenDay = Math.max(sevenDay, utilization)
      }
    }

    const fiveHourThreshold = this.fiveHourThreshold(credential)
    const sevenDayThreshold = this.sevenDayThreshold(credential)
    return {
      maxUtilization: Math.max(fiveHour, sevenDay),
      pressure: Math.max(fiveHour / fiveHourThreshold, sevenDay / sevenDayThreshold),
      available: fiveHour < fiveHourThreshold && sevenDay < sevenDayThreshold,
    }
  }

  private limitApplies(limit: OAuthLimitEntry, model?: string): boolean {
    if (!limit.is_active) {
      return false
    }
    const scopedModel = limit.scope?.model
    if (!scopedModel) {
      return true
    }
    if (!model) {
      return false
    }
    if (scopedModel.id) {
      return scopedModel.id.toLowerCase() === model.toLowerCase()
    }
    return scopedModel.display_name
      ? model.toLowerCase().includes(scopedModel.display_name.toLowerCase())
      : false
  }

  private isSessionLimit(limit: OAuthLimitEntry): boolean {
    const kind = limit.kind.toLowerCase()
    const group = limit.group?.toLowerCase() ?? ''
    return kind.includes('session') || kind.includes('hour') || group.includes('session')
  }

  private fiveHourThreshold(credential: AnthropicCredential): number {
    return Number(credential.five_hour_limit_threshold ?? DEFAULT_FIVE_HOUR_THRESHOLD)
  }

  private sevenDayThreshold(credential: AnthropicCredential): number {
    return Number(credential.seven_day_limit_threshold ?? DEFAULT_SEVEN_DAY_THRESHOLD)
  }

  private findEarliestReset(
    credentials: AnthropicCredential[],
    usageMap: Map<string, CachedUsageEntry>,
    model?: string
  ): string | null {
    const accountResets = credentials
      .map(credential => {
        const usage = usageMap.get(credential.id)?.usage
        return usage ? this.blockingReset(usage, model, credential) : null
      })
      .filter((value): value is string => Boolean(value))
    return this.earliestReset(accountResets)
  }

  private async findCredentialReset(credentialId: string, model?: string): Promise<number | null> {
    const usage = (await this.usageCacheService.getLastKnownUsage(credentialId))?.usage
    const reset = usage ? this.blockingReset(usage, model) : null
    return reset ? new Date(reset).getTime() : null
  }

  private blockingReset(
    usage: AnthropicOAuthUsageResponse,
    model?: string,
    credential?: AnthropicCredential
  ): string | null {
    const fiveHourThreshold = credential
      ? this.fiveHourThreshold(credential)
      : DEFAULT_FIVE_HOUR_THRESHOLD
    const sevenDayThreshold = credential
      ? this.sevenDayThreshold(credential)
      : DEFAULT_SEVEN_DAY_THRESHOLD
    const blockingResets: string[] = []

    if (usage.five_hour && usage.five_hour.utilization / 100 >= fiveHourThreshold) {
      blockingResets.push(usage.five_hour.resets_at)
    }
    if (usage.seven_day && usage.seven_day.utilization / 100 >= sevenDayThreshold) {
      blockingResets.push(usage.seven_day.resets_at)
    }
    for (const limit of usage.limits ?? []) {
      if (!this.limitApplies(limit, model) || !limit.resets_at) {
        continue
      }
      const threshold = this.isSessionLimit(limit) ? fiveHourThreshold : sevenDayThreshold
      if ((limit.percent ?? 0) / 100 >= threshold) {
        blockingResets.push(limit.resets_at)
      }
    }

    if (blockingResets.length === 0) {
      return null
    }

    // An account blocked by multiple windows is eligible only after all of its
    // blocking windows reset, so use the latest reset for that account.
    const timestamps = blockingResets
      .map(reset => new Date(reset).getTime())
      .filter(timestamp => Number.isFinite(timestamp) && timestamp > Date.now())
    return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null
  }

  private findHeaderReset(headers?: Record<string, string>): number | null {
    if (!headers) {
      return null
    }
    const timestamps = Object.entries(headers)
      .filter(([name]) => name.toLowerCase().startsWith('anthropic-ratelimit-'))
      .filter(([name]) => name.toLowerCase().endsWith('-reset'))
      .map(([, value]) => new Date(value).getTime())
      .filter(timestamp => Number.isFinite(timestamp) && timestamp > Date.now())
    // Retry-After is preferred above. Without it, use the most conservative
    // reset because the response headers describe multiple independent
    // limiters and do not reliably identify which one produced the 429.
    return timestamps.length ? Math.max(...timestamps) : null
  }

  private earliestReset(resetTimes: string[]): string | null {
    const timestamps = resetTimes
      .map(resetTime => new Date(resetTime).getTime())
      .filter(timestamp => Number.isFinite(timestamp) && timestamp > Date.now())
    return timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null
  }

  private logExhaustion(
    projectId: string,
    evaluated: Array<{ credential: AnthropicCredential; evaluation: UsageEvaluation }>,
    estimatedReset: string | null
  ): void {
    logger.warn('All accounts in pool exhausted', {
      metadata: {
        projectId,
        accountCount: evaluated.length,
        utilizations: evaluated.map(({ credential, evaluation }) => ({
          accountId: credential.account_id,
          maxUtilization: evaluation.maxUtilization,
          fiveHourThreshold: this.fiveHourThreshold(credential),
          sevenDayThreshold: this.sevenDayThreshold(credential),
        })),
        estimatedReset,
      },
    })
  }
}
