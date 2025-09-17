import { getApiKey, loadCredentials, SlackConfig, ClaudeCredentials } from '../credentials'
import { AuthenticationError } from '@agent-prompttrain/shared'
import { RequestContext } from '../domain/value-objects/RequestContext'
import { logger } from '../middleware/logger'
import * as path from 'path'
import * as fs from 'fs'

export interface AuthResult {
  type: 'api_key' | 'oauth'
  headers: Record<string, string>
  key: string
  betaHeader?: string
  accountId?: string // Account identifier from credentials
}

const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

/**
 * Authentication service responsible for mapping train IDs to credential files
 * and producing Anthropic authorization headers.
 */
export class AuthenticationService {
  constructor(
    private defaultApiKey?: string,
    private credentialsDir: string = process.env.CREDENTIALS_DIR || 'credentials'
  ) {}

  private isPersonalTrain(trainId: string): boolean {
    return trainId.toLowerCase().includes('personal')
  }

  /**
   * Ensure a requested train ID maps to a credential file on disk without
   * allowing path escape attempts.
   */
  private getSafeCredentialPath(trainId: string): string | null {
    const trimmed = trainId.trim()
    if (!trimmed) {
      return null
    }

    const validId = /^[a-zA-Z0-9._\-:]+$/
    if (!validId.test(trimmed)) {
      logger.warn('Train ID contains invalid characters', { trainId })
      return null
    }

    if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
      logger.warn('Train ID contains path traversal attempt', { trainId })
      return null
    }

    const fileName = `${trimmed}.credentials.json`
    const resolvedDir = this.credentialsDir.startsWith('/') || this.credentialsDir.includes(':')
      ? this.credentialsDir
      : path.join(process.cwd(), this.credentialsDir)
    const credentialPath = path.join(resolvedDir, fileName)

    const resolvedCredsDir = path.resolve(resolvedDir)
    const resolvedCredentialPath = path.resolve(credentialPath)

    if (!resolvedCredentialPath.startsWith(resolvedCredsDir + path.sep)) {
      logger.error('Path traversal attempt detected while resolving credential path', {
        trainId,
        metadata: {
          attemptedPath: credentialPath,
          credentialsDir: resolvedDir,
        },
      })
      return null
    }

