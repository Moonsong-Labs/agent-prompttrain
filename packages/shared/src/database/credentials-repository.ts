/**
 * Repository for credential management dashboard operations
 *
 * Provides CRUD operations for accounts and trains through the dashboard UI.
 */

import { Pool } from 'pg'
import { randomUUID } from 'crypto'
import { DatabaseAccount, DatabaseTrain } from '../types/credentials.js'
import { hashApiKey } from '../utils/encryption.js'

export interface CreateAccountInput {
  accountName: string
  credentialType: 'api_key' | 'oauth'
  apiKey?: string
  oauthAccessToken?: string
  oauthRefreshToken?: string
  oauthExpiresAt?: number
  oauthScopes?: string[]
  oauthIsMax?: boolean
}

export interface UpdateAccountInput {
  accountName?: string
  isActive?: boolean
  // Note: Credential fields (apiKey, OAuth tokens) cannot be updated after creation
  // for security reasons. Delete and recreate the account to update credentials.
}

export interface CreateTrainInput {
  description?: string
  clientApiKeys?: string[] // Plain keys, will be hashed
  slackConfig?: Record<string, unknown>
  defaultAccountId?: string
  accountIds?: string[] // List of account IDs to associate
}

export interface UpdateTrainInput {
  description?: string
  clientApiKeys?: string[] // Plain keys, will be hashed
  slackConfig?: Record<string, unknown>
  defaultAccountId?: string
  accountIds?: string[] // List of account IDs to associate
  isActive?: boolean
}

export class CredentialsRepository {
  constructor(private readonly db: Pool) {}

  // ========================================
  // ACCOUNTS CRUD
  // ========================================

  /**
   * List all accounts (without sensitive data)
   */
  async listAccounts(): Promise<
    Omit<DatabaseAccount, 'apiKey' | 'oauthAccessToken' | 'oauthRefreshToken'>[]
  > {
    const result = await this.db.query<{
      account_id: string
      account_name: string
      credential_type: 'api_key' | 'oauth'
      oauth_expires_at?: number
      oauth_scopes?: string[]
      oauth_is_max?: boolean
      is_active: boolean
      created_at: Date
      updated_at: Date
      last_used_at?: Date
    }>(`
      SELECT account_id, account_name, credential_type,
             oauth_expires_at, oauth_scopes, oauth_is_max,
             is_active, created_at, updated_at, last_used_at
      FROM accounts
      ORDER BY account_name
    `)

    return result.rows.map(row => ({
      accountId: row.account_id,
      accountName: row.account_name,
      credentialType: row.credential_type,
      oauthExpiresAt: row.oauth_expires_at,
      oauthScopes: row.oauth_scopes,
      oauthIsMax: row.oauth_is_max,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
    }))
  }

  /**
   * Get a single account by ID (without sensitive data)
   */
  async getAccountById(
    accountId: string
  ): Promise<Omit<DatabaseAccount, 'apiKey' | 'oauthAccessToken' | 'oauthRefreshToken'> | null> {
    const result = await this.db.query<{
      account_id: string
      account_name: string
      credential_type: 'api_key' | 'oauth'
      oauth_expires_at?: number
      oauth_scopes?: string[]
      oauth_is_max?: boolean
      is_active: boolean
      created_at: Date
      updated_at: Date
      last_used_at?: Date
    }>(
      `
      SELECT account_id, account_name, credential_type,
             oauth_expires_at, oauth_scopes, oauth_is_max,
             is_active, created_at, updated_at, last_used_at
      FROM accounts
      WHERE account_id = $1
    `,
      [accountId]
    )

    if (result.rowCount === 0) {
      return null
    }

    const row = result.rows[0]
    return {
      accountId: row.account_id,
      accountName: row.account_name,
      credentialType: row.credential_type,
      oauthExpiresAt: row.oauth_expires_at,
      oauthScopes: row.oauth_scopes,
      oauthIsMax: row.oauth_is_max,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
    }
  }

