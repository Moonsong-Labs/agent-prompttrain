import { promises as fsp } from 'fs'
import * as path from 'path'
import { IAccountRepository } from './IAccountRepository'
import { DecryptedAccount } from '@agent-prompttrain/shared'
import { loadCredentials, getApiKey, ClaudeCredentials } from '../credentials'
import { logger } from '../middleware/logger'

const ACCOUNT_FILENAME_SUFFIX = '.credentials.json'

/**
 * Filesystem-based implementation of IAccountRepository.
 *
 * This wraps the existing credentials.ts logic to maintain
 * 100% backward compatibility with the current filesystem-based
 * credential management.
 */
export class FilesystemAccountRepository implements IAccountRepository {
  constructor(private readonly accountsDir: string) {}

  async listAccountNames(): Promise<string[]> {
    try {
      const entries = await fsp.readdir(this.accountsDir)
      const names = entries
        .filter(entry => entry.endsWith(ACCOUNT_FILENAME_SUFFIX))
        .map(entry => entry.slice(0, -ACCOUNT_FILENAME_SUFFIX.length))

      return names
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        logger.error('Accounts directory does not exist', {
          metadata: { directory: this.accountsDir },
        })
        return []
      }

      logger.error('Failed to enumerate account credentials', {
        metadata: {
          directory: this.accountsDir,
          error: err.message,
        },
      })
      throw err
    }
  }

  async getAccountByName(accountName: string): Promise<DecryptedAccount | null> {
    const accountPath = this.resolveAccountPath(accountName)
    if (!accountPath) {
      return null
    }

    const credentials = loadCredentials(accountPath)
    if (!credentials) {
      return null
    }

    return this.mapToDecryptedAccount(accountName, credentials)
  }

  async getApiKey(accountName: string): Promise<string | null> {
    const accountPath = this.resolveAccountPath(accountName)
    if (!accountPath) {
      return null
    }

    // Delegate to existing getApiKey function which handles OAuth refresh
    return getApiKey(accountPath)
  }

  async updateOAuthTokens(
    _accountName: string,
    _tokens: {
      accessToken: string
      refreshToken?: string
      expiresAt: number
      scopes?: string[]
      isMax?: boolean
    }
  ): Promise<void> {
    // Note: The existing credentials.ts saveOAuthCredentials function
    // is called automatically by getApiKey during refresh.
    // This method is here for interface compatibility but is a no-op
    // for filesystem implementation since the update happens in-place.
  }

  async updateLastUsed(_accountName: string): Promise<void> {
    // Filesystem implementation doesn't track last_used_at
    // This is a no-op for backward compatibility
  }

  clearCache(): void {
    // Delegate to the global credential cache clear function
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { clearCredentialCache } = require('../credentials')
    clearCredentialCache()
  }

  private resolveAccountPath(accountName: string): string | null {
    const filePath = path.resolve(this.accountsDir, `${accountName}${ACCOUNT_FILENAME_SUFFIX}`)

    // Basic path traversal check
    const normalizedBase = path.resolve(this.accountsDir) + path.sep
    const normalizedCandidate = path.resolve(filePath)

    if (!normalizedCandidate.startsWith(normalizedBase)) {
      logger.error('Path traversal attempt detected', {
        metadata: {
          baseDir: normalizedBase,
          candidate: normalizedCandidate,
        },
      })
      return null
    }

    return filePath
  }

  private mapToDecryptedAccount(
    accountName: string,
    credentials: ClaudeCredentials
  ): DecryptedAccount {
    if (credentials.type === 'oauth' && credentials.oauth) {
      return {
        accountId: credentials.accountId || accountName,
        accountName,
        credentialType: 'oauth',
        oauthAccessToken: credentials.oauth.accessToken,
        oauthRefreshToken: credentials.oauth.refreshToken,
        oauthExpiresAt: credentials.oauth.expiresAt,
        oauthScopes: credentials.oauth.scopes,
        oauthIsMax: credentials.oauth.isMax,
        isActive: true, // Filesystem accounts are always considered active
        lastUsedAt: undefined, // Not tracked in filesystem
      }
    }

    return {
      accountId: credentials.accountId || accountName,
      accountName,
      credentialType: 'api_key',
      apiKey: credentials.api_key,
      isActive: true,
      lastUsedAt: undefined,
    }
  }
}
