import type { Pool, PoolClient } from 'pg'
import type { AnthropicOAuthUsageResponse } from '@agent-prompttrain/shared'

const USAGE_REFRESH_LEASE_MS = 30_000
const FORCE_REFRESH_COOLDOWN_MS = 30_000
const STALE_IN_FLIGHT_MS = 900_000

export interface SharedUsageState {
  usage: AnthropicOAuthUsageResponse | null
  fetchedAt: number
  nextRefreshAt: number
  failureCount: number
}

export interface AccountCandidate {
  credentialId: string
  pressure: number
}

export interface AccountReservation {
  credentialId: string | null
  earliestCooldownReset: string | null
}

interface MemoryAccountState extends SharedUsageState {
  refreshLeaseUntil: number
  lastForceRefreshAt: number
  inFlightRequests: number
}

interface RuntimeRow {
  credential_id: string
  usage: AnthropicOAuthUsageResponse | null
  usage_fetched_at: Date | string | null
  usage_next_refresh_at: Date | string | null
  usage_failure_count: number | string
  in_flight_requests: number | string
  cooldown_until?: Date | string | null
}

/**
 * PostgreSQL coordination for account pooling. A small in-memory implementation
 * is retained for isolated unit tests that intentionally do not provide a pool.
 */
export class AccountPoolStateService {
  private readonly memoryAccounts = new Map<string, MemoryAccountState>()
  private readonly memoryCooldowns = new Map<string, number>()
  private readonly memoryAffinity = new Map<string, string>()

  constructor(private readonly pool?: Pool | null) {}

  get isPersistent(): boolean {
    return Boolean(
      this.pool &&
        typeof (this.pool as Pool).query === 'function' &&
        typeof (this.pool as Pool).connect === 'function'
    )
  }

  async getUsageState(credentialId: string): Promise<SharedUsageState | null> {
    if (!this.isPersistent) {
      const state = this.memoryAccounts.get(credentialId)
      return state ? this.toSharedUsageState(state) : null
    }

    const result = await this.pool!.query<RuntimeRow>(
      `
      SELECT credential_id, usage, usage_fetched_at, usage_next_refresh_at,
             usage_failure_count, in_flight_requests
      FROM account_pool_account_state
      WHERE credential_id = $1
      `,
      [credentialId]
    )

    return result.rows[0] ? this.rowToUsageState(result.rows[0]) : null
  }

  async claimUsageRefresh(credentialId: string, force = false): Promise<boolean> {
    const now = Date.now()

    if (!this.isPersistent) {
      const state = this.getOrCreateMemoryAccount(credentialId)
      const forceAllowed = now - state.lastForceRefreshAt >= FORCE_REFRESH_COOLDOWN_MS
      const scheduled = state.nextRefreshAt === 0 || state.nextRefreshAt <= now
      if (state.refreshLeaseUntil > now || (force ? !forceAllowed : !scheduled)) {
        return false
      }
      state.refreshLeaseUntil = now + USAGE_REFRESH_LEASE_MS
      if (force) {
        state.lastForceRefreshAt = now
      }
      return true
    }

    await this.ensureAccountState(credentialId)
    const result = await this.pool!.query(
      `
      UPDATE account_pool_account_state
      SET usage_refresh_lease_until = NOW() + ($2 * INTERVAL '1 millisecond'),
          usage_last_force_refresh_at = CASE WHEN $3 THEN NOW() ELSE usage_last_force_refresh_at END,
          updated_at = NOW()
      WHERE credential_id = $1
        AND (usage_refresh_lease_until IS NULL OR usage_refresh_lease_until <= NOW())
        AND (
          ($3 = FALSE AND (usage_next_refresh_at IS NULL OR usage_next_refresh_at <= NOW()))
          OR
          ($3 = TRUE AND (
            usage_last_force_refresh_at IS NULL
            OR usage_last_force_refresh_at <= NOW() - ($4 * INTERVAL '1 millisecond')
          ))
        )
      RETURNING credential_id
      `,
      [credentialId, USAGE_REFRESH_LEASE_MS, force, FORCE_REFRESH_COOLDOWN_MS]
    )

    return (result.rowCount ?? 0) > 0
  }