  /**
   * Create a new account with credentials
   */
  async createAccount(input: CreateAccountInput): Promise<string> {
    const accountId = `acc_${randomUUID()}`

    await this.db.query(
      `
      INSERT INTO accounts (
        account_id, account_name, credential_type,
        api_key, oauth_access_token, oauth_refresh_token,
        oauth_expires_at, oauth_scopes, oauth_is_max,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
    `,
      [
        accountId,
        input.accountName,
        input.credentialType,
        input.apiKey || null,
        input.oauthAccessToken || null,
        input.oauthRefreshToken || null,
        input.oauthExpiresAt || null,
        input.oauthScopes || null,
        input.oauthIsMax || null,
      ]
    )

    return accountId
  }

  /**
   * Update an existing account
   * IMPORTANT: Only accountName and isActive can be modified.
   * Credentials cannot be changed after creation for security reasons.
   */
  async updateAccount(accountId: string, input: UpdateAccountInput): Promise<void> {
    const updates: string[] = []
    const values: unknown[] = []
    let paramIndex = 1

    if (input.accountName !== undefined) {
      updates.push(`account_name = $${paramIndex++}`)
      values.push(input.accountName)
    }

    if (input.isActive !== undefined) {
      updates.push(`is_active = $${paramIndex++}`)
      values.push(input.isActive)
    }

    if (updates.length === 0) {
      return
    }

    updates.push(`updated_at = NOW()`)
    values.push(accountId)

    await this.db.query(
      `
      UPDATE accounts
      SET ${updates.join(', ')}
      WHERE account_id = $${paramIndex}
    `,
      values
    )
  }

  /**
   * Delete an account
   * Note: CASCADE will remove associated train_account_mappings
   */
  async deleteAccount(accountId: string): Promise<void> {
    await this.db.query('DELETE FROM accounts WHERE account_id = $1', [accountId])
  }

  // ========================================
  // TRAINS CRUD
  // ========================================

  /**
   * List all trains with their associated accounts
   * Uses LEFT JOIN with array_agg to avoid N+1 queries
   */
  async listTrains(): Promise<(DatabaseTrain & { accountIds: string[] })[]> {
    const result = await this.db.query<{
      train_id: string
      description?: string
      client_api_keys_hashed?: string[]
      slack_config?: Record<string, unknown>
      default_account_id?: string
      is_active: boolean
      created_at: Date
      updated_at: Date
      account_ids: string[]
    }>(`
      SELECT
        t.train_id, t.description, t.client_api_keys_hashed,
        t.slack_config, t.default_account_id, t.is_active, t.created_at, t.updated_at,
        COALESCE(
          array_agg(tam.account_id ORDER BY tam.priority) FILTER (WHERE tam.account_id IS NOT NULL),
          '{}'
        ) as account_ids
      FROM trains t
      LEFT JOIN train_account_mappings tam ON t.train_id = tam.train_id
      GROUP BY t.train_id
      ORDER BY t.train_id
    `)

    return result.rows.map(row => ({
      trainId: row.train_id,
      description: row.description,
      clientApiKeysHashed: row.client_api_keys_hashed,
      slackConfig: row.slack_config,
      defaultAccountId: row.default_account_id,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      accountIds: row.account_ids,
    }))
  }

  /**
   * Get a single train by ID with associated accounts
   */
  async getTrainById(trainId: string): Promise<(DatabaseTrain & { accountIds: string[] }) | null> {
    const result = await this.db.query<{
      train_id: string
      description?: string
      client_api_keys_hashed?: string[]
      slack_config?: Record<string, unknown>
      default_account_id?: string
      is_active: boolean
      created_at: Date
      updated_at: Date
    }>(
      `
      SELECT train_id, description, client_api_keys_hashed,
             slack_config, default_account_id, is_active, created_at, updated_at
      FROM trains
      WHERE train_id = $1
    `,
      [trainId]
    )

    if (result.rowCount === 0) {
      return null
    }

    const row = result.rows[0]
    const mappings = await this.db.query<{ account_id: string }>(
      'SELECT account_id FROM train_account_mappings WHERE train_id = $1',
      [trainId]
    )

    return {
      trainId: row.train_id,
      description: row.description,
      clientApiKeysHashed: row.client_api_keys_hashed,
      slackConfig: row.slack_config,
      defaultAccountId: row.default_account_id,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      accountIds: mappings.rows.map(m => m.account_id),
    }
  }

