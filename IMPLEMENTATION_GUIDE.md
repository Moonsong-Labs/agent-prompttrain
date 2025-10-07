# Implementation Guide: Database-Based Credential & Train Management

This guide provides step-by-step instructions to complete the database-based credential and train management feature.

## Overview

**Goal:** Migrate from filesystem-based credential/train management to database storage with OAuth-only support.

**Status:** Foundation complete (schema, types, queries). Remaining: service layer, API endpoints, UI.

---

## Phase 1: Core Backend Services (Proxy)

### Task 1.1: Rewrite AuthenticationService

**File:** `services/proxy/src/services/AuthenticationService.ts`

**Changes Required:**

1. Remove filesystem directory dependencies (`accountsDir`, `clientKeysDir`)
2. Accept `Pool` in constructor instead
3. Replace filesystem account loading with database queries
4. Remove account caching (database handles this efficiently)

**Implementation:**

```typescript
import { Pool } from 'pg'
import { createHash } from 'crypto'
import {
  getTrainCredentials,
  getCredentialByAccountName,
} from '@agent-prompttrain/shared/database/queries'
import { AuthenticationError } from '@agent-prompttrain/shared'
import { RequestContext } from '../domain/value-objects/RequestContext'
import { getApiKey } from '../credentials'
import { logger } from '../middleware/logger'
import type { AnthropicCredential, SlackConfig } from '@agent-prompttrain/shared'

export interface AuthResult {
  type: 'oauth'
  headers: Record<string, string>
  key: string
  betaHeader: string
  accountId: string
  accountName: string
  slackConfig: SlackConfig | null
}

const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

export class AuthenticationService {
  constructor(private readonly pool: Pool) {}

  async authenticate(context: RequestContext): Promise<AuthResult> {
    const requestedAccount = context.account
    const trainId = context.trainId

    // Get all credentials linked to this train
    const credentials = await getTrainCredentials(this.pool, trainId)

    if (!credentials.length) {
      throw new AuthenticationError('No credentials configured for this train', {
        requestId: context.requestId,
        trainId,
        hint: 'Link at least one credential to this train via the dashboard',
      })
    }

    // If specific account requested, use it
    if (requestedAccount) {
      const credential = credentials.find(c => c.account_name === requestedAccount)
      if (!credential) {
        throw new AuthenticationError('Requested account not linked to train', {
          requestId: context.requestId,
          account: requestedAccount,
          trainId,
        })
      }
      return this.buildAuthResult(credential, context)
    }

    // Otherwise, use deterministic selection
    const orderedCredentials = this.rankCredentials(trainId, credentials)

    for (const credential of orderedCredentials) {
      try {
        return await this.buildAuthResult(credential, context)
      } catch (error) {
        logger.warn('Skipping credential due to token refresh failure', {
          requestId: context.requestId,
          metadata: {
            accountName: credential.account_name,
            error: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }

    throw new AuthenticationError('No valid credentials available for authentication', {
      requestId: context.requestId,
      trainId,
    })
  }

  private rankCredentials(
    trainId: string,
    credentials: AnthropicCredential[]
  ): AnthropicCredential[] {
    if (credentials.length <= 1) {
      return credentials
    }

    const scored = credentials.map(credential => {
      const hashInput = `${trainId}::${credential.account_name}`
      const digest = createHash('sha256').update(hashInput).digest()
      const score = digest.readBigUInt64BE(0)
      return { credential, score }
    })

    scored.sort((a, b) => {
      if (a.score === b.score) {
        return a.credential.account_name.localeCompare(b.credential.account_name)
      }
      return a.score > b.score ? -1 : 1
    })

    return scored.map(entry => entry.credential)
  }

  private async buildAuthResult(
    credential: AnthropicCredential,
    context: RequestContext
  ): Promise<AuthResult> {
    // Get current access token (will refresh if needed)
    const accessToken = await getApiKey(credential.id, this.pool)

    if (!accessToken) {
      throw new AuthenticationError('Failed to retrieve access token', {
        requestId: context.requestId,
        account: credential.account_name,
      })
    }

    logger.info('Using OAuth credentials for account', {
      requestId: context.requestId,
      trainId: context.trainId,
      metadata: {
        accountName: credential.account_name,
        accountId: credential.account_id,
      },
    })

    return {
      type: 'oauth',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
      key: accessToken,
      betaHeader: OAUTH_BETA_HEADER,
      accountId: credential.account_id,
      accountName: credential.account_name,
      slackConfig: null, // Slack config now comes from train, not credential
    }
  }

  getMaskedCredentialInfo(auth: AuthResult): string {
    const maskedKey = auth.key.substring(0, 10) + '****'
    return `oauth:${maskedKey}`
  }

  clearCaches(): void {
    // No-op: database queries don't need cache clearing
  }

  destroy(): void {
    // No-op: pool is managed by container
  }
}
```

**Key Changes:**

- Constructor now takes `Pool` instead of directory paths
- `authenticate()` queries database for train credentials
- Removed `getClientApiKeys()` (moved to separate service)
- Removed account listing cache (database is efficient)
- Always returns `type: 'oauth'` (API key support removed)

---

### Task 1.2: Update credentials.ts for Database OAuth Refresh

**File:** `services/proxy/src/credentials.ts`

**Changes Required:**