  async saveUsageSuccess(
    credentialId: string,
    usage: AnthropicOAuthUsageResponse,
    fetchedAt: number,
    nextRefreshAt: number
  ): Promise<void> {
    if (!this.isPersistent) {
      const state = this.getOrCreateMemoryAccount(credentialId)
      state.usage = usage
      state.fetchedAt = fetchedAt
      state.nextRefreshAt = nextRefreshAt
      state.failureCount = 0
      state.refreshLeaseUntil = 0
      return
    }

    await this.pool!.query(
      `
      INSERT INTO account_pool_account_state (
        credential_id, usage, usage_fetched_at, usage_next_refresh_at,
        usage_failure_count, usage_refresh_lease_until, updated_at
      ) VALUES ($1, $2::jsonb, $3, $4, 0, NULL, NOW())
      ON CONFLICT (credential_id) DO UPDATE
      SET usage = EXCLUDED.usage,
          usage_fetched_at = EXCLUDED.usage_fetched_at,
          usage_next_refresh_at = EXCLUDED.usage_next_refresh_at,
          usage_failure_count = 0,
          usage_refresh_lease_until = NULL,
          updated_at = NOW()
      `,
      [credentialId, JSON.stringify(usage), new Date(fetchedAt), new Date(nextRefreshAt)]
    )
  }

  async saveUsageFailure(credentialId: string, nextRefreshAt: number): Promise<number> {
    if (!this.isPersistent) {
      const state = this.getOrCreateMemoryAccount(credentialId)
      state.failureCount += 1
      state.nextRefreshAt = nextRefreshAt
      state.refreshLeaseUntil = 0
      return state.failureCount
    }

    await this.ensureAccountState(credentialId)
    const result = await this.pool!.query<{ usage_failure_count: number | string }>(
      `
      UPDATE account_pool_account_state
      SET usage_failure_count = usage_failure_count + 1,
          usage_next_refresh_at = $2,
          usage_refresh_lease_until = NULL,
          updated_at = NOW()
      WHERE credential_id = $1
      RETURNING usage_failure_count
      `,
      [credentialId, new Date(nextRefreshAt)]
    )

    return Number(result.rows[0]?.usage_failure_count ?? 1)
  }

  async releaseUsageRefresh(credentialId: string): Promise<void> {
    if (!this.isPersistent) {
      this.getOrCreateMemoryAccount(credentialId).refreshLeaseUntil = 0
      return
    }

    await this.pool!.query(
      `
      UPDATE account_pool_account_state
      SET usage_refresh_lease_until = NULL, updated_at = NOW()
      WHERE credential_id = $1
      `,
      [credentialId]
    )
  }

