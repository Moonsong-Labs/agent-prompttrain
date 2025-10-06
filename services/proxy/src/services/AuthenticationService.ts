import { createHash } from 'crypto'
import type { SlackConfig, ClaudeCredentials } from '../credentials'
import { AuthenticationError } from '@agent-prompttrain/shared'
import { RequestContext } from '../domain/value-objects/RequestContext'
import { logger } from '../middleware/logger'
import type { IAccountRepository } from '../repositories/IAccountRepository'
import type { ITrainRepository } from '../repositories/ITrainRepository'

export interface AuthResult {
  type: 'api_key' | 'oauth'
  headers: Record<string, string>
  key: string
  betaHeader?: string
  accountId?: string
  accountName: string
  slackConfig?: SlackConfig | null
}

interface AuthenticationServiceOptions {
  defaultApiKey?: string
  accountCacheTtlMs?: number
  accountRepository: IAccountRepository
  trainRepository: ITrainRepository
}

const OAUTH_BETA_HEADER = 'oauth-2025-04-20'
const IDENTIFIER_REGEX = /^[a-zA-Z0-9._\-:]+$/

/**
 * Authentication service responsible for selecting account credentials
 * based on request metadata and producing headers for Anthropic API calls.
 */
export class AuthenticationService {
  private readonly defaultApiKey?: string
  private readonly accountCacheTtl: number
  private readonly accountRepository: IAccountRepository
  private readonly trainRepository: ITrainRepository

  constructor(options: AuthenticationServiceOptions) {
    this.defaultApiKey = options.defaultApiKey
    this.accountCacheTtl = options.accountCacheTtlMs ?? 5 * 60 * 1000
    this.accountRepository = options.accountRepository
    this.trainRepository = options.trainRepository
  }

  /**
   * Authenticate a request using the selected account.
   */
  async authenticate(context: RequestContext): Promise<AuthResult> {
    const requestedAccount = context.account
    const requestId = context.requestId

    const availableAccounts = await this.accountRepository.listAccountNames()

    if (!availableAccounts.length) {
      throw new AuthenticationError('No accounts are configured for the proxy', {
        requestId,
        hint: 'Add account credentials to the database',
      })
    }

    if (requestedAccount) {
      return this.loadAccount(requestedAccount, context)
    }

    return this.loadDeterministicAccount(availableAccounts, context)
  }

  /**
   * Retrieve the list of valid client API keys for a train.
   */
  async getClientApiKeys(trainId: string): Promise<string[]> {
    return await this.trainRepository.getClientApiKeysHashed(trainId)
  }

  getMaskedCredentialInfo(auth: AuthResult): string {
    const maskedKey = auth.key.substring(0, 10) + '****'
    return `${auth.type}:${maskedKey}`
  }

  clearCaches(): void {
    this.accountRepository.clearCache()
  }

  destroy(): void {
    // No-op retained for compatibility
  }

  private async loadAccount(accountName: string, context: RequestContext): Promise<AuthResult> {
    const sanitized = this.sanitizeIdentifier(accountName)
    if (!sanitized) {
      throw new AuthenticationError('Account header contains invalid characters', {
        requestId: context.requestId,
        account: accountName,
      })
    }

    const account = await this.accountRepository.getAccountByName(sanitized)
    if (!account) {
      throw new AuthenticationError('No credentials configured for account', {
        requestId: context.requestId,
        account: sanitized,
        hint: 'Add account credentials to the database',
      })
    }

    // Get API key (handles OAuth token refresh automatically)
    const apiKey = await this.accountRepository.getApiKey(sanitized)
    if (!apiKey) {
      throw new AuthenticationError('Failed to retrieve API key for account', {
        requestId: context.requestId,
        account: sanitized,
      })
    }

    // Build credentials object for compatibility with buildAuthResult
    const credentials: ClaudeCredentials = {
      type: account.credentialType,
      accountId: account.accountId,
      api_key: account.credentialType === 'api_key' ? account.apiKey : undefined,
      oauth:
        account.credentialType === 'oauth'
          ? {
              accessToken: account.oauthAccessToken || '',
              refreshToken: account.oauthRefreshToken || '',
              expiresAt: account.oauthExpiresAt || 0,
              scopes: account.oauthScopes || [],
              isMax: account.oauthIsMax || true,
            }
          : undefined,
      slack: undefined, // TODO: Add slack config support when needed
    }

    return this.buildAuthResult(sanitized, credentials, apiKey, context)
  }

  private async loadDeterministicAccount(
    accounts: string[],
    context: RequestContext
  ): Promise<AuthResult> {
    if (!accounts.length) {
      throw new AuthenticationError('No valid accounts available for authentication', {
        requestId: context.requestId,
      })
    }

    if (accounts.length === 1) {
      return this.loadAccount(accounts[0], context)
    }

    const orderedAccounts = this.rankAccounts(context.trainId, accounts)

    logger.debug('Deterministic account selection computed', {
      requestId: context.requestId,
      trainId: context.trainId,
      metadata: { preferredAccount: orderedAccounts[0] },
    })

    for (const accountName of orderedAccounts) {
      try {
        return await this.loadAccount(accountName, context)
      } catch (error) {
        logger.warn('Skipping account due to credential load failure', {
          requestId: context.requestId,
          metadata: {
            accountName,
            error: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }

    throw new AuthenticationError('No valid accounts available for authentication', {
      requestId: context.requestId,
    })
  }

  private rankAccounts(trainId: string | undefined, accounts: string[]): string[] {
    if (!accounts.length) {
      return []
    }

    const trainKey = this.sanitizeIdentifier(trainId) || trainId?.trim() || 'default'
    const sortedAccounts = [...new Set(accounts)].sort()

    const scored = sortedAccounts.map(accountName => {
      const hashInput = `${trainKey}::${accountName}`
      const digest = createHash('sha256').update(hashInput).digest()
      const score = digest.readBigUInt64BE(0)
      return { accountName, score }
    })

    scored.sort((a, b) => {
      if (a.score === b.score) {
        return a.accountName.localeCompare(b.accountName)
      }
      return a.score > b.score ? -1 : 1
    })

    return scored.map(entry => entry.accountName)
  }

  private buildAuthResult(
    accountName: string,
    credentials: ClaudeCredentials,
    apiKey: string,
    context: RequestContext
  ): AuthResult {
    if (credentials.type === 'oauth') {
      logger.info('Using OAuth credentials for account', {
        requestId: context.requestId,
        trainId: context.trainId,
        metadata: { accountName, accountId: credentials.accountId },
      })

      return {
        type: 'oauth',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
        },
        key: apiKey,
        betaHeader: OAUTH_BETA_HEADER,
        accountId: credentials.accountId,
        accountName,
        slackConfig: credentials.slack ?? null,
      }
    }

    logger.info('Using API key credentials for account', {
      requestId: context.requestId,
      trainId: context.trainId,
      metadata: { accountName, accountId: credentials.accountId },
    })

    return {
      type: 'api_key',
      headers: {
        'x-api-key': apiKey,
      },
      key: apiKey,
      accountId: credentials.accountId,
      accountName,
      slackConfig: credentials.slack ?? null,
    }
  }

  private sanitizeIdentifier(value?: string | null): string | null {
    if (!value) {
      return null
    }

    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }

    if (!IDENTIFIER_REGEX.test(trimmed)) {
      return null
    }

    return trimmed
  }
}
