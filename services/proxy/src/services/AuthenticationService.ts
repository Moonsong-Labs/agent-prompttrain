import { getApiKey, DomainCredentialMapping, loadCredentials, SlackConfig } from '../credentials'
import { AuthenticationError } from '@agent-prompttrain/shared'
import { RequestContext } from '../domain/value-objects/RequestContext'
import { logger } from '../middleware/logger'
import * as path from 'path'
import * as fs from 'fs'
import { domainToASCII } from 'url'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const psl = require('psl')

export interface AuthResult {
  type: 'api_key' | 'oauth'
  headers: Record<string, string>
  key: string
  betaHeader?: string
  accountId?: string // Account identifier from credentials
}

interface CachedResolution {
  path: string | null
  matchType: 'exact' | 'wildcard' | 'none'
  expiresAt: number
}

/**
 * Service responsible for authentication logic
 * Handles API keys, OAuth tokens, and credential resolution
 */
export class AuthenticationService {
  private domainMapping: DomainCredentialMapping = {}
  private warnedDomains = new Set<string>()
  private warnedAccountFallbacks = new Set<string>()
  private resolutionCache = new Map<string, CachedResolution>()
  private cacheCleanupInterval: NodeJS.Timeout | null = null
  private readonly maxCacheSize = 10000 // Maximum number of cache entries