  async reserveBestAccount(
    projectId: string,
    model: string | undefined,
    candidates: AccountCandidate[]
  ): Promise<AccountReservation> {
    if (candidates.length === 0) {
      return { credentialId: null, earliestCooldownReset: null }
    }

    const modelKey = this.modelKey(model)
    if (!this.isPersistent) {
      return this.reserveBestAccountInMemory(projectId, modelKey, candidates)
    }

    const client = await this.pool!.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `account-pool:${projectId}:${modelKey}`,
      ])
      await this.ensureAccountStates(
        client,
        candidates.map(candidate => candidate.credentialId)
      )

      const affinityResult = await client.query<{ credential_id: string }>(
        'SELECT credential_id FROM account_pool_project_affinity WHERE project_id = $1',
        [projectId]
      )
      const affinityId = affinityResult.rows[0]?.credential_id

      const stateResult = await client.query<RuntimeRow>(
        `
        SELECT state.credential_id, state.usage, state.usage_fetched_at,
               state.usage_next_refresh_at, state.usage_failure_count,
               CASE
                 WHEN state.in_flight_updated_at IS NULL
                   OR state.in_flight_updated_at <= NOW() - ($3 * INTERVAL '1 millisecond')
                 THEN 0
                 ELSE state.in_flight_requests
               END AS in_flight_requests,
               cooldown.cooldown_until
        FROM account_pool_account_state state
        LEFT JOIN account_pool_model_cooldowns cooldown
          ON cooldown.credential_id = state.credential_id
         AND cooldown.model = $2
         AND cooldown.cooldown_until > NOW()
        WHERE state.credential_id = ANY($1::uuid[])
        FOR UPDATE OF state
        `,
        [candidates.map(candidate => candidate.credentialId), modelKey, STALE_IN_FLIGHT_MS]
      )

      const stateByCredential = new Map(stateResult.rows.map(row => [row.credential_id, row]))
      const available = candidates.filter(candidate => {
        const row = stateByCredential.get(candidate.credentialId)
        return row && !row.cooldown_until
      })

      let selected = available.find(candidate => candidate.credentialId === affinityId)
      if (!selected) {
        selected = [...available].sort((left, right) => {
          const leftInFlight = Number(
            stateByCredential.get(left.credentialId)?.in_flight_requests ?? 0
          )
          const rightInFlight = Number(
            stateByCredential.get(right.credentialId)?.in_flight_requests ?? 0
          )
          return left.pressure + leftInFlight * 0.01 - (right.pressure + rightInFlight * 0.01)
        })[0]
      }

      if (!selected) {
        const earliestCooldownReset = this.earliestDate(
          stateResult.rows.map(row => row.cooldown_until)
        )
        await client.query('COMMIT')
        return { credentialId: null, earliestCooldownReset }
      }

      await client.query(
        `
        UPDATE account_pool_account_state
        SET in_flight_requests = CASE
              WHEN in_flight_updated_at IS NULL
                OR in_flight_updated_at <= NOW() - ($2 * INTERVAL '1 millisecond')
              THEN 1
              ELSE in_flight_requests + 1
            END,
            in_flight_updated_at = NOW(),
            updated_at = NOW()
        WHERE credential_id = $1
        `,
        [selected.credentialId, STALE_IN_FLIGHT_MS]
      )
      await client.query(
        `
        INSERT INTO account_pool_project_affinity (project_id, credential_id, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (project_id) DO UPDATE
        SET credential_id = EXCLUDED.credential_id, updated_at = NOW()
        `,
        [projectId, selected.credentialId]
      )

      await client.query('COMMIT')
      return { credentialId: selected.credentialId, earliestCooldownReset: null }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async releaseAccount(credentialId: string): Promise<void> {
    if (!this.isPersistent) {
      const state = this.getOrCreateMemoryAccount(credentialId)
      state.inFlightRequests = Math.max(0, state.inFlightRequests - 1)
      return
    }

    await this.pool!.query(
      `
      UPDATE account_pool_account_state
      SET in_flight_requests = GREATEST(0, in_flight_requests - 1),
          in_flight_updated_at = NOW(),
          updated_at = NOW()
      WHERE credential_id = $1
      `,
      [credentialId]
    )
  }

  async markCooldown(
    credentialId: string,
    model: string | undefined,
    cooldownUntil: Date,
    retryAfterSeconds: number,
    reason: string
  ): Promise<void> {
    const modelKey = this.modelKey(model)

    if (!this.isPersistent) {
      this.memoryCooldowns.set(this.cooldownKey(credentialId, modelKey), cooldownUntil.getTime())
      for (const [projectId, affinityId] of this.memoryAffinity) {
        if (affinityId === credentialId) {
          this.memoryAffinity.delete(projectId)
        }
      }
      return
    }

    await this.pool!.query(
      `
      INSERT INTO account_pool_model_cooldowns (
        credential_id, model, cooldown_until, reason, retry_after_seconds, updated_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (credential_id, model) DO UPDATE
      SET cooldown_until = GREATEST(
            account_pool_model_cooldowns.cooldown_until,
            EXCLUDED.cooldown_until
          ),
          reason = EXCLUDED.reason,
          retry_after_seconds = EXCLUDED.retry_after_seconds,
          updated_at = NOW()
      `,
      [credentialId, modelKey, cooldownUntil, reason, retryAfterSeconds]
    )
    await this.pool!.query('DELETE FROM account_pool_project_affinity WHERE credential_id = $1', [
      credentialId,
    ])
  }

  clearInMemoryState(): void {
    if (!this.isPersistent) {
      this.memoryAccounts.clear()
      this.memoryCooldowns.clear()
      this.memoryAffinity.clear()
    }
  }

  private async ensureAccountState(credentialId: string): Promise<void> {
    await this.pool!.query(
      `
      INSERT INTO account_pool_account_state (credential_id)
      VALUES ($1)
      ON CONFLICT (credential_id) DO NOTHING
      `,
      [credentialId]
    )
  }

  private async ensureAccountStates(client: PoolClient, credentialIds: string[]): Promise<void> {
    await client.query(
      `
      INSERT INTO account_pool_account_state (credential_id)
      SELECT UNNEST($1::uuid[])
      ON CONFLICT (credential_id) DO NOTHING
      `,
      [credentialIds]
    )
  }

  private reserveBestAccountInMemory(
    projectId: string,
    modelKey: string,
    candidates: AccountCandidate[]
  ): AccountReservation {
    const now = Date.now()
    const available = candidates.filter(candidate => {
      const cooldown = this.memoryCooldowns.get(this.cooldownKey(candidate.credentialId, modelKey))
      return !cooldown || cooldown <= now
    })
    const affinityId = this.memoryAffinity.get(projectId)
    let selected = available.find(candidate => candidate.credentialId === affinityId)
    if (!selected) {
      selected = [...available].sort((left, right) => {
        const leftState = this.getOrCreateMemoryAccount(left.credentialId)
        const rightState = this.getOrCreateMemoryAccount(right.credentialId)
        return (
          left.pressure +
          leftState.inFlightRequests * 0.01 -
          (right.pressure + rightState.inFlightRequests * 0.01)
        )
      })[0]
    }

    if (!selected) {
      const resets = candidates
        .map(candidate =>
          this.memoryCooldowns.get(this.cooldownKey(candidate.credentialId, modelKey))
        )
        .filter((value): value is number => Boolean(value && value > now))
      return {
        credentialId: null,
        earliestCooldownReset: resets.length ? new Date(Math.min(...resets)).toISOString() : null,
      }
    }

    const state = this.getOrCreateMemoryAccount(selected.credentialId)
    state.inFlightRequests += 1
    this.memoryAffinity.set(projectId, selected.credentialId)
    return { credentialId: selected.credentialId, earliestCooldownReset: null }
  }

  private getOrCreateMemoryAccount(credentialId: string): MemoryAccountState {
    let state = this.memoryAccounts.get(credentialId)
    if (!state) {
      state = {
        usage: null,
        fetchedAt: 0,
        nextRefreshAt: 0,
        failureCount: 0,
        refreshLeaseUntil: 0,
        lastForceRefreshAt: 0,
        inFlightRequests: 0,
      }
      this.memoryAccounts.set(credentialId, state)
    }
    return state
  }

  private toSharedUsageState(state: MemoryAccountState): SharedUsageState {
    return {
      usage: state.usage,
      fetchedAt: state.fetchedAt,
      nextRefreshAt: state.nextRefreshAt,
      failureCount: state.failureCount,
    }
  }

  private rowToUsageState(row: RuntimeRow): SharedUsageState {
    return {
      usage: row.usage,
      fetchedAt: this.toTimestamp(row.usage_fetched_at),
      nextRefreshAt: this.toTimestamp(row.usage_next_refresh_at),
      failureCount: Number(row.usage_failure_count ?? 0),
    }
  }

  private modelKey(model?: string): string {
    return model?.trim().toLowerCase().slice(0, 255) || '*'
  }

  private cooldownKey(credentialId: string, modelKey: string): string {
    return `${credentialId}:${modelKey}`
  }

  private toTimestamp(value: Date | string | null | undefined): number {
    return value ? new Date(value).getTime() : 0
  }

  private earliestDate(values: Array<Date | string | null | undefined>): string | null {
    const timestamps = values
      .map(value => this.toTimestamp(value))
      .filter(timestamp => timestamp > Date.now())
    return timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null
  }
}
