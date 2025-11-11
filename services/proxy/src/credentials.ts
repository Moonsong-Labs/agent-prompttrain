import { Pool } from 'pg'
import {
  getCredentialById,
  updateCredentialTokens,
} from '@agent-prompttrain/shared/database/queries'
import { CredentialManager } from './services/CredentialManager'

const DEFAULT_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

const OAUTH_CONFIG = {
  clientId: process.env.CLAUDE_OAUTH_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID,
  betaHeader: 'oauth-2025-04-20',
}

const credentialManager = new CredentialManager()

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
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to refresh token: ${response.status} - ${errorText}`)
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

  // Check if token needs refresh (refresh 1 minute before expiry)
  const expiresAt = new Date(credential.oauth_expires_at || 0)
  if (Date.now() >= expiresAt.getTime() - 60000) {
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
        const newTokens = await refreshToken(credential.oauth_refresh_token || '')

        // Update database
        await updateCredentialTokens(pool, credentialId, {
          oauth_access_token: newTokens.accessToken,
          oauth_refresh_token: newTokens.refreshToken,
          oauth_expires_at: newTokens.expiresAt,
        })

        const duration = Date.now() - startTime
        credentialManager.updateMetrics('success', duration)

        return newTokens.accessToken
      } catch (refreshError: unknown) {
        credentialManager.updateMetrics('failure')
        const errorMessage = refreshError instanceof Error ? refreshError.message : 'Unknown error'

        credentialManager.recordFailedRefresh(cacheKey, errorMessage)

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

/**
 * Get current OAuth refresh metrics
 */
export function getRefreshMetrics() {
  return credentialManager.getRefreshMetrics()
}
