/**
 * Repository for credential management dashboard operations
 *
 * Provides CRUD operations for accounts and trains through the dashboard UI.
 * Handles encryption/decryption transparently using the encryption utilities.
 */

import { Pool } from 'pg'
import { randomUUID } from 'crypto'
import { DatabaseAccount, DatabaseTrain } from '../types/credentials.js'
import { encrypt, hashApiKey } from '../utils/encryption.js'

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
  apiKey?: string
  oauthAccessToken?: string
  oauthRefreshToken?: string
  oauthExpiresAt?: number
  oauthScopes?: string[]
  oauthIsMax?: boolean
  isActive?: boolean
}

export interface CreateTrainInput {
  trainName?: string
  description?: string
  clientApiKeys?: string[] // Plain keys, will be hashed
  slackConfig?: Record<string, unknown>
  defaultAccountId?: string
  accountIds?: string[] // List of account IDs to associate
}

export interface UpdateTrainInput {
  trainName?: string
  description?: string
  clientApiKeys?: string[] // Plain keys, will be hashed
  slackConfig?: Record<string, unknown>
  defaultAccountId?: string
  accountIds?: string[] // List of account IDs to associate
  isActive?: boolean
}

export class CredentialsRepository {
  constructor(
    private readonly db: Pool,
    private readonly encryptionKey: string
  ) {
    if (!encryptionKey || encryptionKey.length < 32) {
      throw new Error('Encryption key must be at least 32 characters')
    }
  }

  // ========================================
  // ACCOUNTS CRUD
  // ========================================

  /**
   * List all accounts (without sensitive data)
   */
  async listAccounts(): Promise<
    Omit<
      DatabaseAccount,
      'apiKeyEncrypted' | 'oauthAccessTokenEncrypted' | 'oauthRefreshTokenEncrypted'
    >[]
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
  ): Promise<Omit<
    DatabaseAccount,
    'apiKeyEncrypted' | 'oauthAccessTokenEncrypted' | 'oauthRefreshTokenEncrypted'
  > | null> {
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
   * Create a new account with encrypted credentials
   */
  async createAccount(input: CreateAccountInput): Promise<string> {
    const accountId = `acc_${randomUUID()}`

    let apiKeyEncrypted: string | null = null
    let oauthAccessTokenEncrypted: string | null = null
    let oauthRefreshTokenEncrypted: string | null = null

    if (input.credentialType === 'api_key' && input.apiKey) {
      apiKeyEncrypted = encrypt(input.apiKey, this.encryptionKey)
    }

    if (input.credentialType === 'oauth') {
      if (input.oauthAccessToken) {
        oauthAccessTokenEncrypted = encrypt(input.oauthAccessToken, this.encryptionKey)
      }
      if (input.oauthRefreshToken) {
        oauthRefreshTokenEncrypted = encrypt(input.oauthRefreshToken, this.encryptionKey)
      }
    }

    await this.db.query(
      `
      INSERT INTO accounts (
        account_id, account_name, credential_type,
        api_key_encrypted, oauth_access_token_encrypted, oauth_refresh_token_encrypted,
        oauth_expires_at, oauth_scopes, oauth_is_max,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
    `,
      [
        accountId,
        input.accountName,
        input.credentialType,
        apiKeyEncrypted,
        oauthAccessTokenEncrypted,
        oauthRefreshTokenEncrypted,
        input.oauthExpiresAt || null,
        input.oauthScopes || null,
        input.oauthIsMax || null,
      ]
    )

    return accountId
  }

  /**
   * Update an existing account
   * Only re-encrypts if new credentials are provided
   */
  async updateAccount(accountId: string, input: UpdateAccountInput): Promise<void> {
    const updates: string[] = []
    const values: unknown[] = []
    let paramIndex = 1

    if (input.accountName !== undefined) {
      updates.push(`account_name = $${paramIndex++}`)
      values.push(input.accountName)
    }

    if (input.apiKey !== undefined) {
      const encrypted = encrypt(input.apiKey, this.encryptionKey)
      updates.push(`api_key_encrypted = $${paramIndex++}`)
      values.push(encrypted)
    }

    if (input.oauthAccessToken !== undefined) {
      const encrypted = encrypt(input.oauthAccessToken, this.encryptionKey)
      updates.push(`oauth_access_token_encrypted = $${paramIndex++}`)
      values.push(encrypted)
    }

    if (input.oauthRefreshToken !== undefined) {
      const encrypted = encrypt(input.oauthRefreshToken, this.encryptionKey)
      updates.push(`oauth_refresh_token_encrypted = $${paramIndex++}`)
      values.push(encrypted)
    }

    if (input.oauthExpiresAt !== undefined) {
      updates.push(`oauth_expires_at = $${paramIndex++}`)
      values.push(input.oauthExpiresAt)
    }

    if (input.oauthScopes !== undefined) {
      updates.push(`oauth_scopes = $${paramIndex++}`)
      values.push(input.oauthScopes)
    }

    if (input.oauthIsMax !== undefined) {
      updates.push(`oauth_is_max = $${paramIndex++}`)
      values.push(input.oauthIsMax)
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
      train_name?: string
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
        t.train_id, t.train_name, t.description, t.client_api_keys_hashed,
        t.slack_config, t.default_account_id, t.is_active, t.created_at, t.updated_at,
        COALESCE(
          array_agg(tam.account_id ORDER BY tam.priority) FILTER (WHERE tam.account_id IS NOT NULL),
          '{}'
        ) as account_ids
      FROM trains t
      LEFT JOIN train_account_mappings tam ON t.train_id = tam.train_id
      GROUP BY t.train_id
      ORDER BY t.train_name
    `)

    return result.rows.map(row => ({
      trainId: row.train_id,
      trainName: row.train_name,
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
      train_name?: string
      description?: string
      client_api_keys_hashed?: string[]
      slack_config?: Record<string, unknown>
      default_account_id?: string
      is_active: boolean
      created_at: Date
      updated_at: Date
    }>(
      `
      SELECT train_id, train_name, description, client_api_keys_hashed,
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
      trainName: row.train_name,
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
          train_id, train_name, description, client_api_keys_hashed,
          slack_config, default_account_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      `,
        [
          trainId,
          input.trainName || null,
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

      if (input.trainName !== undefined) {
        updates.push(`train_name = $${paramIndex++}`)
        values.push(input.trainName)
      }

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
}
