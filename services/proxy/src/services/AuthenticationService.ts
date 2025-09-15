import { getApiKey, loadCredentials } from '../credentials'
import { AuthenticationError } from '@agent-prompttrain/shared'
import { RequestContext } from '../domain/value-objects/RequestContext'
import { logger } from '../middleware/logger'
import * as path from 'path'
import * as fs from 'fs'
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
  
  constructor(
    private defaultApiKey?: string,
    private credentialsDir: string = process.env.CREDENTIALS_DIR || 'credentials'
  ) {
    // Load all available account credential files
    this.loadAvailableAccounts()
  }

  /**
   * Load list of available account credential files
   */
  private loadAvailableAccounts(): void {
    try {
      if (!fs.existsSync(this.credentialsDir)) {
        logger.warn('Credentials directory does not exist', { dir: this.credentialsDir })
        return
      }

      const files = fs.readdirSync(this.credentialsDir)
      this.availableAccounts.length = 0 // Clear array
      
      for (const file of files) {
        if (file.endsWith('.credentials.json')) {
          // Extract account name from filename (remove .credentials.json)
          const accountName = file.replace('.credentials.json', '')
          this.availableAccounts.push(accountName)
        }
      }

      logger.info('Loaded available accounts', { 
        count: this.availableAccounts.length,
        accounts: this.availableAccounts 
      })
    } catch (error) {
      logger.error('Failed to load available accounts', { error })
    }
  }

  /**
   * Map train-id to an account using consistent hashing
   */
  private mapTrainIdToAccount(trainId: string): string | null {
    if (this.availableAccounts.length === 0) {
      return null
    }

    // Use consistent hashing to map train-id to account
    const hash = crypto.createHash('sha256').update(trainId).digest()
    const hashValue = hash.readUInt32BE(0)
    const index = hashValue % this.availableAccounts.length
    
    return this.availableAccounts[index]
  }

  /**
   * Authenticate request based on train-id
   */
  async authenticate(context: RequestContext): Promise<AuthResult> {
    const trainId = context.get('trainId') || 'default'

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
    
    if (!fs.existsSync(credentialPath)) {
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
      account: accountName,
      type: credentials.type,
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
  async getClientApiKey(trainId: string): Promise<string | null> {
    // For now, return null - client auth will be handled differently with train-id
    return null
  }

  /**
   * Get Slack config for a train-id
   */
  async getSlackConfig(trainId: string): Promise<any> {
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