  constructor(
    private defaultApiKey?: string,
    private credentialsDir: string = process.env.CREDENTIALS_DIR || 'credentials'
  ) {
    // Initialize domain mapping if needed
    // For now, we'll handle credentials dynamically

    // Set up cache cleanup interval (every 5 minutes)
    this.cacheCleanupInterval = setInterval(
      () => {
        this.cleanupExpiredCache()
      },
      5 * 60 * 1000
    )
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
      const credentialPath = await this.resolveCredentialPath(context.host)
      if (!credentialPath) {
        throw new AuthenticationError('No credentials configured for domain', {
          domain: context.host,
          requestId: context.requestId,
          hint: 'Domain credentials are required for non-personal domains',
        })
      }

      const credentials = loadCredentials(credentialPath)
      if (!credentials) {
        throw new AuthenticationError('Failed to load credentials for domain', {
          domain: context.host,
          requestId: context.requestId,
          credentialPath,
        })
      }

      const apiKey = await getApiKey(credentialPath)
      if (!apiKey) {
        throw new AuthenticationError('Failed to retrieve API key for domain', {
          domain: context.host,
          requestId: context.requestId,
        })
      }

      // Return auth based on credential type
      if (credentials.type === 'oauth') {
        const derivedAccountId =
          credentials.accountId ?? this.deriveAccountIdFromPath(credentialPath) ?? undefined
        if (!credentials.accountId && derivedAccountId) {
          this.maybeWarnAccountFallback(
            credentialPath,
            derivedAccountId,
            context.host,
            context.requestId
          )
        }

        logger.info(`Using OAuth credentials for non-personal domain`, {
          requestId: context.requestId,
          domain: context.host,
          metadata: {
            accountId: derivedAccountId,
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
          accountId: derivedAccountId,
        }
      } else {
        const derivedAccountId =
          credentials.accountId ?? this.deriveAccountIdFromPath(credentialPath) ?? undefined
        if (!credentials.accountId && derivedAccountId) {
          this.maybeWarnAccountFallback(
            credentialPath,
            derivedAccountId,
            context.host,
            context.requestId
          )
        }

        logger.info(`Using API key for non-personal domain`, {
          requestId: context.requestId,
          domain: context.host,
          metadata: {
            accountId: derivedAccountId,
          },
        })

        return {
          type: 'api_key',
          headers: {
            'x-api-key': apiKey,
          },
          key: apiKey,
          accountId: derivedAccountId,
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
      const credentialPath = await this.resolveCredentialPath(context.host)

      // Try to load credentials if we have a path
      if (credentialPath) {
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
                const derivedAccountId =
                  credentials.accountId ?? this.deriveAccountIdFromPath(credentialPath) ?? undefined
                if (!credentials.accountId && derivedAccountId) {
                  this.maybeWarnAccountFallback(
                    credentialPath,
                    derivedAccountId,
                    context.host,
                    context.requestId
                  )
                }

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
                  accountId: derivedAccountId,
                }
              } else {
                const derivedAccountId =
                  credentials.accountId ?? this.deriveAccountIdFromPath(credentialPath) ?? undefined
                if (!credentials.accountId && derivedAccountId) {
                  this.maybeWarnAccountFallback(
                    credentialPath,
                    derivedAccountId,
                    context.host,
                    context.requestId
                  )
                }

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
                  accountId: derivedAccountId,
                }
              }
            }
          }
        } catch (_e) {
          // Credential file doesn't exist or couldn't be loaded, continue to fallback options
          if (!this.warnedDomains.has(context.host)) {
            logger.debug(`Failed to load credentials for domain: ${context.host}`, {
              metadata: {
                credentialsDir: this.credentialsDir,
              },
            })
            this.warnedDomains.add(context.host)
          }
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
    const credentialPath = await this.resolveCredentialPath(domain)
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
    const credentialPath = await this.resolveCredentialPath(domain)
    if (!credentialPath) {
      logger.debug('No credentials found for domain', {
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

  /**
   * Clean up expired cache entries
   */
  private cleanupExpiredCache(): void {
    const now = Date.now()
    for (const [key, value] of this.resolutionCache.entries()) {
      if (value.expiresAt <= now) {
        this.resolutionCache.delete(key)
      }
    }
  }

  /**
   * Derive account ID from credential file path
   */
  private deriveAccountIdFromPath(credentialPath: string): string | undefined {
    try {
      const base = path.basename(credentialPath)
      // Match wildcard: _wildcard.<domain>.credentials.json
      const wildcardMatch = base.match(/^_wildcard\.(.+)\.credentials\.json$/)
      if (wildcardMatch) {
        return wildcardMatch[1]
      }

      // Match exact: <domain>.credentials.json
      const exactMatch = base.match(/^(.+)\.credentials\.json$/)
      if (exactMatch) {
        return exactMatch[1]
      }

      return undefined
    } catch {
      return undefined
    }
  }

  /**
   * Warn about account ID fallback (once per credential file)
   */
  private maybeWarnAccountFallback(
    credentialPath: string,
    derived: string,
    domain: string,
    requestId?: string
  ) {
    if (this.warnedAccountFallbacks.has(credentialPath)) {
      return
    }
    this.warnedAccountFallbacks.add(credentialPath)
    logger.warn('Using filename-derived accountId for credentials missing accountId', {
      requestId,
      domain,
      metadata: {
        credentialPath,
        derivedAccountId: derived,
      },
    })
  }

  /**
   * Normalize domain for consistent matching
   */
  private normalizeDomain(domain: string): string {
    try {
      // Remove port
      const domainWithoutPort = domain.split(':')[0]

      // Convert IDN to ASCII (punycode) - handles internationalized domains
      let normalized: string
      try {
        normalized = domainToASCII(domainWithoutPort)
      } catch (idnError) {
        // If IDN conversion fails, use the original (some malformed domains might fail)
        logger.debug('IDN conversion failed, using original domain', {
          domain: domainWithoutPort,
          error: idnError instanceof Error ? idnError.message : String(idnError),
        })
        normalized = domainWithoutPort
      }

      // Lowercase
      normalized = normalized.toLowerCase()

      // Remove trailing dot if present
      const withoutTrailingDot = normalized.replace(/\.$/, '')

      // Collapse consecutive dots
      const collapsed = withoutTrailingDot.replace(/\.{2,}/g, '.')

      // Reject empty labels
      if (collapsed.split('.').some(label => label === '')) {
        throw new Error(`Invalid domain: ${domain} (empty labels)`)
      }

      return collapsed
    } catch (error) {
      logger.warn('Domain normalization failed', {
        domain,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  /**
   * Check if a credential file exists without loading it
   */
  private async credentialFileExists(path: string): Promise<boolean> {
    try {
      await fs.promises.access(path, fs.constants.F_OK)
      return true
    } catch {
      return false
    }
  }

  /**
   * Build credential path with optional wildcard prefix
   */
  private buildCredentialPath(domain: string, isWildcard: boolean): string | null {
    // First validate the domain using the existing safe method
    const safePath = this.getSafeCredentialPath(domain)
    if (!safePath) {
      return null
    }

    // Extract the safe filename and add wildcard prefix if needed
    const dir = path.dirname(safePath)
    const baseFilename = path.basename(safePath)
    const filename = isWildcard ? `_wildcard.${baseFilename}` : baseFilename
    const outputPath = path.join(dir, filename)

    // Double-check the path stays within credentials directory
    const resolvedCredsDir = path.resolve(this.credentialsDir)
    const resolvedOutput = path.resolve(outputPath)
    if (!resolvedOutput.startsWith(resolvedCredsDir + path.sep)) {
      logger.error('Path escape attempt in buildCredentialPath', {
        domain,
        metadata: {
          attemptedPath: outputPath,
          credentialsDir: this.credentialsDir,
        },
      })
      return null
    }

    return outputPath
  }

  /**
   * Find wildcard match for a domain
   */
  private async findWildcardMatch(domain: string): Promise<string | null> {
    const domainParts = domain.split('.')

    // Get the registrable domain using PSL
    const parsed = psl.parse(domain)
    if (!parsed.domain) {
      logger.warn('Could not parse registrable domain', { domain })
      return null
    }

    // Start from most specific wildcard, but stop at registrable domain
    for (let i = 0; i < domainParts.length - 1; i++) {
      const wildcardDomain = domainParts.slice(i + 1).join('.')

      // Stop if we've reached or passed the registrable domain boundary
      const wildcardParsed = psl.parse(wildcardDomain)
      if (!wildcardParsed.domain || wildcardParsed.domain !== parsed.domain) {
        logger.debug('Stopping wildcard search at PSL boundary', {
          domain,
          metadata: {
            wildcardDomain,
            registrableDomain: parsed.domain,
          },
        })
        break
      }

      const wildcardPath = this.buildCredentialPath(wildcardDomain, true)

      if (wildcardPath && (await this.credentialFileExists(wildcardPath))) {
        logger.info('Wildcard match found', {
          domain,
          metadata: {
            wildcardPattern: `*.${wildcardDomain}`,
            matchLevel: i + 1,
            registrableDomain: parsed.domain,
          },
        })
        return wildcardPath
      }
    }

    return null
  }

  /**
   * Enforce cache size limit by removing oldest entries
   */
  private enforceCacheLimit(): void {
    if (this.resolutionCache.size <= this.maxCacheSize) {
      return
    }

    // Convert to array, sort by expiration time (oldest first), and remove excess
    const entries = Array.from(this.resolutionCache.entries()).sort(
      (a, b) => a[1].expiresAt - b[1].expiresAt
    )

    const toRemove = entries.slice(0, entries.length - this.maxCacheSize)
    for (const [key] of toRemove) {
      this.resolutionCache.delete(key)
    }
  }

  /**
   * Cache resolution result
   */
  private cacheResolution(
    domain: string,
    path: string | null,
    matchType: 'exact' | 'wildcard' | 'none'
  ): void {
    // Robust TTL parsing with validation
    const defaultTtl = 300000 // 5 minutes
    const minTtl = 1000 // 1 second
    const maxTtl = 86400000 // 24 hours

    let ttlMs = defaultTtl
    const envTtl = process.env.CNP_RESOLUTION_CACHE_TTL
    if (envTtl) {
      const parsed = parseInt(envTtl, 10)
      if (!isNaN(parsed) && parsed >= minTtl && parsed <= maxTtl) {
        ttlMs = parsed
      } else {
        logger.warn('Invalid CNP_RESOLUTION_CACHE_TTL value, using default', {
          metadata: {
            provided: envTtl,
            default: defaultTtl,
            min: minTtl,
            max: maxTtl,
          },
        })
      }
    }

    this.resolutionCache.set(domain, {
      path,
      matchType,
      expiresAt: Date.now() + ttlMs,
    })

    // Enforce cache size limit
    this.enforceCacheLimit()
  }

  /**
   * Resolve credential path with wildcard support
   */
  private async resolveCredentialPath(domain: string): Promise<string | null> {
    // Shadow mode for logging only - still use original behavior
    const shadowMode = process.env.CNP_WILDCARD_CREDENTIALS === 'shadow'

    // Check if wildcard feature is enabled (not in shadow mode)
    if (process.env.CNP_WILDCARD_CREDENTIALS !== 'true' && !shadowMode) {
      return this.getSafeCredentialPath(domain)
    }

    try {
      // Normalize domain
      const normalizedDomain = this.normalizeDomain(domain)

      // Check cache with TTL
      const cached = this.resolutionCache.get(normalizedDomain)
      if (cached && cached.expiresAt > Date.now()) {
        if (process.env.CNP_DEBUG_RESOLUTION === 'true') {
          logger.debug('Resolution cache hit', {
            domain: normalizedDomain,
            metadata: {
              path: cached.path,
              matchType: cached.matchType,
            },
          })
        }
        return cached.path
      }

      // Try exact match first
      const exactPath = this.buildCredentialPath(normalizedDomain, false)
      if (exactPath && (await this.credentialFileExists(exactPath))) {
        this.cacheResolution(normalizedDomain, exactPath, 'exact')
        if (shadowMode || process.env.CNP_DEBUG_RESOLUTION === 'true') {
          logger.info('[WILDCARD_RESOLUTION] Exact match found', {
            domain: normalizedDomain,
            metadata: {
              path: exactPath,
              shadowMode,
            },
          })
        }
        // In shadow mode, still return original behavior
        if (shadowMode) {
          return this.getSafeCredentialPath(domain)
        }
        return exactPath
      }

      // Try wildcard matches from most specific to least
      const wildcardPath = await this.findWildcardMatch(normalizedDomain)
      if (wildcardPath) {
        this.cacheResolution(normalizedDomain, wildcardPath, 'wildcard')
        if (shadowMode || process.env.CNP_DEBUG_RESOLUTION === 'true') {
          logger.info('[WILDCARD_RESOLUTION] Wildcard match found', {
            domain: normalizedDomain,
            metadata: {
              path: wildcardPath,
              shadowMode,
            },
          })
        }
        // In shadow mode, still return original behavior
        if (shadowMode) {
          return this.getSafeCredentialPath(domain)
        }
        return wildcardPath
      }

      // Cache negative result
      this.cacheResolution(normalizedDomain, null, 'none')
      if (shadowMode || process.env.CNP_DEBUG_RESOLUTION === 'true') {
        logger.info('[WILDCARD_RESOLUTION] No match found', {
          domain: normalizedDomain,
          metadata: {
            shadowMode,
          },
        })
      }
      // In shadow mode, still return original behavior
      if (shadowMode) {
        return this.getSafeCredentialPath(domain)
      }
      return null
    } catch (error) {
      logger.error('Error in credential resolution', {
        domain,
        error: error instanceof Error ? error.message : String(error),
      })
      // Fall back to original behavior on error
      return this.getSafeCredentialPath(domain)
    }
  }

  /**
   * Public method to clear resolution cache
   */
  public clearResolutionCache(): void {
    this.resolutionCache.clear()
    logger.info('Credential resolution cache cleared')
  }

  /**
   * Clean up on service shutdown
   */
  public destroy(): void {
    if (this.cacheCleanupInterval) {
      clearInterval(this.cacheCleanupInterval)
      this.cacheCleanupInterval = null
    }
    this.clearResolutionCache()
  }
}
