import { createHash, timingSafeEqual as cryptoTimingSafeEqual } from 'crypto'
import { promises as fsp } from 'fs'
import * as path from 'path'
import { homedir } from 'os'
import { getApiKey, loadCredentials, SlackConfig, ClaudeCredentials } from '../credentials'
import { AuthenticationError, DecryptedAccount } from '@agent-prompttrain/shared'
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
  accountsDir: string
  clientKeysDir: string
  accountCacheTtlMs?: number
  accountRepository?: IAccountRepository
  trainRepository?: ITrainRepository
}

const OAUTH_BETA_HEADER = 'oauth-2025-04-20'
const ACCOUNT_FILENAME_SUFFIX = '.credentials.json'
const CLIENT_KEY_FILENAME_SUFFIX = '.client-keys.json'
const IDENTIFIER_REGEX = /^[a-zA-Z0-9._\-:]+$/

interface CachedAccountList {
  names: string[]
  expiresAt: number
}

/**
 * Authentication service responsible for selecting account credentials
 * based on request metadata and producing headers for Anthropic API calls.
 */
export class AuthenticationService {
  private readonly defaultApiKey?: string
  private readonly accountsDir: string
  private readonly clientKeysDir: string
  private readonly accountCacheTtl: number
  private readonly accountRepository?: IAccountRepository
  private readonly trainRepository?: ITrainRepository
  private accountCache: CachedAccountList | null = null

  constructor(options: AuthenticationServiceOptions) {
    this.defaultApiKey = options.defaultApiKey
    this.accountsDir = this.resolveDirectory(options.accountsDir)
    this.clientKeysDir = this.resolveDirectory(options.clientKeysDir)
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

    const availableAccounts = await this.getAvailableAccounts(context)

    if (!availableAccounts.length) {
      throw new AuthenticationError('No accounts are configured for the proxy', {
        requestId,
        hint: this.accountRepository
          ? 'Enable at least one active account in the credential repository'
          : `Add account credential files under ${this.accountsDir}`,
      })
    }

    if (requestedAccount) {
      return this.loadAccount(requestedAccount, context)
    }

    return this.loadDeterministicAccount(availableAccounts, context)
  }

