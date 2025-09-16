/**
 * OAuth Credentials Manager
 *
 * IMPORTANT: This implementation uses in-memory state for refresh token management
 * and is designed for SINGLE-INSTANCE deployments only.
 *
 * For multi-instance deployments, the refresh token locking mechanism needs to be
 * replaced with a distributed lock using Redis or similar shared state store.
 *
 * Features:
 * - Concurrent refresh prevention (single-instance only)
 * - Negative caching for failed refreshes (5-second cooldown)
 * - Atomic credential saves (save before updating in-memory state)
 * - Automatic cleanup of stuck operations
 * - Metrics collection for observability
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import * as process from 'process'
import { randomBytes, createHash } from 'crypto'
import { CredentialManager } from './services/CredentialManager'

export interface OAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
  isMax: boolean
}

export interface SlackConfig {
  webhook_url?: string
  channel?: string
  username?: string
  icon_emoji?: string
  enabled?: boolean
}

export interface ClaudeCredentials {
  type: 'api_key' | 'oauth'
  accountId?: string // Unique identifier for the account (e.g., "acc_f9e1c2d3b4a5")
  api_key?: string
  oauth?: OAuthCredentials
  slack?: SlackConfig
  client_api_key?: string
  betaHeader?: string // Optional beta header for API requests
}

export interface DomainCredentialMapping {
  [trainId: string]: string // domain -> credential file path
}

// Default OAuth client ID - can be overridden via CLAUDE_OAUTH_CLIENT_ID env var
const DEFAULT_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

// OAuth configuration - matching Claude CLI
const OAUTH_CONFIG = {
  clientId: process.env.CLAUDE_OAUTH_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID,
  authorizationUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  scopes: ['org:create_api_key', 'user:profile', 'user:inference'],
  apiKeyEndpoint: 'https://api.anthropic.com/api/oauth/claude_cli/create_api_key',
  profileEndpoint: 'https://api.anthropic.com/api/claude_cli_profile',
  betaHeader: 'oauth-2025-04-20',
}

// Create a credential manager instance for this module
// In a larger application, this would be injected via dependency injection
const credentialManager = new CredentialManager()

// Helper functions for cache management - delegate to the credential manager
function getCachedCredential(key: string): ClaudeCredentials | null {
  return credentialManager.getCachedCredential(key)
}

function setCachedCredential(key: string, credential: ClaudeCredentials): void {
  credentialManager.setCachedCredential(key, credential)
}

// PKCE helper functions
function base64URLEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function generateCodeVerifier(): string {
  return base64URLEncode(randomBytes(32))
}

function generateCodeChallenge(verifier: string): string {
  return base64URLEncode(createHash('sha256').update(verifier).digest())
}

/**
 * Get credential file path for a domain
 */
export function getCredentialFileForDomain(
  trainId: string,
  credentialsDir: string | undefined
): string | null {
  if (!credentialsDir) {
    credentialsDir = 'credentials' // Default to 'credentials' folder in current directory
  }

  // Construct the credential filename: <trainId>.credentials.json
  const filename = `${trainId}.credentials.json`

  // Resolve the credentials directory path
  let dirPath: string
  if (credentialsDir.startsWith('~')) {
    dirPath = join(homedir(), credentialsDir.slice(1))
  } else if (credentialsDir.startsWith('/') || credentialsDir.includes(':')) {
    dirPath = credentialsDir
  } else {
    dirPath = join(process.cwd(), credentialsDir)
  }

  const filePath = join(dirPath, filename)

  // Check if the file exists
  if (existsSync(filePath)) {
    return filePath
  }

  return null
}

/**
 * Load credentials from a JSON file
 */