    return credentialPath
  }

  private async credentialFileExists(filePath: string | null): Promise<string | null> {
    if (!filePath) {
      return null
    }

    try {
      await fs.promises.access(filePath, fs.constants.F_OK)
      return filePath
    } catch {
      return null
    }
  }

  private async resolveCredentialPath(trainId: string): Promise<string | null> {
    const credentialPath = this.getSafeCredentialPath(trainId)
    return this.credentialFileExists(credentialPath)
  }

  async getSlackConfig(trainId: string): Promise<SlackConfig | null> {
    const credentialPath = await this.resolveCredentialPath(trainId)
    if (!credentialPath) {
      return null
    }

    const credentials = loadCredentials(credentialPath)
    if (credentials?.slack && credentials.slack.enabled !== false) {
      return credentials.slack
    }

    return null
  }

  async getClientApiKey(trainId: string): Promise<string | null> {
    const credentialPath = await this.resolveCredentialPath(trainId)
    if (!credentialPath) {
      logger.debug('No credentials found for train', { trainId })
      return null
    }

    try {
      const credentials = loadCredentials(credentialPath)
      return credentials?.client_api_key || null
    } catch (error) {
      logger.debug(`Failed to get client API key for train: ${trainId}`, {
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      })
      return null
    }
  }

  hasAuthentication(context: RequestContext): boolean {
    return !!(context.apiKey || this.defaultApiKey)
  }

  getMaskedCredentialInfo(auth: AuthResult): string {
    const maskedKey = auth.key.substring(0, 10) + '****'
    return `${auth.type}:${maskedKey}`
  }

  private async loadCredentialsForTrain(trainId: string, requestId: string): Promise<{
    credentialPath: string
    credentials: ClaudeCredentials
    apiKey: string
  }> {
    const credentialPath = await this.resolveCredentialPath(trainId)
    if (!credentialPath) {
      throw new AuthenticationError('No credentials configured for train', {
        trainId,
        requestId,
        hint: 'Provide credentials in credentials/<train-id>.credentials.json',
      })
    }

    const credentials = loadCredentials(credentialPath)
    if (!credentials) {
      throw new AuthenticationError('Failed to load credentials for train', {
        trainId,
        requestId,
        credentialPath,
      })
    }

    const safeCredentials = credentials

    const apiKey = await getApiKey(credentialPath)
    if (!apiKey) {
      throw new AuthenticationError('Failed to retrieve API key for train', {
        trainId,
        requestId,
      })
    }

    return { credentialPath, credentials, apiKey }
  }

  async authenticateNonPersonalDomain(context: RequestContext): Promise<AuthResult> {
    const trainId = context.trainId

    try {
      const { credentials, apiKey } = await this.loadCredentialsForTrain(trainId, context.requestId)
      const safeCredentials = credentials

      if (safeCredentials.type === 'oauth') {
        logger.info('Using OAuth credentials for train', {
          requestId: context.requestId,
          trainId,
          metadata: { accountId: safeCredentials.accountId },
        })

        return {
          type: 'oauth',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'anthropic-beta': OAUTH_BETA_HEADER,
          },
          key: apiKey,
          betaHeader: OAUTH_BETA_HEADER,
          accountId: safeCredentials.accountId,
        }
      }

      logger.info('Using API key credentials for train', {
        requestId: context.requestId,
        trainId,
        metadata: { accountId: safeCredentials.accountId },
      })

      return {
        type: 'api_key',
        headers: {
          'x-api-key': apiKey,
        },
        key: apiKey,
        accountId: safeCredentials.accountId,
      }
    } catch (error) {
      logger.error('Authentication failed for train', {
        requestId: context.requestId,
        trainId,
        error:
          error instanceof Error
            ? { message: error.message, code: (error as any).code }
            : { message: String(error) },
      })

      if (error instanceof AuthenticationError) {
        throw error
      }

      throw new AuthenticationError('Authentication failed', {
        originalError: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async authenticatePersonalDomain(context: RequestContext): Promise<AuthResult> {
    const trainId = context.trainId

    try {
      const credentialPath = await this.resolveCredentialPath(trainId)

      if (credentialPath) {
        const credentials = loadCredentials(credentialPath)
        if (credentials) {
          logger.debug('Found credentials file for personal train', {
            requestId: context.requestId,
            trainId,
            metadata: { credentialType: credentials.type },
          })

          const apiKey = await getApiKey(credentialPath)
          if (apiKey) {
            if (credentials.type === 'oauth') {
              return {
                type: 'oauth',
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  'anthropic-beta': OAUTH_BETA_HEADER,
                },
                key: apiKey,
                betaHeader: OAUTH_BETA_HEADER,
              }
            }

            return {
              type: 'api_key',
              headers: {
                'x-api-key': apiKey,
              },
              key: apiKey,
            }
          }
        }
      }

      if (context.apiKey && context.apiKey.startsWith('Bearer ')) {
        const bearer = context.apiKey.replace('Bearer ', '')
        logger.debug('Using Bearer token from request header for personal train', {
          requestId: context.requestId,
          trainId,
        })

        return {
          type: 'oauth',
          headers: {
            Authorization: context.apiKey,
            'anthropic-beta': OAUTH_BETA_HEADER,
          },
          key: bearer,
          betaHeader: OAUTH_BETA_HEADER,
        }
      }

      if (this.defaultApiKey) {
        logger.debug('Using default API key for personal train', {
          requestId: context.requestId,
          trainId,
        })

        return {
          type: 'api_key',
          headers: {
            'x-api-key': this.defaultApiKey,
          },
          key: this.defaultApiKey,
        }
      }

      throw new AuthenticationError('Authentication required', {
        trainId,
        requestId: context.requestId,
        hint: 'Provide credentials for personal trains or set a default API key',
      })
    } catch (error) {
      logger.error('Authentication failed for personal train', {
        requestId: context.requestId,
        trainId,
        error:
          error instanceof Error
            ? { message: error.message, code: (error as any).code }
            : { message: String(error) },
      })

      if (error instanceof AuthenticationError) {
        throw error
      }

      throw new AuthenticationError('Authentication failed', {
        originalError: error instanceof Error ? error.message : String(error),
      })
    }
  }

  clearResolutionCache(): void {
    // No-op: resolver no longer caches results
  }

  destroy(): void {
    // No-op retained for compatibility
  }
}