  private async getAvailableAccounts(context: RequestContext): Promise<string[]> {
    const trainId = context.trainId

    if (this.trainRepository && trainId) {
      try {
        const mappedAccounts = await this.trainRepository.getAccountNamesForTrain(trainId)
        if (mappedAccounts.length > 0) {
          return mappedAccounts
        }
      } catch (error) {
        logger.warn('Failed to load train-specific account mappings', {
          requestId: context.requestId,
          trainId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return this.listAccounts()
  }

  /**
   * Retrieve the list of valid client API keys for a train.
   */
  async getClientApiKeys(trainId: string): Promise<string[]> {
    if (this.trainRepository) {
      logger.debug(
        'getClientApiKeys called while train repository is enabled; returning empty list'
      )
      return []
    }

    return this.readClientApiKeysFromFilesystem(trainId)
  }

  async hasClientKeys(trainId: string): Promise<boolean> {
    if (this.trainRepository) {
      try {
        return await this.trainRepository.hasClientKeys(trainId)
      } catch (error) {
        logger.error('Failed to check client key configuration from repository', {
          trainId,
          error: error instanceof Error ? error.message : String(error),
        })
        return false
      }
    }

    const keys = await this.readClientApiKeysFromFilesystem(trainId)
    return keys.length > 0
  }

  async validateClientKey(trainId: string, clientKey: string): Promise<boolean> {
    if (!clientKey || !clientKey.trim()) {
      return false
    }

    if (this.trainRepository) {
      try {
        return await this.trainRepository.validateClientKey(trainId, clientKey)
      } catch (error) {
        logger.error('Failed to validate client key via repository', {
          trainId,
          error: error instanceof Error ? error.message : String(error),
        })
        return false
      }
    }

    const keys = await this.readClientApiKeysFromFilesystem(trainId)
    if (!keys.length) {
      return false
    }

    const tokenHash = this.hashClientKey(clientKey)
    for (const key of keys) {
      const keyHash = this.hashClientKey(key)
      if (keyHash.length === tokenHash.length && cryptoTimingSafeEqual(keyHash, tokenHash)) {
        return true
      }
    }

    return false
  }

  usesTrainRepository(): boolean {
    return Boolean(this.trainRepository)
  }

  private async readClientApiKeysFromFilesystem(trainId: string): Promise<string[]> {
    const filePath = this.resolveClientKeysPath(trainId)
    if (!filePath) {
      return []
    }

    try {
      const content = await fsp.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(content)

      const rawKeys = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.keys)
          ? parsed.keys
          : Array.isArray(parsed?.client_api_keys)
            ? parsed.client_api_keys
            : []

      return rawKeys
        .filter((key: unknown) => typeof key === 'string' && key.trim().length > 0)
        .map((key: string) => key.trim())
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code !== 'ENOENT') {
        logger.error('Failed to read client API keys file', {
          trainId,
          error: err.message,
        })
      }
      return []
    }
  }

  private hashClientKey(value: string): Buffer {
    return createHash('sha256').update(value.trim()).digest()
  }

  getMaskedCredentialInfo(auth: AuthResult): string {
    const maskedKey = auth.key.substring(0, 10) + '****'
    return `${auth.type}:${maskedKey}`
  }

  clearCaches(): void {
    this.accountCache = null
    if (this.accountRepository) {
      this.accountRepository.clearCache()
    }
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

    if (this.accountRepository) {
      return this.loadAccountFromRepository(sanitized, context)
    }

    return this.loadAccountFromFilesystem(sanitized, context)
  }

  private async loadAccountFromFilesystem(
    accountName: string,
    context: RequestContext
  ): Promise<AuthResult> {
    const accountPath = this.resolveAccountPath(accountName)
    if (!accountPath) {
      throw new AuthenticationError('Account credential path is invalid', {
        requestId: context.requestId,
        account: accountName,
      })
    }

    const credentials = loadCredentials(accountPath)
    if (!credentials) {
      throw new AuthenticationError('No credentials configured for account', {
        requestId: context.requestId,
        account: accountName,
        hint: `Create ${accountName}${ACCOUNT_FILENAME_SUFFIX} under ${this.accountsDir}`,
      })
    }

    const apiKey = await getApiKey(accountPath)
    if (!apiKey) {
      throw new AuthenticationError('Failed to retrieve API key for account', {
        requestId: context.requestId,
        account: accountName,
      })
    }

    const slackConfig = await this.resolveSlackConfig(context.trainId, credentials.slack ?? null, {
      requestId: context.requestId,
      metadata: { accountName },
    })

    return this.buildAuthResult(accountName, credentials, apiKey, context, slackConfig)
  }

  private async loadAccountFromRepository(
    accountName: string,
    context: RequestContext
  ): Promise<AuthResult> {
    let account: DecryptedAccount | null

    try {
      account = await this.accountRepository!.getAccountByName(accountName)
    } catch (error) {
      logger.error('Failed to fetch account from credential repository', {
        requestId: context.requestId,
        metadata: {
          account: accountName,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      throw new AuthenticationError('Failed to load credentials for account', {
        requestId: context.requestId,
        account: accountName,
      })
    }

    if (!account || !account.isActive) {
      throw new AuthenticationError('No credentials configured for account', {
        requestId: context.requestId,
        account: accountName,
        hint: 'Enable the account in the credential repository',
      })
    }

    let apiKey: string | null
    try {
      apiKey = await this.accountRepository!.getApiKey(accountName)
    } catch (error) {
      logger.error('Failed to retrieve account secret from credential repository', {
        requestId: context.requestId,
        metadata: {
          account: accountName,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      throw new AuthenticationError('Failed to retrieve API key for account', {
        requestId: context.requestId,
        account: accountName,
      })
    }

    if (!apiKey) {
      throw new AuthenticationError('Failed to retrieve API key for account', {
        requestId: context.requestId,
        account: accountName,
        hint: 'Credential may need to be refreshed',
      })
    }

    // Update last-used timestamp asynchronously (non-blocking)
    void this.accountRepository!.updateLastUsed(accountName).catch(error =>
      logger.debug('Failed to update account last-used timestamp', {
        metadata: {
          account: accountName,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    )

    const slackConfig = await this.resolveSlackConfig(context.trainId, null, {
      requestId: context.requestId,
      metadata: { accountName },
    })

    return this.buildAuthResultFromDecryptedAccount(
      accountName,
      account,
      apiKey,
      context,
      slackConfig
    )
  }

  private async resolveSlackConfig(
    trainId: string | undefined,
    fallback: SlackConfig | null,
    context: { requestId?: string; metadata?: Record<string, unknown> }
  ): Promise<SlackConfig | null> {
    if (this.trainRepository && trainId) {
      try {
        const config = await this.trainRepository.getSlackConfig(trainId)
        if (config) {
          return config
        }
      } catch (error) {
        logger.warn('Failed to load Slack configuration for train', {
          trainId,
          requestId: context.requestId,
          metadata: {
            ...(context.metadata ?? {}),
            error: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }

    return fallback ?? null
  }

  private buildAuthResultFromDecryptedAccount(
    accountName: string,
    account: DecryptedAccount,
    apiKey: string,
    context: RequestContext,
    slackConfig: SlackConfig | null
  ): AuthResult {
    if (account.credentialType === 'oauth') {
      logger.info('Using OAuth credentials for account', {
        requestId: context.requestId,
        trainId: context.trainId,
        metadata: { accountName, accountId: account.accountId },
      })

      return {
        type: 'oauth',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
        },
        key: apiKey,
        betaHeader: OAUTH_BETA_HEADER,
        accountId: account.accountId,
        accountName,
        slackConfig,
      }
    }

    logger.info('Using API key credentials for account', {
      requestId: context.requestId,
      trainId: context.trainId,
      metadata: { accountName, accountId: account.accountId },
    })

    return {
      type: 'api_key',
      headers: {
        'x-api-key': apiKey,
      },
      key: apiKey,
      accountId: account.accountId,
      accountName,
      slackConfig,
    }
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
    context: RequestContext,
    slackConfig: SlackConfig | null
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
        slackConfig,
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
      slackConfig,
    }
  }

  private async listAccounts(): Promise<string[]> {
    // Use repository if available
    if (this.accountRepository) {
      return this.accountRepository.listAccountNames()
    }

    // Fall back to filesystem implementation
    const now = Date.now()
    if (this.accountCache && this.accountCache.expiresAt > now) {
      return this.accountCache.names
    }

    try {
      const entries = await fsp.readdir(this.accountsDir)
      const names = entries
        .filter(entry => entry.endsWith(ACCOUNT_FILENAME_SUFFIX))
        .map(entry => entry.slice(0, -ACCOUNT_FILENAME_SUFFIX.length))

      this.accountCache = {
        names,
        expiresAt: now + this.accountCacheTtl,
      }

      return names
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        logger.error('Accounts directory does not exist', {
          metadata: { directory: this.accountsDir },
        })
        this.accountCache = {
          names: [],
          expiresAt: now + this.accountCacheTtl,
        }
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

  private resolveAccountPath(accountName: string): string | null {
    const filePath = path.resolve(this.accountsDir, `${accountName}${ACCOUNT_FILENAME_SUFFIX}`)
    return this.guardPath(this.accountsDir, filePath) ? filePath : null
  }

  private resolveClientKeysPath(trainId: string): string | null {
    const sanitized = this.sanitizeIdentifier(trainId)
    if (!sanitized) {
      return null
    }
    const filePath = path.resolve(this.clientKeysDir, `${sanitized}${CLIENT_KEY_FILENAME_SUFFIX}`)
    return this.guardPath(this.clientKeysDir, filePath) ? filePath : null
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

  private resolveDirectory(dir: string): string {
    if (dir.startsWith('~')) {
      return path.resolve(homedir(), dir.slice(1))
    }
    if (path.isAbsolute(dir)) {
      return path.resolve(dir)
    }
    return path.resolve(process.cwd(), dir)
  }

  private guardPath(baseDir: string, candidate: string): boolean {
    const normalizedBase = path.resolve(baseDir) + path.sep
    const normalizedCandidate = path.resolve(candidate)

    if (!normalizedCandidate.startsWith(normalizedBase)) {
      logger.error('Path traversal attempt detected while resolving credential path', {
        metadata: {
          baseDir: normalizedBase,
          candidate: normalizedCandidate,
        },
      })
      return false
    }

    return true
  }
}
