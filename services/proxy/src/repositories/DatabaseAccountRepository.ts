import { Pool } from 'pg'
import { DecryptedAccount, DatabaseAccount, AuthenticationError } from '@agent-prompttrain/shared'
import { encrypt, decrypt } from '@agent-prompttrain/shared/utils/encryption'
import { IAccountRepository } from './IAccountRepository'
import { logger } from '../middleware/logger'

/**
 * Database-based implementation of IAccountRepository.
 *
 * Stores credentials in PostgreSQL with AES-256-GCM encryption.
 * Uses row-level locking (SELECT FOR UPDATE) for concurrency-safe OAuth refresh.
 */
export class DatabaseAccountRepository implements IAccountRepository {
  constructor(
    private readonly db: Pool,
    private readonly encryptionKey: string
  ) {
    if (!encryptionKey || encryptionKey.length < 32) {
      throw new Error('CREDENTIAL_ENCRYPTION_KEY must be at least 32 characters')
    }
  }

  async listAccountNames(): Promise<string[]> {
    try {
      const result = await this.db.query<{ account_name: string }>(
        'SELECT account_name FROM accounts WHERE is_active = true ORDER BY account_name'
      )
      return result.rows.map(row => row.account_name)
    } catch (error) {
      logger.error('Failed to list account names from database', {
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      })
      throw error
    }
  }

  async getAccountByName(accountName: string): Promise<DecryptedAccount | null> {
    try {
      const result = await this.db.query<{
        account_id: string
        account_name: string
        credential_type: 'api_key' | 'oauth'
        api_key_encrypted?: string
        oauth_access_token_encrypted?: string
        oauth_refresh_token_encrypted?: string
        oauth_expires_at?: number
        oauth_scopes?: string[]
        oauth_is_max?: boolean
        is_active: boolean
        last_used_at?: Date
      }>(
        `SELECT account_id, account_name, credential_type,
                api_key_encrypted, oauth_access_token_encrypted,
                oauth_refresh_token_encrypted, oauth_expires_at,
                oauth_scopes, oauth_is_max, is_active,
                created_at, updated_at, last_used_at
         FROM accounts
         WHERE account_name = $1 AND is_active = true`,
        [accountName]
      )

      if (result.rowCount === 0) {
        return null
      }

      return this.decryptAccount(result.rows[0])
    } catch (error) {
      logger.error('Failed to get account from database', {
        metadata: {
          accountName,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      throw error
    }
  }

  async getApiKey(accountName: string): Promise<string | null> {
    const account = await this.getAccountByName(accountName)
    if (!account) {
      return null
    }

    if (account.credentialType === 'api_key') {
      return account.apiKey || null
    }

    if (account.credentialType === 'oauth') {
      // Check if token needs refresh (1 minute buffer)
      if (account.oauthExpiresAt && Date.now() >= account.oauthExpiresAt - 60000) {
        logger.debug('OAuth token expired, needs refresh', {
          metadata: {
            accountName,
            expiresAt: new Date(account.oauthExpiresAt).toISOString(),
          },
        })
        // Return null to trigger refresh in CredentialManager
        return null
      }

      return account.oauthAccessToken || null
    }

    return null
  }

  async updateOAuthTokens(
    accountName: string,
    tokens: {
      accessToken: string
      refreshToken?: string
      expiresAt: number
      scopes?: string[]
      isMax?: boolean
    }
  ): Promise<void> {
    const client = await this.db.connect()

    try {
      await client.query('BEGIN')

      // Lock the row to prevent concurrent updates
      const selectResult = await client.query<DatabaseAccount>(
        `SELECT account_id, account_name, credential_type
         FROM accounts
         WHERE account_name = $1 AND is_active = true
         FOR UPDATE`,
        [accountName]
      )

      if (selectResult.rowCount === 0) {
        throw new AuthenticationError('Account not found for OAuth token update', {
          account: accountName,
          hint: `Account ${accountName} does not exist or is inactive`,
        })
      }

      const account = selectResult.rows[0]
      if (account.credentialType !== 'oauth') {
        throw new AuthenticationError('Cannot update OAuth tokens for non-OAuth account', {
          account: accountName,
        })
      }

      // Encrypt new tokens
      const encryptedAccessToken = encrypt(tokens.accessToken, this.encryptionKey)
      const encryptedRefreshToken = tokens.refreshToken
        ? encrypt(tokens.refreshToken, this.encryptionKey)
        : null

      // Update the account
      await client.query(
        `UPDATE accounts
         SET oauth_access_token_encrypted = $1,
             oauth_refresh_token_encrypted = COALESCE($2, oauth_refresh_token_encrypted),
             oauth_expires_at = $3,
             oauth_scopes = $4,
             oauth_is_max = $5,
             updated_at = NOW()
         WHERE account_name = $6`,
        [
          encryptedAccessToken,
          encryptedRefreshToken,
          tokens.expiresAt,
          tokens.scopes || null,
          tokens.isMax !== undefined ? tokens.isMax : null,
          accountName,
        ]
      )

      await client.query('COMMIT')

      logger.info('OAuth tokens updated successfully', {
        metadata: {
          accountName,
          expiresAt: new Date(tokens.expiresAt).toISOString(),
        },
      })
    } catch (error) {
      await client.query('ROLLBACK')
      logger.error('Failed to update OAuth tokens', {
        metadata: {
          accountName,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      throw error
    } finally {
      client.release()
    }
  }

  async updateLastUsed(accountName: string): Promise<void> {
    try {
      await this.db.query(
        'UPDATE accounts SET last_used_at = NOW() WHERE account_name = $1 AND is_active = true',
        [accountName]
      )
    } catch (error) {
      // Don't fail on last_used_at update errors
      logger.warn('Failed to update last_used_at', {
        metadata: {
          accountName,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  clearCache(): void {
    // Database implementation doesn't cache
    // No-op for compatibility
  }

  private decryptAccount(dbAccount: {
    account_id: string
    account_name: string
    credential_type: 'api_key' | 'oauth'
    api_key_encrypted?: string
    oauth_access_token_encrypted?: string
    oauth_refresh_token_encrypted?: string
    oauth_expires_at?: number
    oauth_scopes?: string[]
    oauth_is_max?: boolean
    is_active: boolean
    last_used_at?: Date
  }): DecryptedAccount {
    const decrypted: DecryptedAccount = {
      accountId: dbAccount.account_id,
      accountName: dbAccount.account_name,
      credentialType: dbAccount.credential_type,
      isActive: dbAccount.is_active,
      lastUsedAt: dbAccount.last_used_at,
    }

    if (dbAccount.credential_type === 'api_key' && dbAccount.api_key_encrypted) {
      decrypted.apiKey = decrypt(dbAccount.api_key_encrypted, this.encryptionKey)
    }

    if (dbAccount.credential_type === 'oauth') {
      if (dbAccount.oauth_access_token_encrypted) {
        decrypted.oauthAccessToken = decrypt(
          dbAccount.oauth_access_token_encrypted,
          this.encryptionKey
        )
      }
      if (dbAccount.oauth_refresh_token_encrypted) {
        decrypted.oauthRefreshToken = decrypt(
          dbAccount.oauth_refresh_token_encrypted,
          this.encryptionKey
        )
      }
      decrypted.oauthExpiresAt = dbAccount.oauth_expires_at
      decrypted.oauthScopes = dbAccount.oauth_scopes
      decrypted.oauthIsMax = dbAccount.oauth_is_max
    }

    return decrypted
  }
}
