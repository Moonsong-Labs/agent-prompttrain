import { getApiKey, loadCredentials } from '../credentials'
import { AuthenticationError } from '@agent-prompttrain/shared'
import { RequestContext } from '../domain/value-objects/RequestContext'
import { logger } from '../middleware/logger'
import * as path from 'path'
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as crypto from 'crypto'

export interface AuthResult {
  type: 'api_key' | 'oauth'
  headers: Record<string, string>
  key: string
  betaHeader?: string
  accountId?: string // Account identifier from credentials
}

/**
 * Service responsible for authentication logic
 * Handles API keys, OAuth tokens, and credential resolution based on train-id
 */
export class AuthenticationService {
  private readonly availableAccounts: string[] = []
  private initialized = false

  constructor(
    private defaultApiKey?: string,
    private credentialsDir: string = process.env.CREDENTIALS_DIR || 'credentials'
  ) {
    // Constructor no longer performs file I/O operations
    // Call initialize() to load accounts asynchronously
  }

  /**
   * Initialize the service by loading available accounts
   * This should be called after construction to load credential files
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }

    await this.loadAvailableAccounts()
    this.initialized = true

    logger.info('AuthenticationService initialized successfully', {
      metadata: {
        accountCount: this.availableAccounts.length,
        credentialsDir: this.credentialsDir,
      },
    })
  }

  /**
   * Check if the service has been initialized
   */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * Load list of available account credential files asynchronously
   */
  private async loadAvailableAccounts(): Promise<void> {
    try {
      // Use synchronous existsSync for initial directory check since it's fast
      if (!existsSync(this.credentialsDir)) {
        logger.warn('Credentials directory does not exist', {
          metadata: { dir: this.credentialsDir },
        })
        return
      }

      // Use async readdir to avoid blocking event loop
      const files = await fs.readdir(this.credentialsDir)
      this.availableAccounts.length = 0 // Clear array

      for (const file of files) {
        if (file.endsWith('.credentials.json')) {
          // Extract account name from filename (remove .credentials.json)
          const accountName = file.replace('.credentials.json', '')
          this.availableAccounts.push(accountName)
        }
      }

      logger.info('Loaded available accounts', {
        metadata: {
          count: this.availableAccounts.length,
          accounts: this.availableAccounts,
        },
      })
    } catch (error) {
      logger.error('Failed to load available accounts', {
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          credentialsDir: this.credentialsDir,
        },
      })
      // Don't throw, just log the error and continue with empty accounts list
    }
  }

  /**
   * Map train-id to an account using consistent hashing
   *
   * This method ensures deterministic and evenly distributed mapping of train-ids
   * to available accounts using SHA-256 hashing and proper modulo operations.
   *
   * @param trainId The train-id string to map to an account
   * @returns The account name for the train-id, or null if no accounts available
   */
  private mapTrainIdToAccount(trainId: string): string | null {
    if (this.availableAccounts.length === 0) {
      return null
    }

    // Use SHA-256 for consistent hashing to ensure deterministic mapping
    const hash = crypto.createHash('sha256').update(trainId).digest()

    // Read first 32 bits as unsigned integer for hash distribution
    const hashValue = hash.readUInt32BE(0)

    // Use modulo with array length to get even distribution across accounts
    // This ensures each train-id consistently maps to the same account
    const index = hashValue % this.availableAccounts.length

    return this.availableAccounts[index]
  }

  /**
   * Authenticate request based on train-id
   */
  async authenticate(context: RequestContext): Promise<AuthResult> {
    if (!this.initialized) {
      throw new AuthenticationError('AuthenticationService not initialized', {
        trainId: context.trainId,
        requestId: context.requestId,
      })
    }
    const trainId = context.trainId || 'default'

    // For default train-id, use default API key if available
    if (trainId === 'default') {
      if (this.defaultApiKey) {
        return {
          type: 'api_key',
          headers: {
            'x-api-key': this.defaultApiKey,
          },
          key: this.defaultApiKey,
        }
      }
      throw new AuthenticationError('No default API key configured', {
        trainId,
        requestId: context.requestId,
      })
    }

    // Map train-id to an account
    const accountName = this.mapTrainIdToAccount(trainId)
    if (!accountName) {
      throw new AuthenticationError('No accounts available for authentication', {
        trainId,
        requestId: context.requestId,
      })
    }

    // Load credentials for the mapped account
    const credentialPath = path.join(this.credentialsDir, `${accountName}.credentials.json`)

    if (!existsSync(credentialPath)) {
      throw new AuthenticationError('Account credentials not found', {
        trainId,
        account: accountName,
        requestId: context.requestId,
      })
    }

    const credentials = loadCredentials(credentialPath)
    if (!credentials) {
      throw new AuthenticationError('Failed to load credentials', {
        trainId,
        account: accountName,
        requestId: context.requestId,
      })
    }

    const apiKey = await getApiKey(credentialPath)
    if (!apiKey) {
      throw new AuthenticationError('Failed to retrieve API key', {
        trainId,
        account: accountName,
        requestId: context.requestId,
      })
    }

    logger.info('Authentication successful', {
      requestId: context.requestId,
      trainId,
      metadata: {
        account: accountName,
        type: credentials.type,
      },
    })

    // Return auth based on credential type
    if (credentials.type === 'oauth') {
      return {
        type: 'oauth',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        key: apiKey,
        betaHeader: credentials.betaHeader || 'oauth-2025-04-20',
        accountId: credentials.accountId || accountName,
      }
    } else {
      return {
        type: 'api_key',
        headers: {
          'x-api-key': apiKey,
        },
        key: apiKey,
        betaHeader: credentials.betaHeader || 'oauth-2025-04-20',
        accountId: credentials.accountId || accountName,
      }
    }
  }

  /**
   * Get client API key for a train-id (for client authentication)
   */
  async getClientApiKey(_trainId: string): Promise<string | null> {
    // For now, return null - client auth will be handled differently with train-id
    return null
  }

  /**
   * Get Slack config for a train-id
   */
  async getSlackConfig(_trainId: string): Promise<any> {
    // For now, return null - Slack config will be handled differently with train-id
    return null
  }

  /**
   * Get masked credential info
   */
  getMaskedCredentialInfo(auth: AuthResult): string {
    if (auth.type === 'oauth') {
      return `OAuth:${auth.accountId || 'unknown'}`
    }
    return `API:${auth.key.substring(0, 10)}...`
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    // No longer need cache cleanup
  }
}
