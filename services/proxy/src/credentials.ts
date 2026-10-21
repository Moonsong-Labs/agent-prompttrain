import { Pool } from 'pg'
import type { AnthropicCredential } from '@agent-prompttrain/shared'
import {
  getCredentialById,
  markRefreshTokenRejected,
  updateCredentialTokens,
  withCredentialRefreshLock,
} from '@agent-prompttrain/shared/database/queries'
import { CredentialManager } from './services/CredentialManager'
import { notifyRefreshTokenRejected } from './services/refresh-token-alert'
import { logger } from './middleware/logger'

const DEFAULT_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

// Refresh the access token this long before it expires
const REFRESH_BEFORE_EXPIRY_MS = 60_000

// Other proxy tasks wait for a refresh holding the lock, so the token request must end
const TOKEN_REQUEST_TIMEOUT_MS = 30_000

const OAUTH_CONFIG = {
  clientId: process.env.CLAUDE_OAUTH_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID,
  betaHeader: 'oauth-2025-04-20',
}

const credentialManager = new CredentialManager()

/**
 * Error returned by the OAuth token endpoint when a refresh fails
 */
export class OAuthRefreshError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string,
    readonly description?: string
  ) {
    super(message)
    this.name = 'OAuthRefreshError'
  }

  /**
   * True when the refresh token itself was rejected (expired, revoked or already used),
   * so retrying cannot succeed and the account must be re-authorized
   */
  get isRefreshTokenRejected(): boolean {
    return this.status === 400 || this.status === 401 || this.errorCode === 'invalid_grant'
  }

  static async fromResponse(response: Response): Promise<OAuthRefreshError> {
    const errorText = await response.text()
    let errorCode: string | undefined
    let description: string | undefined
    try {
      const body = JSON.parse(errorText)
      errorCode = typeof body.error === 'string' ? body.error : body.error?.type
      description = body.error_description ?? body.error?.message
    } catch {
      // Non-JSON error body; keep the raw text in the message only
    }
    return new OAuthRefreshError(
      `Failed to refresh token: ${response.status} - ${errorText}`,
      response.status,
      errorCode,
      description
    )
  }
}

/**
 * Refresh OAuth access token
 */
export async function refreshToken(refreshToken: string): Promise<{
  accessToken: string
  refreshToken: string
  expiresAt: Date
}> {
  const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
  const CLIENT_ID = process.env.CLAUDE_OAUTH_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID

  const response = await fetch(TOKEN_URL, {
    headers: {
      'Content-Type': 'application/json',
      'anthropic-beta': OAUTH_CONFIG.betaHeader,
    },
    method: 'POST',
    body: JSON.stringify({
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw await OAuthRefreshError.fromResponse(response)
  }

  const payload = (await response.json()) as any
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || refreshToken,
    expiresAt: new Date(Date.now() + payload.expires_in * 1000),
  }
}

/**
 * Get API key (access token) from database credential
 * Handles OAuth token refresh automatically
 */
export async function getApiKey(
  credentialId: string,
  pool: Pool,
  _debug: boolean = false
): Promise<string | null> {
  const credential = await getCredentialById(pool, credentialId)
  if (!credential) {
    return null
  }

  // Only OAuth credentials can be refreshed
  if (credential.provider !== 'anthropic') {
    return null
  }

  const cacheKey = `credential:${credentialId}`

  if (needsRefresh(credential)) {
    // Check for recent failure (negative cache)
    const failureCheck = credentialManager.hasRecentFailure(cacheKey)
    if (failureCheck.failed) {
      return null
    }

    // Check for in-progress refresh
    const existingRefresh = credentialManager.getActiveRefresh(cacheKey)
    if (existingRefresh) {
      credentialManager.updateMetrics('concurrent')
      return existingRefresh
    }

    // Start new refresh
    const refreshPromise = (async () => {
      const startTime = Date.now()
      credentialManager.updateMetrics('attempt')

      try {
        const accessToken = await refreshUnderLock(pool, credentialId)

        const duration = Date.now() - startTime
        credentialManager.updateMetrics('success', duration)

        return accessToken
      } catch (refreshError: unknown) {
        credentialManager.updateMetrics('failure')
        const errorMessage = refreshError instanceof Error ? refreshError.message : 'Unknown error'

        credentialManager.recordFailedRefresh(cacheKey, errorMessage)

        logger.warn('OAuth token refresh failed', {
          metadata: { accountId: credential.account_id, credentialId, error: errorMessage },
        })

        return null
      } finally {
        credentialManager.removeActiveRefresh(cacheKey)
      }
    })()

    credentialManager.setActiveRefresh(cacheKey, refreshPromise)
    return refreshPromise
  }

  return credential.oauth_access_token || null
}

function needsRefresh(credential: AnthropicCredential): boolean {
  const expiresAt = new Date(credential.oauth_expires_at || 0)
  return Date.now() >= expiresAt.getTime() - REFRESH_BEFORE_EXPIRY_MS
}

/**
 * Refresh the access token while holding the credential's cluster-wide refresh lock.
 *
 * Anthropic revokes a refresh token presented twice, so only one proxy task may use it
 * (ADR-040). The credential is read again under the lock: when another task refreshed it
 * while this one waited, its stored token is used and Anthropic is not called.
 */
async function refreshUnderLock(pool: Pool, credentialId: string): Promise<string | null> {
  return withCredentialRefreshLock(pool, credentialId, async client => {
    const credential = await getCredentialById(client, credentialId)
    if (credential?.provider !== 'anthropic') {
      return null
    }
    if (!needsRefresh(credential)) {
      return credential.oauth_access_token || null
    }

    const usedRefreshToken = credential.oauth_refresh_token || ''
    try {
      const newTokens = await refreshToken(usedRefreshToken)

      await updateCredentialTokens(client, credentialId, {
        oauth_access_token: newTokens.accessToken,
        oauth_refresh_token: newTokens.refreshToken,
        oauth_expires_at: newTokens.expiresAt,
      })

      return newTokens.accessToken
    } catch (refreshError: unknown) {
      if (refreshError instanceof OAuthRefreshError && refreshError.isRefreshTokenRejected) {
        // Fire and forget: alerting must never delay or fail the caller
        void notifyRefreshTokenRejected(pool, credential, usedRefreshToken, refreshError)

        // Only invalid_grant reliably means this refresh token is dead; any other error
        // could be an upstream incident, which must not take accounts out of pools
        if (refreshError.errorCode === 'invalid_grant') {
          await markRefreshTokenRejected(client, credentialId, usedRefreshToken).catch(
            (markError: unknown) =>
              logger.error('Failed to record rejected refresh token', {
                metadata: {
                  accountId: credential.account_id,
                  error: markError instanceof Error ? markError.message : String(markError),
                },
              })
          )
        }
      }
      throw refreshError
    }
  })
}

/**
 * Get current OAuth refresh metrics
 */
export function getRefreshMetrics() {
  return credentialManager.getRefreshMetrics()
}