1. Replace file-based `loadCredentials()` with database query
2. Update `saveOAuthCredentials()` to update database
3. Update `getApiKey()` to accept credential ID and pool
4. Keep OAuth refresh logic intact

**Implementation:**

```typescript
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
  debug: boolean = false
): Promise<string | null> {
  const credential = await getCredentialById(pool, credentialId)
  if (!credential) {
    return null
  }

  const cacheKey = `credential:${credentialId}`

  // Check if token needs refresh (refresh 1 minute before expiry)
  const expiresAt = new Date(credential.oauth_expires_at)
  if (Date.now() >= expiresAt.getTime() - 60000) {
    if (debug) {
      console.log(`OAuth token expired for credential ${credentialId}, refreshing...`)
    }

    // Check for recent failure (negative cache)
    const failureCheck = credentialManager.hasRecentFailure(cacheKey)
    if (failureCheck.failed) {
      if (debug) {
        console.log(`[COOLDOWN] Recent refresh failure: ${failureCheck.error}`)
      }
      return null
    }

    // Check for in-progress refresh
    const existingRefresh = credentialManager.getActiveRefresh(cacheKey)
    if (existingRefresh) {
      credentialManager.updateMetrics('concurrent')
      if (debug) {
        console.log(`[CONCURRENT] Waiting for existing refresh`)
      }
      return existingRefresh
    }

    // Start new refresh
    const refreshPromise = (async () => {
      const startTime = Date.now()
      credentialManager.updateMetrics('attempt')

      try {
        if (debug) {
          console.log(`Starting OAuth refresh for credential ${credentialId}`)
        }

        const newTokens = await refreshToken(credential.oauth_refresh_token)

        // Update database
        await updateCredentialTokens(pool, credentialId, {
          oauth_access_token: newTokens.accessToken,
          oauth_refresh_token: newTokens.refreshToken,
          oauth_expires_at: newTokens.expiresAt,
        })

        const duration = Date.now() - startTime
        credentialManager.updateMetrics('success', duration)

        if (debug) {
          console.log(`OAuth token refreshed in ${duration}ms`)
        }

        return newTokens.accessToken
      } catch (refreshError: any) {
        credentialManager.updateMetrics('failure')
        console.error(`Failed to refresh OAuth token:`, refreshError.message)

        credentialManager.recordFailedRefresh(cacheKey, refreshError.message || 'Unknown error')

        return null
      } finally {
        credentialManager.removeActiveRefresh(cacheKey)
      }
    })()

    credentialManager.setActiveRefresh(cacheKey, refreshPromise)
    return refreshPromise
  }

  return credential.oauth_access_token
}

/**
 * Get current OAuth refresh metrics
 */
export function getRefreshMetrics() {
  return credentialManager.getRefreshMetrics()
}
```

**Key Changes:**

- Removed all filesystem operations
- `getApiKey()` now takes credential ID + pool instead of file path
- `refreshToken()` returns typed object instead of `OAuthCredentials` interface
- Saves refreshed tokens to database via `updateCredentialTokens()`

---

### Task 1.3: Update Client Auth Middleware

**File:** `services/proxy/src/middleware/client-auth.ts`

**Changes Required:**

1. Replace filesystem key loading with database query
2. Use `verifyTrainApiKey()` function
3. Simplify timing-safe comparison (plain text keys in DB)

**Implementation:**

```typescript
import { Context, Next } from 'hono'
import { logger } from './logger.js'
import { container } from '../container.js'
import { verifyTrainApiKey } from '@agent-prompttrain/shared/database/queries'

export function clientAuthMiddleware() {
  return async (c: Context, next: Next) => {
    const authorization = c.req.header('Authorization')

    if (!authorization) {
      return c.json(
        {
          error: {
            type: 'authentication_error',
            message: 'Missing Authorization header. Please provide a Bearer token.',
          },
        },
        401,
        { 'WWW-Authenticate': 'Bearer realm="Agent Prompt Train"' }
      )
    }

    const match = authorization.match(/^Bearer\s+(.+)$/i)
    if (!match) {
      return c.json(
        {
          error: {
            type: 'authentication_error',
            message: 'Invalid Authorization header format. Expected: Bearer <token>',
          },
        },
        401,
        { 'WWW-Authenticate': 'Bearer realm="Agent Prompt Train"' }
      )
    }

    const token = match[1]
    const trainId = c.get('trainId')
    const requestId = c.get('requestId')

    if (!trainId) {
      logger.error('Client auth middleware: Train ID not found in context', {
        requestId,
        path: c.req.path,
      })
      return c.json(
        {
          error: {
            type: 'internal_error',
            message: 'Train ID context not found.',
          },
        },
        500
      )
    }

    try {
      const pool = container.getDbPool()
      if (!pool) {
        throw new Error('Database pool not available')
      }

      // Verify API key against database
      const apiKey = await verifyTrainApiKey(pool, trainId, token)

      if (!apiKey) {
        logger.warn('Client auth middleware: Invalid API key', {
          requestId,
          trainId,
          path: c.req.path,
          ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
        })
        return c.json(
          {
            error: {
              type: 'authentication_error',
              message: 'Invalid client API key. Please check your Bearer token.',
            },
          },
          401,
          { 'WWW-Authenticate': 'Bearer realm="Agent Prompt Train"' }
        )
      }

      logger.debug('Client auth middleware: Authentication successful', {
        requestId,
        trainId,
      })

      await next()
    } catch (error) {
      logger.error('Client auth middleware: Error verifying token', {
        requestId,
        trainId,
        error: error instanceof Error ? { message: error.message } : { message: String(error) },
      })
      return c.json(
        {
          error: {
            type: 'internal_error',
            message: 'An error occurred while verifying authentication.',
          },
        },
        500
      )
    }
  }
}
```