  /**
   * Create a new train
   */
  async createTrain(trainId: string, input: CreateTrainInput): Promise<void> {
    const client = await this.db.connect()

    try {
      await client.query('BEGIN')

      // Hash client API keys if provided
      let clientApiKeysHashed: string[] | null = null
      if (input.clientApiKeys && input.clientApiKeys.length > 0) {
        clientApiKeysHashed = input.clientApiKeys.map(key => hashApiKey(key))
      }

      // Create the train
      await client.query(
        `
        INSERT INTO trains (
          train_id, description, client_api_keys_hashed,
          slack_config, default_account_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      `,
        [
          trainId,
          input.description || null,
          clientApiKeysHashed,
          input.slackConfig ? JSON.stringify(input.slackConfig) : null,
          input.defaultAccountId || null,
        ]
      )

      // Create account mappings
      if (input.accountIds && input.accountIds.length > 0) {
        for (let i = 0; i < input.accountIds.length; i++) {
          await client.query(
            `
            INSERT INTO train_account_mappings (train_id, account_id, priority, created_at)
            VALUES ($1, $2, $3, NOW())
          `,
            [trainId, input.accountIds[i], i]
          )
        }
      }

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * Update an existing train
   */
  async updateTrain(trainId: string, input: UpdateTrainInput): Promise<void> {
    const client = await this.db.connect()

    try {
      await client.query('BEGIN')

      // Build update query for trains table
      const updates: string[] = []
      const values: unknown[] = []
      let paramIndex = 1

      if (input.description !== undefined) {
        updates.push(`description = $${paramIndex++}`)
        values.push(input.description)
      }

      if (input.clientApiKeys !== undefined) {
        const hashed = input.clientApiKeys.map(key => hashApiKey(key))
        updates.push(`client_api_keys_hashed = $${paramIndex++}`)
        values.push(hashed)
      }

      if (input.slackConfig !== undefined) {
        updates.push(`slack_config = $${paramIndex++}`)
        values.push(JSON.stringify(input.slackConfig))
      }

      if (input.defaultAccountId !== undefined) {
        updates.push(`default_account_id = $${paramIndex++}`)
        values.push(input.defaultAccountId)
      }

      if (input.isActive !== undefined) {
        updates.push(`is_active = $${paramIndex++}`)
        values.push(input.isActive)
      }

      if (updates.length > 0) {
        updates.push(`updated_at = NOW()`)
        values.push(trainId)

        await client.query(
          `
          UPDATE trains
          SET ${updates.join(', ')}
          WHERE train_id = $${paramIndex}
        `,
          values
        )
      }

      // Update account mappings if provided
      if (input.accountIds !== undefined) {
        // Delete existing mappings
        await client.query('DELETE FROM train_account_mappings WHERE train_id = $1', [trainId])

        // Insert new mappings
        if (input.accountIds.length > 0) {
          for (let i = 0; i < input.accountIds.length; i++) {
            await client.query(
              `
              INSERT INTO train_account_mappings (train_id, account_id, priority, created_at)
              VALUES ($1, $2, $3, NOW())
            `,
              [trainId, input.accountIds[i], i]
            )
          }
        }
      }

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * Delete a train
   * Note: CASCADE will remove associated train_account_mappings
   */
  async deleteTrain(trainId: string): Promise<void> {
    await this.db.query('DELETE FROM trains WHERE train_id = $1', [trainId])
  }

  // ========================================
  // API KEY GENERATION & REVOCATION
  // ========================================

  /**
   * Count generated keys for a specific train
   * Used to enforce per-train generation limits
   */
  async countGeneratedKeysForTrain(trainId: string): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `
      SELECT COUNT(*) as count
      FROM accounts a
      INNER JOIN train_account_mappings tam ON a.account_id = tam.account_id
      WHERE tam.train_id = $1
      AND a.is_generated = true
      AND a.revoked_at IS NULL
    `,
      [trainId]
    )

    return parseInt(result.rows[0].count, 10)
  }

  /**
   * Count all generated keys globally
   * Used to enforce global generation limits
   */
  async countGeneratedKeysGlobal(): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `
      SELECT COUNT(*) as count
      FROM accounts
      WHERE is_generated = true
      AND revoked_at IS NULL
    `
    )

    return parseInt(result.rows[0].count, 10)
  }