export function loadCredentials(filePath: string): ClaudeCredentials | null {
  // Check cache first
  const cached = getCachedCredential(filePath)
  if (cached) {
    return cached
  }

  // Handle in-memory credentials
  if (filePath.startsWith('memory:')) {
    return getCachedCredential(filePath)
  }

  try {
    // Resolve path:
    // - If starts with ~, expand to home directory
    // - If absolute path (starts with / or contains :), use as-is
    // - Otherwise, treat as relative to current working directory
    let fullPath: string

    if (filePath.startsWith('~')) {
      fullPath = join(homedir(), filePath.slice(1))
    } else if (filePath.startsWith('/') || filePath.includes(':')) {
      fullPath = filePath
    } else {
      fullPath = join(process.cwd(), filePath)
    }

    if (!existsSync(fullPath)) {
      console.error(`Credential file not found: ${fullPath}`)
      return null
    }

    const content = readFileSync(fullPath, 'utf-8')
    const credentials = JSON.parse(content) as ClaudeCredentials

    // Validate credentials
    if (!credentials.type) {
      console.error(`Invalid credential file (missing type): ${fullPath}`)
      return null
    }

    // Validate accountId (warn but don't fail for backward compatibility)
    if (!credentials.accountId) {
      console.warn(`Warning: Credential file missing accountId: ${fullPath}`)
    }

    if (credentials.type === 'api_key' && !credentials.api_key) {
      console.error(`Invalid API key credential file: ${fullPath}`)
      return null
    }

    if (credentials.type === 'oauth' && !credentials.oauth) {
      console.error(`Invalid OAuth credential file: ${fullPath}`)
      return null
    }

    // Cache the credentials
    setCachedCredential(filePath, credentials)

    return credentials
  } catch (err) {
    console.error(`Failed to load credentials from ${filePath}:`, err)
    return null
  }
}

/**
 * Save updated OAuth credentials back to file
 */
async function saveOAuthCredentials(filePath: string, credentials: ClaudeCredentials) {
  if (filePath.startsWith('memory:') || credentials.type !== 'oauth') {
    return
  }

  try {
    // Update cache
    setCachedCredential(filePath, credentials)

    // Save to file using same path resolution logic
    let fullPath: string

    if (filePath.startsWith('~')) {
      fullPath = join(homedir(), filePath.slice(1))
    } else if (filePath.startsWith('/') || filePath.includes(':')) {
      fullPath = filePath
    } else {
      fullPath = join(process.cwd(), filePath)
    }

    // Ensure directory exists
    mkdirSync(dirname(fullPath), { recursive: true })

    // Load existing file to preserve non-OAuth fields
    let existingData: any = {}
    try {
      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, 'utf-8')
        existingData = JSON.parse(content)
      }
    } catch (err) {
      // If we can't read existing data, we'll just save the new data
      console.warn(`Could not read existing credential file for merging: ${err}`)
    }

    // Merge the OAuth data with existing data, preserving other fields
    const mergedData = {
      ...existingData,
      ...credentials,
      // Explicitly preserve fields that might exist but aren't in ClaudeCredentials type
      accountId: existingData.accountId || credentials.accountId,
      client_api_key: existingData.client_api_key || credentials.client_api_key,
      slack: existingData.slack || credentials.slack,
    }

    writeFileSync(fullPath, JSON.stringify(mergedData, null, 2))
  } catch (err) {
    console.error(`Failed to save OAuth credentials to ${filePath}:`, err)
  }
}

/**
 * Refresh OAuth access token
 */