**Key Changes:**

- No more filesystem reads or SHA-256 hashing
- Direct database query via `verifyTrainApiKey()`
- Simplified - database handles last_used_at updates

---

### Task 1.4: Update ProxyService to Get Slack Config from Train

**File:** `services/proxy/src/services/ProxyService.ts`

**Changes Required:**

1. Import `getTrainSlackConfig` query
2. Fetch Slack config from train instead of account credential

**Find this section:**

```typescript
// In handleProxyRequest method, after authentication
const slackConfig = authResult.slackConfig
```

**Replace with:**

```typescript
// Get Slack config from train (not account)
const pool = this.storageAdapter?.getPool()
const slackConfig = pool ? await getTrainSlackConfig(pool, context.trainId) : null
```

**Add import at top:**

```typescript
import { getTrainSlackConfig } from '@agent-prompttrain/shared/database/queries'
```

---

### Task 1.5: Update OAuth Login Script

**File:** `scripts/auth/oauth-login.ts`

**Changes Required:**

1. Save credentials to database instead of filesystem
2. Prompt for account_id and account_name
3. Use `createCredential()` query

**Implementation:**

```typescript
#!/usr/bin/env bun
import { Pool } from 'pg'
import { randomBytes, createHash } from 'crypto'
import { createCredential } from '@agent-prompttrain/shared/database/queries'

const DEFAULT_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

const OAUTH_CONFIG = {
  clientId: process.env.CLAUDE_OAUTH_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID,
  authorizationUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  scopes: ['org:create_api_key', 'user:profile', 'user:inference'],
  betaHeader: 'oauth-2025-04-20',
}

function base64URLEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function generateCodeVerifier(): string {
  return base64URLEncode(randomBytes(32))
}

function generateCodeChallenge(verifier: string): string {
  return base64URLEncode(createHash('sha256').update(verifier).digest())
}

function generateAuthorizationUrl(): { url: string; verifier: string } {
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
  authUrl.searchParams.set('state', codeVerifier)

  return { url: authUrl.toString(), verifier: codeVerifier }
}

async function promptInput(question: string): Promise<string> {
  const readline = await import('readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function exchangeCodeForTokens(
  codeWithState: string,
  codeVerifier: string
): Promise<{
  accessToken: string
  refreshToken: string
  expiresAt: Date
  scopes: string[]
  isMax: boolean
}> {
  const [code, state] = codeWithState.split('#')

  if (!code || !state) {
    throw new Error('Invalid authorization code format. Expected format: code#state')
  }

  const response = await fetch(OAUTH_CONFIG.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-beta': OAUTH_CONFIG.betaHeader,
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
    throw new Error(`Failed to exchange code: ${response.status} - ${errorText}`)
  }

  const data = (await response.json()) as any

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    scopes: data.scope ? data.scope.split(' ') : OAUTH_CONFIG.scopes,
    isMax: data.is_max || true,
  }
}

async function performOAuthLogin(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })

  try {
    console.log('Starting OAuth login flow...\n')

    // Get account details
    const accountId = await promptInput('Enter account ID (e.g., acc_team_alpha): ')
    const accountName = await promptInput('Enter account name (e.g., Team Alpha): ')

    if (!accountId || !accountName) {
      console.error('Account ID and name are required')
      process.exit(1)
    }

    // Generate authorization URL
    const { url, verifier } = generateAuthorizationUrl()

    console.log('\nPlease visit the following URL to authorize:')
    console.log(url)
    console.log('\nAfter authorizing, you will see an authorization code.')
    console.log('Copy the entire code (it should contain a # character).\n')

    const code = await promptInput('Enter the authorization code: ')

    console.log('Exchanging authorization code for tokens...')
    const tokens = await exchangeCodeForTokens(code, verifier)

    // Save to database
    console.log('Saving credentials to database...')
    const credential = await createCredential(pool, {
      account_id: accountId,
      account_name: accountName,
      oauth_access_token: tokens.accessToken,
      oauth_refresh_token: tokens.refreshToken,
      oauth_expires_at: tokens.expiresAt,
      oauth_scopes: tokens.scopes,
      oauth_is_max: tokens.isMax,
    })

    console.log(`\n✅ OAuth credentials saved successfully!`)
    console.log(`   Account ID: ${credential.account_id}`)
    console.log(`   Account Name: ${credential.account_name}`)
    console.log(`   Expires At: ${credential.oauth_expires_at}`)
    console.log('\nNext steps:')
    console.log('1. Create or update a train via the dashboard')
    console.log('2. Link this credential to the train')
    console.log('3. Generate API keys for the train')
  } catch (err) {
    console.error('OAuth login failed:', err)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

performOAuthLogin()
```

**Key Changes:**

- Saves to database instead of filesystem
- Prompts for account_id and account_name
- Uses `createCredential()` query
- No API key generation (replaced by train API keys)

---

### Task 1.6: Remove Environment Variables for Filesystem Paths

**File:** `packages/shared/src/config.ts`

**Changes Required:**

