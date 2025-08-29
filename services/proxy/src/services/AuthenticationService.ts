import { getApiKey, DomainCredentialMapping, loadCredentials, SlackConfig } from '../credentials'
import { AuthenticationError } from '@agent-prompttrain/shared'
import { RequestContext } from '../domain/value-objects/RequestContext'
import { logger } from '../middleware/logger'
import * as path from 'path'

export interface AuthResult {
  type: 'api_key' | 'oauth'
  headers: Record<string, string>
  key: string
  betaHeader?: string
  accountId?: string // Account identifier from credentials
}

/**
 * Service responsible for authentication logic
 * Handles API keys, OAuth tokens, and credential resolution
 */
export class AuthenticationService {
  private domainMapping: DomainCredentialMapping = {}
  private warnedDomains = new Set<string>()

  constructor(
    private defaultApiKey?: string,
    private credentialsDir: string = process.env.CREDENTIALS_DIR || 'credentials'
  ) {
    // Initialize domain mapping if needed
    // For now, we'll handle credentials dynamically
  }

  /**
   * Check if a domain is a personal domain
   */
  private isPersonalDomain(domain: string): boolean {
    return domain.toLowerCase().includes('personal')
  }

  /**
   * Authenticate non-personal domains - only uses domain credentials, no fallbacks
   */
  async authenticateNonPersonalDomain(context: RequestContext): Promise<AuthResult> {
    try {
      const sanitizedPath = this.getSafeCredentialPath(context.host)
      if (!sanitizedPath) {
        throw new AuthenticationError('Invalid domain name', {
          domain: context.host,
          requestId: context.requestId,
        })
      }

      const credentials = loadCredentials(sanitizedPath)
      if (!credentials) {
        throw new AuthenticationError('No credentials configured for domain', {
          domain: context.host,
          requestId: context.requestId,
          hint: 'Domain credentials are required for non-personal domains',
        })
      }

      const apiKey = await getApiKey(sanitizedPath)
      if (!apiKey) {
        throw new AuthenticationError('Failed to retrieve API key for domain', {
          domain: context.host,
          requestId: context.requestId,
        })
      }

      // Return auth based on credential type
      if (credentials.type === 'oauth') {
        logger.info(`Using OAuth credentials for non-personal domain`, {
          requestId: context.requestId,
          domain: context.host,
          metadata: {
            accountId: credentials.accountId,
          },
        })

        return {
          type: 'oauth',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'anthropic-beta': 'oauth-2025-04-20',
          },
          key: apiKey,
          betaHeader: 'oauth-2025-04-20',
          accountId: credentials.accountId,
        }
      } else {
        logger.info(`Using API key for non-personal domain`, {
          requestId: context.requestId,
          domain: context.host,
          metadata: {
            accountId: credentials.accountId,
          },
        })

        return {
          type: 'api_key',
          headers: {
            'x-api-key': apiKey,
          },
          key: apiKey,
          accountId: credentials.accountId,
        }
      }
    } catch (error) {
      logger.error('Authentication failed for non-personal domain', {
        requestId: context.requestId,
        domain: context.host,
        error:
          error instanceof Error
            ? {
                message: error.message,
                code: (error as any).code,
              }
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

  /**
   * Authenticate personal domains - uses fallback logic
   * Priority: Domain credentials → Bearer token → Default API key
   */
  async authenticatePersonalDomain(context: RequestContext): Promise<AuthResult> {
    try {
      // For personal domains, use the original priority logic
      // Priority order:
      // 1. Domain-specific credentials from file
      // 2. API key from request header (Bearer token only, not x-api-key)
      // 3. Default API key from environment

      // First, check if domain has a credential file
      const sanitizedPath = this.getSafeCredentialPath(context.host)
      if (!sanitizedPath) {
        logger.warn('Invalid domain name for credentials', {
          requestId: context.requestId,
          domain: context.host,
        })
        // Continue to fallback options
      }
      const credentialPath = sanitizedPath || ''

      // Try to load credentials without accessing the file system first
      try {
        const credentials = loadCredentials(credentialPath)

        if (credentials) {
          logger.debug(`Found credentials file for domain`, {
            requestId: context.requestId,
            domain: context.host,
            metadata: {
              credentialType: credentials.type,
            },
          })

          // Get API key from credentials
          const apiKey = await getApiKey(credentialPath)
          if (apiKey) {
            // Return auth result based on credential type
            if (credentials.type === 'oauth') {
              logger.debug(`Using OAuth credentials from file`, {
                requestId: context.requestId,
                domain: context.host,
                metadata: {
                  hasRefreshToken: !!credentials.oauth?.refreshToken,
                },
              })

              return {
                type: 'oauth',
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  'anthropic-beta': 'oauth-2025-04-20',
                },
                key: apiKey,
                betaHeader: 'oauth-2025-04-20',
                accountId: credentials.accountId,
              }
            } else {
              logger.debug(`Using API key from credential file`, {
                requestId: context.requestId,
                domain: context.host,
                metadata: {
                  keyPreview: apiKey.substring(0, 20) + '****',
                },
              })

              return {
                type: 'api_key',
                headers: {
                  'x-api-key': apiKey,
                },
                key: apiKey,
                accountId: credentials.accountId,
              }
            }
          }
        }
      } catch (_e) {
        // Credential file doesn't exist or couldn't be loaded, continue to fallback options
        if (!this.warnedDomains.has(context.host)) {
          logger.debug(`No credential file found for domain: ${context.host}`, {
            metadata: {
              expectedPath: credentialPath,
              credentialsDir: this.credentialsDir,
            },
          })
          this.warnedDomains.add(context.host)
        }
      }

      // For personal domains only: fallback to Bearer token from request or default API key
      if (context.apiKey && context.apiKey.startsWith('Bearer ')) {
        // Only accept Bearer tokens from Authorization header
        logger.debug(`Using Bearer token from request header for personal domain`, {
          requestId: context.requestId,
          domain: context.host,
          metadata: {
            authType: 'oauth',
            keyPreview: context.apiKey.substring(0, 20) + '****',
          },
        })

        return {
          type: 'oauth',
          headers: {
            Authorization: context.apiKey,
            'anthropic-beta': 'oauth-2025-04-20',
          },
          key: context.apiKey.replace('Bearer ', ''),
          betaHeader: 'oauth-2025-04-20',
          // Note: No accountId available when using Bearer token from request
        }
      } else if (this.defaultApiKey) {
        // Use default API key as last resort
        logger.debug(`Using default API key for personal domain`, {
          requestId: context.requestId,
          domain: context.host,
          metadata: {
            keyPreview: this.defaultApiKey.substring(0, 20) + '****',
          },
        })

        return {
          type: 'api_key',
          headers: {
            'x-api-key': this.defaultApiKey,
          },
          key: this.defaultApiKey,
          // Note: No accountId available when using default API key
        }
      }

      // No credentials found anywhere
      throw new AuthenticationError('No valid credentials found', {
        domain: context.host,
        hasApiKey: false,
        credentialPath,
        hint: 'For personal domains: create a credential file or pass Bearer token in Authorization header',
      })
    } catch (error) {
      logger.error('Authentication failed for personal domain', {
        requestId: context.requestId,
        domain: context.host,
        error:
          error instanceof Error
            ? {
                message: error.message,
                code: (error as any).code,
              }
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

  /**
   * Check if a request has valid authentication
   */
  hasAuthentication(context: RequestContext): boolean {
    return !!(context.apiKey || this.defaultApiKey)
  }

  /**
   * Get masked credential info for logging
   */
  getMaskedCredentialInfo(auth: AuthResult): string {
    const maskedKey = auth.key.substring(0, 10) + '****'
    return `${auth.type}:${maskedKey}`
  }

  /**
   * Get Slack configuration for a domain
   */
  async getSlackConfig(domain: string): Promise<SlackConfig | null> {
    const credentialPath = this.getSafeCredentialPath(domain)
    if (!credentialPath) {
      return null
    }

    try {
      const credentials = loadCredentials(credentialPath)
      // Return slack config if it exists and is not explicitly disabled
      if (credentials?.slack && credentials.slack.enabled !== false) {
        return credentials.slack
      }
    } catch (_error) {
      // Ignore errors - domain might not have credentials
    }

    return null
  }

  /**
   * Get client API key for a domain
   * Used for proxy-level authentication (different from Claude API keys)
   */
  async getClientApiKey(domain: string): Promise<string | null> {
    const credentialPath = this.getSafeCredentialPath(domain)
    if (!credentialPath) {
      logger.warn('Invalid domain name for client API key', {
        domain,
      })
      return null
    }

    try {
      const credentials = loadCredentials(credentialPath)
      return credentials?.client_api_key || null
    } catch (error) {
      logger.debug(`Failed to get client API key for domain: ${domain}`, {
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      })
      return null
    }
  }

  /**
   * Get safe credential path, preventing path traversal attacks
   */
  private getSafeCredentialPath(domain: string): string | null {
    try {
      // Validate domain to prevent path traversal and ensure safe characters
      // Allow alphanumeric, dots, hyphens, and colons for port numbers
      const domainRegex = /^[a-zA-Z0-9.\-:]+$/
      if (!domainRegex.test(domain)) {
        logger.warn('Domain contains invalid characters', {
          domain,
        })
        return null
      }

      // Additional check to prevent path traversal attempts
      if (domain.includes('..') || domain.includes('/') || domain.includes('\\')) {
        logger.warn('Domain contains path traversal attempt', { domain })
        return null
      }

      const safeDomain = domain

      // Build the credential path using the original credentialsDir value
      // This preserves relative paths for loadCredentials to handle
      const credentialPath = path.join(this.credentialsDir, `${safeDomain}.credentials.json`)

      // Security check: resolve both paths for comparison only
      const resolvedCredsDir = path.resolve(this.credentialsDir)
      const resolvedCredPath = path.resolve(credentialPath)

      // Ensure the resolved path is within the credentials directory
      if (!resolvedCredPath.startsWith(resolvedCredsDir + path.sep)) {
        logger.error('Path traversal attempt detected', {
          domain,
          metadata: {
            attemptedPath: credentialPath,
            safeDir: this.credentialsDir,
          },
        })
        return null
      }

      // Return the unresolved path for loadCredentials to handle
      return credentialPath
    } catch (error) {
      logger.error('Error sanitizing credential path', {
        domain,
        error: error instanceof Error ? { message: error.message } : { message: String(error) },
      })
      return null
    }
  }
}