export async function refreshToken(refreshToken: string): Promise<OAuthCredentials> {
  const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
  const CLIENT_ID = process.env.CLAUDE_OAUTH_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID

  try {
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

    if (response.ok) {
      const payload = (await response.json()) as any
      return {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token || refreshToken, // Keep old refresh token if not provided
        expiresAt: Date.now() + payload.expires_in * 1000, // Convert to timestamp
        scopes: payload.scope ? payload.scope.split(' ') : OAUTH_CONFIG.scopes,
        isMax: payload.is_max || true,
      }
    }

    const errorText = await response.text()
    let errorData: any = {}
    try {
      errorData = JSON.parse(errorText)
    } catch {
      // Not JSON, use raw text
    }

    console.error(`Failed to refresh token: ${response.status} ${response.statusText}`)
    if (errorText) {
      console.error('Error details:', errorText)
    }

    // Throw more detailed error
    const error = new Error(
      errorData.error_description ||
        errorData.error ||
        `Failed to refresh token: ${response.status} ${response.statusText}`
    ) as any
    error.status = response.status
    error.errorCode = errorData.error
    error.errorDescription = errorData.error_description
    throw error
  } catch (error) {
    // Re-throw if already an Error with details
    if (error instanceof Error && (error as any).status) {
      throw error
    }
    // Wrap network errors
    console.error('Network error during token refresh:', error)
    throw new Error(
      `Network error during token refresh: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * Get API key or access token from credentials
 * Handles OAuth token refresh automatically
 */
export async function getApiKey(
  credentialPath: string | null,
  debug: boolean = false
): Promise<string | null> {
  if (!credentialPath) {
    return null
  }

  const credentials = loadCredentials(credentialPath)
  if (!credentials) {
    return null
  }

  if (credentials.type === 'api_key') {
    return credentials.api_key || null
  }

  if (credentials.type === 'oauth' && credentials.oauth) {
    try {
      const oauth = credentials.oauth

      // Check if token needs refresh (refresh 1 minute before expiry)
      if (oauth.expiresAt && Date.now() >= oauth.expiresAt - 60000) {
        if (debug) {
          console.log(`OAuth token expired for ${credentialPath}, checking refresh...`)
        }

        if (!oauth.refreshToken) {
          console.error('No refresh token available for', credentialPath)
          console.error('OAuth credentials may need to be re-authenticated')
          return null
        }

        // Check if this refresh recently failed (negative cache)
        const failureCheck = credentialManager.hasRecentFailure(credentialPath)
        if (failureCheck.failed) {
          if (debug) {
            console.log(
              `[COOLDOWN] Skipping refresh for ${credentialPath}, recent failure: ${failureCheck.error}`
            )
          }
          return null
        }

        // Check if a refresh is already in progress for this credential
        const existingRefresh = credentialManager.getActiveRefresh(credentialPath)
        if (existingRefresh) {
          credentialManager.updateMetrics('concurrent')
          if (debug) {
            console.log(`[CONCURRENT] Waiting for existing refresh for ${credentialPath}`)
          } else {
            console.log(`OAuth refresh already in progress for ${credentialPath}, waiting...`)
          }
          return existingRefresh
        }

        // Create a new refresh promise
        const refreshPromise = (async () => {
          const startTime = Date.now()
          credentialManager.updateMetrics('attempt')

          try {
            if (debug) {
              console.log(`Starting OAuth refresh for ${credentialPath}`)
            }

            const newOAuth = await refreshToken(oauth.refreshToken)

            // Create updated credentials object
            const updatedCredentials = { ...credentials, oauth: newOAuth }

            // ATOMIC SAVE: Save first, then update in-memory
            try {
              await saveOAuthCredentials(credentialPath, updatedCredentials)

              // Only update in-memory state after successful save
              credentials.oauth = newOAuth

              // Update metrics
              const duration = Date.now() - startTime
              credentialManager.updateMetrics('success', duration)

              if (debug) {
                console.log(`OAuth token refreshed for ${credentialPath} in ${duration}ms`)
              }

              return newOAuth.accessToken
            } catch (saveError) {
              console.error(
                `Failed to save refreshed OAuth credentials for ${credentialPath}:`,
                saveError
              )
              // Don't update in-memory state if save failed
              throw new Error(
                `Failed to save credentials: ${saveError instanceof Error ? saveError.message : String(saveError)}`
              )
            }
          } catch (refreshError: any) {
            credentialManager.updateMetrics('failure')

            console.error(
              `Failed to refresh OAuth token for ${credentialPath}:`,
              refreshError.message
            )

            // Cache the failure to prevent thundering herd
            credentialManager.recordFailedRefresh(
              credentialPath,
              refreshError.message || 'Unknown error'
            )

            // Check for specific error codes
            if (refreshError.errorCode === 'invalid_grant' || refreshError.status === 400) {
              console.error('Refresh token is invalid or expired. Re-authentication required.')
              console.error(`Please run: bun run scripts/oauth-login.ts ${credentialPath}`)
            }

            return null
          } finally {
            // Clean up tracking
            credentialManager.removeActiveRefresh(credentialPath)
          }
        })()

        // Store the refresh promise
        credentialManager.setActiveRefresh(credentialPath, refreshPromise)

        return refreshPromise
      }

      return oauth.accessToken || null
    } catch (err) {
      console.error(`Failed to refresh OAuth token for ${credentialPath}:`, err)
      return null
    }
  }

  return null
}

/**
 * Get masked credential info for logging
 */
export function getMaskedCredentialInfo(credentialPath: string | null): string {
  if (!credentialPath) {
    return 'none'
  }

  if (credentialPath.startsWith('memory:')) {
    return credentialPath
  }

  const credentials = loadCredentials(credentialPath)
  if (!credentials) {
    return `invalid:${credentialPath}`
  }

  if (credentials.type === 'api_key' && credentials.api_key) {
    const key = credentials.api_key
    if (key.length <= 10) {
      return `api_key:${key}`
    }
    return `api_key:...${key.slice(-10)}`
  }

  if (credentials.type === 'oauth' && credentials.oauth) {
    return `oauth:${OAUTH_CONFIG.clientId}`
  }

  return `unknown:${credentialPath}`
}

/**
 * Validate all credential files in the domain mapping
 * Returns an array of validation errors
 */
export function validateCredentialMapping(mapping: DomainCredentialMapping): string[] {
  const errors: string[] = []

  for (const [trainId, credPath] of Object.entries(mapping)) {
    const credentials = loadCredentials(credPath)

    if (!credentials) {
      errors.push(`Missing or invalid credential file for train-id '${trainId}': ${credPath}`)
      continue
    }

    // Check for accountId (warning only for backward compatibility)
    if (!credentials.accountId) {
      errors.push(`Warning: Missing accountId for train-id '${trainId}' in ${credPath}`)
    }

    if (credentials.type === 'api_key') {
      if (!credentials.api_key) {
        errors.push(`Invalid API key credential for train-id '${trainId}': missing api_key field`)
      }
    } else if (credentials.type === 'oauth') {
      if (!credentials.oauth) {
        errors.push(`Invalid OAuth credential for train-id '${trainId}': missing oauth field`)
      } else {
        const oauth = credentials.oauth
        if (!oauth.accessToken && !oauth.refreshToken) {
          errors.push(
            `Invalid OAuth credential for train-id '${trainId}': missing accessToken and refreshToken`
          )
        }
      }
    } else {
      errors.push(`Invalid credential type for train-id '${trainId}': ${credentials.type}`)
    }
  }

  return errors
}

/**
 * Get the first available credential from the mapping
 */
export async function getFirstAvailableCredential(
  mapping: DomainCredentialMapping,
  debug: boolean = false
): Promise<{ trainId: string; apiKey: string | null } | null> {
  for (const [trainId, credPath] of Object.entries(mapping)) {
    const apiKey = await getApiKey(credPath, debug)
    if (apiKey) {
      return { trainId, apiKey }
    }
  }
  return null
}

/**
 * Get authorization header for API requests for a specific domain
 */
export async function getAuthorizationHeaderForDomain(
  mapping: DomainCredentialMapping,
  trainId: string,
  debug: boolean = false
): Promise<{ [key: string]: string } | null> {
  const credentialPath = mapping[trainId]
  if (!credentialPath) {
    if (debug) {
      console.log(`No credential mapping found for trainId: ${trainId}`)
    }
    return null
  }

  const apiKey = await getApiKey(credentialPath, debug)
  if (!apiKey) {
    return null
  }

  const credentials = loadCredentials(credentialPath)
  if (!credentials) {
    return null
  }

  const headers: { [key: string]: string } = {
    Authorization: credentials.type === 'oauth' ? `Bearer ${apiKey}` : apiKey,
  }

  // Add beta header for OAuth requests
  if (credentials.type === 'oauth') {
    headers['anthropic-beta'] = OAUTH_CONFIG.betaHeader
  }

  return headers
}

/**
 * Generate OAuth authorization URL
 */
function generateAuthorizationUrl(): {
  url: string
  verifier: string
} {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)

  const authUrl = new URL(OAUTH_CONFIG.authorizationUrl)
  authUrl.searchParams.set('code', 'true')
  authUrl.searchParams.set('client_id', OAUTH_CONFIG.clientId)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('redirect_uri', OAUTH_CONFIG.redirectUri)
  authUrl.searchParams.set('scope', OAUTH_CONFIG.scopes.join(' '))
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', codeVerifier) // Store verifier in state

  return {
    url: authUrl.toString(),
    verifier: codeVerifier,
  }
}

/**
 * Wait for user to complete OAuth flow and get code
 */
async function waitForAuthorizationCode(): Promise<string> {
  const readline = await import('readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve, reject) => {
    rl.question('\nEnter the authorization code: ', code => {
      rl.close()

      if (!code || code.trim().length === 0) {
        reject(new Error('No authorization code provided'))
        return
      }

      resolve(code.trim())
    })
  })
}

/**
 * Exchange authorization code for tokens
 *
 * Note: Anthropic's OAuth implementation returns the authorization code in a
 * non-standard format: "code#state" instead of separate query parameters.
 * This deviates from RFC 6749 but matches their actual implementation.
 */
async function exchangeCodeForTokens(
  codeWithState: string,
  codeVerifier: string
): Promise<OAuthCredentials> {
  try {
    // Split the code#state format (Anthropic-specific format)
    const [code, state] = codeWithState.split('#')

    if (!code || !state) {
      throw new Error('Invalid authorization code format. Expected format: code#state')
    }

    const response = await fetch(OAUTH_CONFIG.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code,
        state,
        grant_type: 'authorization_code',
        client_id: OAUTH_CONFIG.clientId,
        redirect_uri: OAUTH_CONFIG.redirectUri,
        code_verifier: codeVerifier,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('Failed to exchange code for tokens:', response.status, errorText)
      throw new Error(`Failed to exchange code: ${response.status}`)
    }

    const data = (await response.json()) as any

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      scopes: data.scope ? data.scope.split(' ') : OAUTH_CONFIG.scopes,
      isMax: data.is_max || true,
    }
  } catch (err: any) {
    console.error('Failed to exchange code for tokens:', err.message)
    throw err
  }
}

/**
 * Create API key using OAuth token
 */
async function createApiKey(accessToken: string): Promise<string> {
  try {
    const response = await fetch(OAUTH_CONFIG.apiKeyEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-beta': OAUTH_CONFIG.betaHeader,
      },
      body: JSON.stringify({
        expiresAt: null,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('Failed to create API key:', response.status, errorText)
      throw new Error(`Failed to create API key: ${response.status}`)
    }

    const data = (await response.json()) as any
    return data.key
  } catch (err: any) {
    console.error('Failed to create API key:', err.message)
    throw err
  }
}

/**
 * Perform OAuth login flow for a specific credential file
 * This allows setting up OAuth credentials for different domains
 */
export async function performOAuthLogin(
  credentialPath: string,
  createApiKeyFile: boolean = true
): Promise<void> {
  try {
    console.log('Starting OAuth login flow...')

    // Generate authorization URL
    const { url, verifier } = generateAuthorizationUrl()

    console.log('\nPlease visit the following URL to authorize:')
    console.log(url)
    console.log('\nAfter authorizing, you will see an authorization code.')
    console.log('Copy the entire code (it should contain a # character).')

    // Wait for user to complete authorization
    const code = await waitForAuthorizationCode()

    // Exchange code for tokens
    console.log('Exchanging authorization code for tokens...')
    const oauthCreds = await exchangeCodeForTokens(code, verifier)

    // Create credentials object
    const credentials: ClaudeCredentials = {
      type: 'oauth',
      oauth: oauthCreds,
    }

    // Save OAuth credentials
    await saveOAuthCredentials(credentialPath, credentials)

    console.log(`OAuth credentials saved to: ${credentialPath}`)

    // Optionally create an API key
    if (createApiKeyFile) {
      console.log('Creating API key from OAuth token...')
      const apiKey = await createApiKey(oauthCreds.accessToken)

      // Save as API key credential
      const apiKeyCredentials: ClaudeCredentials = {
        type: 'api_key',
        api_key: apiKey,
      }

      const apiKeyPath = credentialPath.replace('.json', '-apikey.json')

      // Resolve full path before saving
      let fullPath: string
      if (apiKeyPath.startsWith('~')) {
        fullPath = join(homedir(), apiKeyPath.slice(1))
      } else if (apiKeyPath.startsWith('/') || apiKeyPath.includes(':')) {
        fullPath = apiKeyPath
      } else {
        fullPath = join(process.cwd(), apiKeyPath)
      }

      mkdirSync(dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, JSON.stringify(apiKeyCredentials, null, 2))
      setCachedCredential(apiKeyPath, apiKeyCredentials)

      console.log(`API key saved to: ${apiKeyPath}`)
    }
  } catch (err) {
    console.error('OAuth login failed:', err)
    throw err
  }
}

/**
 * Add in-memory credentials for testing or temporary use
 */
export function addMemoryCredentials(id: string, credentials: ClaudeCredentials): void {
  const memoryPath = `memory:${id}`
  setCachedCredential(memoryPath, credentials)
}

/**
 * Clear credential cache
 */
export function clearCredentialCache(): void {
  credentialManager.clearCredentialCache()
}

/**
 * Get current OAuth refresh metrics
 */
export function getRefreshMetrics() {
  return credentialManager.getRefreshMetrics()
}