1. Remove `ACCOUNTS_DIR` and `TRAIN_CLIENT_KEYS_DIR`
2. Keep `DATABASE_URL` (required)

**Find and remove:**

```typescript
accountsDir: process.env.ACCOUNTS_DIR || 'credentials/accounts',
clientKeysDir: process.env.TRAIN_CLIENT_KEYS_DIR || 'credentials/train-client-keys',
```

---

## Phase 2: Dashboard Backend API

### Task 2.1: Create Credentials API Routes

**File:** `services/dashboard/src/routes/credentials.ts` (NEW)

**Implementation:**

```typescript
import { Hono } from 'hono'
import { container } from '../container'
import {
  listCredentialsSafe,
  getCredentialSafeById,
} from '@agent-prompttrain/shared/database/queries'

const credentials = new Hono()

// GET /api/credentials - List all credentials (safe)
credentials.get('/', async c => {
  try {
    const pool = container.getDbPool()
    if (!pool) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const creds = await listCredentialsSafe(pool)
    return c.json({ credentials: creds })
  } catch (error) {
    console.error('Failed to list credentials:', error)
    return c.json({ error: 'Failed to list credentials' }, 500)
  }
})

// GET /api/credentials/:id - Get credential details (safe)
credentials.get('/:id', async c => {
  try {
    const pool = container.getDbPool()
    if (!pool) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const id = c.req.param('id')
    const credential = await getCredentialSafeById(pool, id)

    if (!credential) {
      return c.json({ error: 'Credential not found' }, 404)
    }

    return c.json({ credential })
  } catch (error) {
    console.error('Failed to get credential:', error)
    return c.json({ error: 'Failed to get credential' }, 500)
  }
})

export default credentials
```

---

### Task 2.2: Create Trains API Routes

**File:** `services/dashboard/src/routes/trains.ts` (NEW)

**Implementation:**

```typescript
import { Hono } from 'hono'
import { container } from '../container'
import {
  listTrainsWithAccounts,
  getTrainWithAccounts,
  createTrain,
  updateTrain,
  linkAccountToTrain,
  unlinkAccountFromTrain,
  getTrainByTrainId,
} from '@agent-prompttrain/shared/database/queries'
import type { CreateTrainRequest, UpdateTrainRequest } from '@agent-prompttrain/shared'

const trains = new Hono()

// GET /api/trains - List all trains with accounts
trains.get('/', async c => {
  try {
    const pool = container.getDbPool()
    if (!pool) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const trainsList = await listTrainsWithAccounts(pool)
    return c.json({ trains: trainsList })
  } catch (error) {
    console.error('Failed to list trains:', error)
    return c.json({ error: 'Failed to list trains' }, 500)
  }
})

// GET /api/trains/:trainId - Get train details with accounts
trains.get('/:trainId', async c => {
  try {
    const pool = container.getDbPool()
    if (!pool) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const trainId = c.req.param('trainId')
    const train = await getTrainWithAccounts(pool, trainId)

    if (!train) {
      return c.json({ error: 'Train not found' }, 404)
    }

    return c.json({ train })
  } catch (error) {
    console.error('Failed to get train:', error)
    return c.json({ error: 'Failed to get train' }, 500)
  }
})

// POST /api/trains - Create new train
trains.post('/', async c => {
  try {
    const pool = container.getDbPool()
    if (!pool) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const body = await c.req.json<CreateTrainRequest>()
    const train = await createTrain(pool, body)

    return c.json({ train }, 201)
  } catch (error: any) {
    console.error('Failed to create train:', error)
    if (error.code === '23505') {
      // Unique violation
      return c.json({ error: 'Train ID already exists' }, 409)
    }
    return c.json({ error: 'Failed to create train' }, 500)
  }
})

// PUT /api/trains/:id - Update train
trains.put('/:id', async c => {
  try {
    const pool = container.getDbPool()
    if (!pool) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const id = c.req.param('id')
    const body = await c.req.json<UpdateTrainRequest>()
    const train = await updateTrain(pool, id, body)

    return c.json({ train })
  } catch (error: any) {
    console.error('Failed to update train:', error)
    if (error.message.includes('not found')) {
      return c.json({ error: 'Train not found' }, 404)
    }
    return c.json({ error: 'Failed to update train' }, 500)
  }
})

// POST /api/trains/:id/accounts - Link account to train
trains.post('/:id/accounts', async c => {
  try {
    const pool = container.getDbPool()
    if (!pool) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const trainId = c.req.param('id')
    const { credential_id } = await c.req.json<{ credential_id: string }>()

    await linkAccountToTrain(pool, trainId, credential_id)

    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to link account:', error)
    return c.json({ error: 'Failed to link account' }, 500)
  }
})

// DELETE /api/trains/:id/accounts/:credentialId - Unlink account
trains.delete('/:id/accounts/:credentialId', async c => {
  try {
    const pool = container.getDbPool()
    if (!pool) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const trainId = c.req.param('id')
    const credentialId = c.req.param('credentialId')

    const success = await unlinkAccountFromTrain(pool, trainId, credentialId)

    if (!success) {
      return c.json({ error: 'Link not found' }, 404)
    }

    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to unlink account:', error)
    return c.json({ error: 'Failed to unlink account' }, 500)
  }
})

export default trains
```

---

### Task 2.3: Create API Keys API Routes