  /**
   * Generate a new API key for a train
   * Returns both the account ID and the plaintext key (only time it's exposed)
   *
   * @param trainId - The train to generate the key for
   * @param accountName - A friendly name for the generated key
   * @param generatedKey - The pre-generated API key (from generateApiKey utility)
   * @returns Object containing accountId and the plaintext apiKey
   */
  async generateApiKeyForTrain(
    trainId: string,
    accountName: string,
    generatedKey: string
  ): Promise<{ accountId: string; apiKey: string }> {
    // Store the key in plaintext directly to the train's client_api_keys_hashed array
    // Note: Despite the column name "hashed", we're storing plaintext for now
    // These are train tokens for client authentication, NOT Anthropic account credentials
    await this.db.query(
      `
      UPDATE trains
      SET client_api_keys_hashed = array_append(COALESCE(client_api_keys_hashed, ARRAY[]::TEXT[]), $1),
          updated_at = NOW()
      WHERE train_id = $2
    `,
      [generatedKey, trainId]
    )

    // Return a synthetic accountId for backward compatibility with UI
    // In the future, we should refactor the UI to not expect an accountId
    return {
      accountId: `train-token-${trainId}`,
      apiKey: generatedKey,
    }
  }

  /**
   * Revoke an API key (soft delete)
   * Sets revoked_at timestamp and marks as inactive
   */
  async revokeAccount(accountId: string): Promise<void> {
    await this.db.query(
      `
      UPDATE accounts
      SET revoked_at = NOW(), is_active = false, updated_at = NOW()
      WHERE account_id = $1
    `,
      [accountId]
    )
  }

  /**
   * Get accounts for a specific train
   * Includes generated flag and revoked status
   */
  async getAccountsForTrain(trainId: string): Promise<
    Array<
      Omit<DatabaseAccount, 'apiKey' | 'oauthAccessToken' | 'oauthRefreshToken'> & {
        keyHashLast4?: string
      }
    >
  > {
    const result = await this.db.query<{
      account_id: string
      account_name: string
      credential_type: 'api_key' | 'oauth'
      key_hash?: string
      is_generated?: boolean
      revoked_at?: Date
      oauth_expires_at?: number
      oauth_scopes?: string[]
      oauth_is_max?: boolean
      is_active: boolean
      created_at: Date
      updated_at: Date
      last_used_at?: Date
    }>(
      `
      SELECT a.account_id, a.account_name, a.credential_type,
             a.key_hash, a.is_generated, a.revoked_at,
             a.oauth_expires_at, a.oauth_scopes, a.oauth_is_max,
             a.is_active, a.created_at, a.updated_at, a.last_used_at
      FROM accounts a
      INNER JOIN train_account_mappings tam ON a.account_id = tam.account_id
      WHERE tam.train_id = $1
      ORDER BY tam.priority, a.created_at
    `,
      [trainId]
    )

    return result.rows.map(row => ({
      accountId: row.account_id,
      accountName: row.account_name,
      credentialType: row.credential_type,
      isGenerated: row.is_generated,
      keyHash: row.key_hash,
      keyHashLast4: row.key_hash ? row.key_hash.slice(-4) : undefined,
      revokedAt: row.revoked_at,
      oauthExpiresAt: row.oauth_expires_at,
      oauthScopes: row.oauth_scopes,
      oauthIsMax: row.oauth_is_max,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
    }))
  }
}