**File:** `services/dashboard/src/routes/api-keys.ts` (NEW)

**Implementation:**

```typescript
import { Hono } from 'hono'
import { container } from '../container'
import {
  listTrainApiKeys,
  createTrainApiKey,
  revokeTrainApiKey,
  getTrainByTrainId,
} from '@agent-prompttrain/shared/database/queries'
import type { CreateApiKeyRequest } from '@agent-prompttrain/shared'

const apiKeys = new Hono()

// GET /api/trains/:trainId/api-keys - List train API keys
apiKeys.get('/:trainId/api-keys', async c => {
  try {
    const pool = container.getDbPool()
    if (!pool) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const trainId = c.req.param('trainId')
    const train = await getTrainByTrainId(pool, trainId)

    if (!train) {
      return c.json({ error: 'Train not found' }, 404)
    }

    const keys = await listTrainApiKeys(pool, train.id)
    return c.json({ api_keys: keys })
  } catch (error) {
    console.error('Failed to list API keys:', error)
    return c.json({ error: 'Failed to list API keys' }, 500)
  }
})

// POST /api/trains/:trainId/api-keys - Generate new API key
apiKeys.post('/:trainId/api-keys', async c => {
  try {
    const pool = container.getDbPool()
    if (!pool) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const trainId = c.req.param('trainId')
    const train = await getTrainByTrainId(pool, trainId)

    if (!train) {
      return c.json({ error: 'Train not found' }, 404)
    }

    const body = await c.req.json<CreateApiKeyRequest>()
    const generatedKey = await createTrainApiKey(pool, train.id, body)

    return c.json({ api_key: generatedKey }, 201)
  } catch (error) {
    console.error('Failed to create API key:', error)
    return c.json({ error: 'Failed to create API key' }, 500)
  }
})

// DELETE /api/trains/:trainId/api-keys/:keyId - Revoke API key
apiKeys.delete('/:trainId/api-keys/:keyId', async c => {
  try {
    const pool = container.getDbPool()
    if (!pool) {
      return c.json({ error: 'Database not available' }, 500)
    }

    const keyId = c.req.param('keyId')
    const success = await revokeTrainApiKey(pool, keyId)

    if (!success) {
      return c.json({ error: 'API key not found or already revoked' }, 404)
    }

    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to revoke API key:', error)
    return c.json({ error: 'Failed to revoke API key' }, 500)
  }
})

export default apiKeys
```

---

### Task 2.4: Register Routes in Dashboard App

**File:** `services/dashboard/src/app.ts`

**Add imports:**

```typescript
import credentialsRoutes from './routes/credentials'
import trainsRoutes from './routes/trains'
import apiKeysRoutes from './routes/api-keys'
```

**Register routes (after existing routes):**

```typescript
app.route('/api/credentials', credentialsRoutes)
app.route('/api/trains', trainsRoutes)
app.route('/api/trains', apiKeysRoutes) // Nested under trains
```

---

## Phase 3: Dashboard Frontend UI

### Task 3.1: Create Credentials List Page

**File:** `services/dashboard/src/components/CredentialsList.tsx` (NEW)

```tsx
import React, { useEffect, useState } from 'react'
import type { AnthropicCredentialSafe } from '@agent-prompttrain/shared'

export function CredentialsList() {
  const [credentials, setCredentials] = useState<AnthropicCredentialSafe[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadCredentials()
  }, [])

  async function loadCredentials() {
    try {
      const response = await fetch('/api/credentials')
      if (!response.ok) throw new Error('Failed to load credentials')
      const data = await response.json()
      setCredentials(data.credentials)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  function getStatusBadge(status: string) {
    switch (status) {
      case 'valid':
        return <span className="badge badge-success">Valid</span>
      case 'expiring_soon':
        return <span className="badge badge-warning">Expiring Soon</span>
      case 'expired':
        return <span className="badge badge-error">Expired</span>
      default:
        return <span className="badge">Unknown</span>
    }
  }

  if (loading) return <div>Loading credentials...</div>
  if (error) return <div className="alert alert-error">{error}</div>

  return (
    <div className="credentials-list">
      <h1>Anthropic Credentials</h1>

      <table className="table">
        <thead>
          <tr>
            <th>Account Name</th>
            <th>Account ID</th>
            <th>Token Status</th>
            <th>Expires At</th>
            <th>Token Suffix</th>
            <th>Scopes</th>
          </tr>
        </thead>
        <tbody>
          {credentials.map(cred => (
            <tr key={cred.id}>
              <td>{cred.account_name}</td>
              <td>
                <code>{cred.account_id}</code>
              </td>
              <td>{getStatusBadge(cred.token_status)}</td>
              <td>{new Date(cred.oauth_expires_at).toLocaleString()}</td>
              <td>
                <code>****{cred.token_suffix}</code>
              </td>
              <td>{cred.oauth_scopes.join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

---

### Task 3.2: Create Trains List Page

**File:** `services/dashboard/src/components/TrainsList.tsx` (NEW)

```tsx
import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom' // or your router
import type { TrainWithAccounts } from '@agent-prompttrain/shared'

export function TrainsList() {
  const [trains, setTrains] = useState<TrainWithAccounts[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadTrains()
  }, [])

  async function loadTrains() {
    try {
      const response = await fetch('/api/trains')
      if (!response.ok) throw new Error('Failed to load trains')
      const data = await response.json()
      setTrains(data.trains)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  if (loading) return <div>Loading trains...</div>
  if (error) return <div className="alert alert-error">{error}</div>

  return (
    <div className="trains-list">
      <h1>Trains</h1>

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Train ID</th>
            <th>Linked Accounts</th>
            <th>Slack Enabled</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {trains.map(train => (
            <tr key={train.id}>
              <td>{train.name}</td>
              <td>
                <code>{train.train_id}</code>
              </td>
              <td>{train.accounts.length} account(s)</td>
              <td>{train.slack_enabled ? '✓' : '✗'}</td>
              <td>
                <Link to={`/trains/${train.train_id}`}>
                  <button className="btn btn-sm">Manage</button>
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

---

### Task 3.3: Create Train Detail Page with API Key Management

**File:** `services/dashboard/src/components/TrainDetail.tsx` (NEW)

```tsx
import React, { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { TrainWithAccounts, TrainApiKeySafe, GeneratedApiKey } from '@agent-prompttrain/shared'

export function TrainDetail() {
  const { trainId } = useParams<{ trainId: string }>()
  const [train, setTrain] = useState<TrainWithAccounts | null>(null)
  const [apiKeys, setApiKeys] = useState<TrainApiKeySafe[]>([])
  const [loading, setLoading] = useState(true)
  const [showKeyModal, setShowKeyModal] = useState(false)
  const [generatedKey, setGeneratedKey] = useState<GeneratedApiKey | null>(null)

  useEffect(() => {
    loadTrain()
    loadApiKeys()
  }, [trainId])

  async function loadTrain() {
    try {
      const response = await fetch(`/api/trains/${trainId}`)
      if (!response.ok) throw new Error('Failed to load train')
      const data = await response.json()
      setTrain(data.train)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  async function loadApiKeys() {
    try {
      const response = await fetch(`/api/trains/${trainId}/api-keys`)
      if (!response.ok) throw new Error('Failed to load API keys')
      const data = await response.json()
      setApiKeys(data.api_keys)
    } catch (err) {
      console.error(err)
    }
  }

  async function generateApiKey() {
    const name = prompt('Enter a name for this API key (optional):')

    try {
      const response = await fetch(`/api/trains/${trainId}/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || undefined }),
      })

      if (!response.ok) throw new Error('Failed to generate API key')

      const data = await response.json()
      setGeneratedKey(data.api_key)
      setShowKeyModal(true)
      loadApiKeys() // Refresh list
    } catch (err) {
      alert('Failed to generate API key')
    }
  }

  async function revokeApiKey(keyId: string) {
    if (!confirm('Are you sure you want to revoke this API key?')) return

    try {
      const response = await fetch(`/api/trains/${trainId}/api-keys/${keyId}`, {
        method: 'DELETE',
      })

      if (!response.ok) throw new Error('Failed to revoke API key')

      loadApiKeys() // Refresh list
    } catch (err) {
      alert('Failed to revoke API key')
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text)
    alert('Copied to clipboard!')
  }

  if (loading) return <div>Loading...</div>
  if (!train) return <div>Train not found</div>

  return (
    <div className="train-detail">
      <h1>{train.name}</h1>
      <p>
        <strong>Train ID:</strong> <code>{train.train_id}</code>
      </p>
      <p>
        <strong>Description:</strong> {train.description || 'N/A'}
      </p>

      <h2>Linked Accounts ({train.accounts.length})</h2>
      <ul>
        {train.accounts.map(account => (
          <li key={account.id}>
            {account.account_name} ({account.account_id}){' - '}
            <span className={`status-${account.token_status}`}>{account.token_status}</span>
          </li>
        ))}
      </ul>

      <h2>API Keys</h2>
      <button onClick={generateApiKey} className="btn btn-primary">
        Generate New API Key
      </button>

      <table className="table mt-4">
        <thead>
          <tr>
            <th>Name</th>
            <th>Key Preview</th>
            <th>Status</th>
            <th>Created At</th>
            <th>Last Used</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {apiKeys.map(key => (
            <tr key={key.id}>
              <td>{key.name || '<unnamed>'}</td>
              <td>
                <code>{key.key_preview}</code>
              </td>
              <td>
                {key.status === 'active' ? (
                  <span className="badge badge-success">Active</span>
                ) : (
                  <span className="badge badge-error">Revoked</span>
                )}
              </td>
              <td>{new Date(key.created_at).toLocaleString()}</td>
              <td>{key.last_used_at ? new Date(key.last_used_at).toLocaleString() : 'Never'}</td>
              <td>
                {key.status === 'active' && (
                  <button onClick={() => revokeApiKey(key.id)} className="btn btn-sm btn-error">
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Modal for showing generated key */}
      {showKeyModal && generatedKey && (
        <div className="modal modal-open">
          <div className="modal-box">
            <h3>API Key Generated!</h3>
            <p className="text-warning">⚠️ Save this key now - it will only be shown once!</p>
            <div className="bg-base-200 p-4 rounded mt-4">
              <code className="text-sm break-all">{generatedKey.api_key}</code>
            </div>
            <div className="modal-action">
              <button
                onClick={() => copyToClipboard(generatedKey.api_key)}
                className="btn btn-primary"
              >
                Copy to Clipboard
              </button>
              <button
                onClick={() => {
                  setShowKeyModal(false)
                  setGeneratedKey(null)
                }}
                className="btn"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
```

---

### Task 3.4: Add Routes to Dashboard Router

**File:** `services/dashboard/src/App.tsx` (or your routing file)

**Add routes:**

```tsx
import { CredentialsList } from './components/CredentialsList'
import { TrainsList } from './components/TrainsList'
import { TrainDetail } from './components/TrainDetail'

// In your router:
<Route path="/credentials" element={<CredentialsList />} />
<Route path="/trains" element={<TrainsList />} />
<Route path="/trains/:trainId" element={<TrainDetail />} />
```

---

## Phase 4: Testing & Documentation

### Task 4.1: Run Database Migration

```bash
bun run scripts/db/migrations/013-credential-train-management.ts
```

**Verify tables created:**

```sql
\dt -- List tables
\d anthropic_credentials
\d trains
\d train_accounts
\d train_api_keys
```

---

### Task 4.2: Test OAuth Login Script

```bash
bun run scripts/auth/oauth-login.ts
```

**Follow prompts to:**

1. Enter account ID and name
2. Complete OAuth flow
3. Verify credential saved to database

---

### Task 4.3: Test Dashboard APIs

Use `curl` or Postman:

```bash
# List credentials
curl http://localhost:3001/api/credentials

# Create train
curl -X POST http://localhost:3001/api/trains \
  -H "Content-Type: application/json" \
  -d '{"train_id":"test-train","name":"Test Train"}'

# Link account to train
curl -X POST http://localhost:3001/api/trains/{train-uuid}/accounts \
  -H "Content-Type: application/json" \
  -d '{"credential_id":"{credential-uuid}"}'

# Generate API key
curl -X POST http://localhost:3001/api/trains/test-train/api-keys \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Key"}'

# Test proxy with API key
curl -X POST http://localhost:3000/v1/messages \
  -H "MSL-Train-Id: test-train" \
  -H "Authorization: Bearer cnp_live_..." \
  -H "Content-Type: application/json" \
  -d '{...}'
```

---

### Task 4.4: Update Documentation

**Files to update:**

1. **`docs/02-User-Guide/authentication.md`**
   - Remove filesystem credential instructions
   - Add OAuth login script usage
   - Add dashboard credential management instructions

2. **`docs/06-Reference/environment-vars.md`**
   - Remove `ACCOUNTS_DIR` and `TRAIN_CLIENT_KEYS_DIR`
   - Emphasize `DATABASE_URL` is required

3. **`docs/04-Architecture/ADRs/adr-026-database-credential-management.md`** (NEW)
   - Document this architectural decision
   - Explain migration from filesystem to database
   - Document OAuth-only support decision

4. **`CLAUDE.md`**
   - Update configuration section
   - Remove credential directory references
   - Add database requirement

5. **`README.md`**
   - Update setup instructions
   - Add OAuth login step
   - Update environment variables section

---

### Task 4.5: Run Typecheck

```bash
bun run typecheck
```

**Fix any type errors that appear.**

---

### Task 4.6: Run E2E Tests

```bash
bun run test:e2e:smoke
```

**Expected to fail initially - update tests:**

- Remove filesystem credential setup
- Add database credential setup
- Update train configuration tests

---

## Phase 5: Finalization

### Task 5.1: Clean Up Filesystem Code

**Files to review and remove filesystem logic:**

1. `services/proxy/src/credentials.ts` - Remove unused file operations
2. `services/proxy/src/services/CredentialStatusService.ts` - Remove or refactor
3. Remove `credentials/` directory from `.gitignore` (no longer needed)

---

### Task 5.2: Create ADR

**File:** `docs/04-Architecture/ADRs/adr-026-database-credential-management.md`

```markdown
# ADR-026: Database-Based Credential and Train Management

**Status:** Accepted

**Date:** 2025-01-XX

## Context

Previously, the proxy managed Anthropic credentials and train configurations through the filesystem:

- Credentials stored in `credentials/accounts/*.credentials.json`
- Train API keys stored in `credentials/train-client-keys/*.client-keys.json`
- Supported both API key and OAuth authentication

This approach had limitations:

- No centralized management UI
- Manual file editing required
- No audit trail for API key generation/revocation
- Difficult to scale across multiple proxy instances
- Mixed credential types (API key + OAuth) added complexity

## Decision

Migrate to database-based credential and train management:

1. **OAuth-Only Support**: Remove API key authentication, support only OAuth
2. **Database Schema**: Store credentials, trains, and API keys in PostgreSQL
3. **Many-to-Many Relationship**: Trains can link to multiple credentials
4. **Slack Configuration**: Move from credentials to trains
5. **API Key Management**: Generate/revoke train API keys via dashboard
6. **Dashboard UI**: Provide web interface for all management tasks

## Consequences

### Positive

- ✅ Centralized management via dashboard UI
- ✅ Proper audit trail (created_at, last_used_at, revoked_at)
- ✅ Multi-instance support (shared database)
- ✅ Simplified authentication flow (OAuth only)
- ✅ Proper train/account separation
- ✅ API key rotation support

### Negative

- ❌ Requires database migration for existing deployments
- ❌ No automatic import from filesystem credentials
- ❌ Breaking change (requires manual reconfiguration)
- ❌ Increased complexity for initial setup

### Migration Path

1. Run migration script to create new tables
2. Use OAuth login script to add credentials to database
3. Create trains via dashboard
4. Link credentials to trains
5. Generate new API keys for clients
6. Update client configurations with new keys

## Alternatives Considered

1. **Hybrid approach** (filesystem + database): Rejected due to complexity
2. **Keep API key support**: Rejected to simplify authentication
3. **Automatic migration script**: Deferred to future enhancement

## References

- ADR-004: Proxy-Level Authentication
- ADR-024: Header-Based Train Routing
- Migration: 013-credential-train-management.ts
```

---

### Task 5.3: Update .env.example

```bash
# Database (REQUIRED)
DATABASE_URL=postgresql://user:password@localhost:5432/agent_prompttrain

# OAuth Configuration
CLAUDE_OAUTH_CLIENT_ID=9d1c250a-e61b-44d9-88ed-5944d1962f5e

# Dashboard Authentication (REQUIRED in production)
DASHBOARD_API_KEY=your-secret-key-here

# Client Authentication (Optional)
ENABLE_CLIENT_AUTH=true

# Default Train ID
DEFAULT_TRAIN_ID=default
```

---

### Task 5.4: Commit and Push

```bash
git add .
git commit -m "feat: migrate to database-based credential and train management

- Add database schema for credentials, trains, and API keys (migration 013)
- Remove filesystem credential support
- Support OAuth-only authentication
- Add dashboard UI for credential and train management
- Add API key generation and revocation
- Move Slack configuration from credentials to trains
- Update AuthenticationService to use database
- Update OAuth login script to save to database
- Add comprehensive API endpoints for management

BREAKING CHANGE: Credentials must be reconfigured in database.
Manual migration required - see docs/04-Architecture/ADRs/adr-026-database-credential-management.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"

git push origin feature/database-credential-train-management
```

---

### Task 5.5: Create Pull Request

```bash
gh pr create --title "feat: database-based credential and train management" --body "$(cat <<'EOF'
## Summary

Migrates credential and train management from filesystem to database with OAuth-only support.

## Changes

### Backend
- ✅ Database schema (migration 013)
- ✅ OAuth-only credential support
- ✅ Train configuration with Slack settings
- ✅ API key generation and revocation
- ✅ AuthenticationService refactored for database
- ✅ OAuth login script updated

### Dashboard
- ✅ Credentials list page
- ✅ Trains list and detail pages
- ✅ API key management UI
- ✅ REST API endpoints for all operations

### Documentation
- ✅ ADR-026: Database Credential Management
- ✅ Updated authentication docs
- ✅ Updated environment variable docs

## Breaking Changes

⚠️ **BREAKING CHANGE**: Filesystem credentials no longer supported

### Migration Steps

1. Run migration: `bun run scripts/db/migrations/013-credential-train-management.ts`
2. Add credentials: `bun run scripts/auth/oauth-login.ts`
3. Create trains via dashboard
4. Link credentials to trains
5. Generate API keys
6. Update client configurations

## Testing

- [ ] OAuth login creates database credential
- [ ] Train creation and updates work
- [ ] API key generation and revocation work
- [ ] Proxy authenticates using database credentials
- [ ] Client auth verifies against database API keys
- [ ] Slack notifications use train config
- [ ] Dashboard UI displays all data correctly

## References

- Closes #XXX (if applicable)
- See ADR-026 for architecture details
EOF
)"
```

---

### Task 5.6: Verify CI Checks

Monitor GitHub Actions:

- ✅ Typecheck passes
- ✅ Build succeeds
- ✅ Tests pass (may need updates)
- ✅ Docker builds successfully

---

## Summary Checklist

### Phase 1: Backend ✅

- [ ] Task 1.1: Rewrite AuthenticationService
- [ ] Task 1.2: Update credentials.ts OAuth refresh
- [ ] Task 1.3: Update client-auth middleware
- [ ] Task 1.4: Update ProxyService Slack config
- [ ] Task 1.5: Update OAuth login script
- [ ] Task 1.6: Remove filesystem env vars

### Phase 2: Dashboard API ✅

- [ ] Task 2.1: Credentials API routes
- [ ] Task 2.2: Trains API routes
- [ ] Task 2.3: API Keys API routes
- [ ] Task 2.4: Register routes in dashboard app

### Phase 3: Dashboard UI ✅

- [ ] Task 3.1: Credentials list page
- [ ] Task 3.2: Trains list page
- [ ] Task 3.3: Train detail with API key management
- [ ] Task 3.4: Add routes to router

### Phase 4: Testing ✅

- [ ] Task 4.1: Run database migration
- [ ] Task 4.2: Test OAuth login script
- [ ] Task 4.3: Test dashboard APIs
- [ ] Task 4.4: Update documentation
- [ ] Task 4.5: Run typecheck
- [ ] Task 4.6: Run E2E tests

### Phase 5: Finalization ✅

- [ ] Task 5.1: Clean up filesystem code
- [ ] Task 5.2: Create ADR-026
- [ ] Task 5.3: Update .env.example
- [ ] Task 5.4: Commit and push
- [ ] Task 5.5: Create pull request
- [ ] Task 5.6: Verify CI checks

---

## Next Steps

After completing this guide, you will have:

- ✅ Database-backed credential and train management
- ✅ OAuth-only authentication
- ✅ Dashboard UI for all management tasks
- ✅ API key generation and revocation
- ✅ Comprehensive documentation

**Proceed task by task, testing each component as you go.**
