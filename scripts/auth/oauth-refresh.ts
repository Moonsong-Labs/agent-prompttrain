#!/usr/bin/env bun
import { Pool } from 'pg'
import { CredentialsRepository } from '../../packages/shared/src/database/credentials-repository'
import { decrypt } from '../../packages/shared/src/utils/encryption'

const DEFAULT_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
const BETA_HEADER = 'oauth-2025-04-20'

async function refreshToken(refreshToken: string): Promise<{
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
  isMax: boolean
}> {
  const CLIENT_ID = process.env.CLAUDE_OAUTH_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID

  const response = await fetch(TOKEN_URL, {
    headers: {
      'Content-Type': 'application/json',
      'anthropic-beta': BETA_HEADER,
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
    let errorData: any = {}
    try {
      errorData = JSON.parse(errorText)
    } catch {}

    const error = new Error(
      errorData.error_description ||
        errorData.error ||
        `Failed to refresh token: ${response.status} ${response.statusText}`
    ) as any
    error.status = response.status
    error.errorCode = errorData.error
    error.errorDescription = errorData.error_description
    throw error
  }

  const payload = (await response.json()) as any
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || refreshToken,
    expiresAt: Date.now() + payload.expires_in * 1000,
    scopes: payload.scope ? payload.scope.split(' ') : [],
    isMax: payload.is_max || true,
  }
}

async function refreshOAuthToken() {
  const accountIdOrName = process.argv[2]
  const forceRefresh = process.argv[3] === '--force'

  if (!accountIdOrName) {
    console.error('Usage: bun run scripts/auth/oauth-refresh.ts <account-id-or-name> [--force]')
    console.error('Example: bun run scripts/auth/oauth-refresh.ts acc_example')
    console.error('Example: bun run scripts/auth/oauth-refresh.ts my-account')
    console.error('\nOptions:')
    console.error('  --force    Force refresh even if token is not expired')
    process.exit(1)
  }

  const encryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY
  if (!encryptionKey || encryptionKey.length < 32) {
    console.error('ERROR: CREDENTIAL_ENCRYPTION_KEY must be set and at least 32 characters')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const repo = new CredentialsRepository(pool, encryptionKey)

  try {
    console.log(`Loading account: ${accountIdOrName}`)

    // Try to find account by ID first, then by name
    let account = await repo.getAccountById(accountIdOrName)

    if (!account) {
      const accounts = await repo.listAccounts()
      account = accounts.find(a => a.accountName === accountIdOrName) || null
    }

    if (!account) {
      console.error(`No account found with ID or name: ${accountIdOrName}`)
      process.exit(1)
    }

    if (account.credentialType !== 'oauth') {
      console.error('This script only works with OAuth credentials')
      console.error(`Found credential type: ${account.credentialType}`)
      process.exit(1)
    }

    const now = Date.now()
    const expiresAt = account.oauthExpiresAt || 0
    const isExpired = now >= expiresAt
    const willExpireSoon = now >= expiresAt - 60000

    console.log('\nCurrent OAuth status:')
    console.log(`- Account ID: ${account.accountId}`)
    console.log(`- Account Name: ${account.accountName}`)
    console.log(`- Expires At: ${expiresAt ? new Date(expiresAt).toISOString() : 'unknown'}`)
    console.log(`- Status: ${isExpired ? 'EXPIRED' : willExpireSoon ? 'EXPIRING SOON' : 'VALID'}`)

    if (!isExpired && !willExpireSoon && !forceRefresh) {
      const expiresIn = expiresAt - now
      const hours = Math.floor(expiresIn / (1000 * 60 * 60))
      const minutes = Math.floor((expiresIn % (1000 * 60 * 60)) / (1000 * 60))
      console.log(`- Expires In: ${hours}h ${minutes}m`)
      console.log('\nToken is still valid. Use --force to refresh anyway.')
      process.exit(0)
    }

    // Get encrypted refresh token from database
    const fullAccount = await pool.query<{
      account_name: string
      oauth_refresh_token_encrypted: string
    }>('SELECT account_name, oauth_refresh_token_encrypted FROM accounts WHERE account_id = $1', [
      account.accountId,
    ])

    if (!fullAccount.rows[0]?.oauth_refresh_token_encrypted) {
      console.error('\nERROR: No refresh token available. Re-authentication required.')
      console.error(`Run: bun run scripts/auth/oauth-login.ts <account-name>`)
      process.exit(1)
    }

    const encryptedRefreshToken = fullAccount.rows[0].oauth_refresh_token_encrypted
    const decryptedRefreshToken = decrypt(encryptedRefreshToken, encryptionKey)
    const oldAccountName = fullAccount.rows[0].account_name

    console.log('\nRefreshing OAuth token...')
    const startTime = Date.now()

    try {
      const newOAuth = await refreshToken(decryptedRefreshToken)
      const refreshTime = Date.now() - startTime

      console.log(`\n✅ Token refreshed successfully in ${refreshTime}ms`)

      // Since credentials are immutable, we need to delete the old account and create a new one
      console.log('\nUpdating database (delete old + create new)...')

      await repo.deleteAccount(account.accountId)

      const newAccountId = await repo.createAccount({
        accountName: oldAccountName,
        credentialType: 'oauth',
        oauthAccessToken: newOAuth.accessToken,
        oauthRefreshToken: newOAuth.refreshToken,
        oauthExpiresAt: newOAuth.expiresAt,
        oauthScopes: newOAuth.scopes,
        oauthIsMax: newOAuth.isMax,
      })

      console.log('\nNew OAuth status:')
      console.log(`- Account ID: ${newAccountId} (new)`)
      console.log(`- Account Name: ${oldAccountName}`)
      console.log(`- Expires At: ${new Date(newOAuth.expiresAt).toISOString()}`)
      console.log(`- Scopes: ${newOAuth.scopes.join(', ')}`)
      console.log(`- Is Max: ${newOAuth.isMax}`)

      const expiresIn = newOAuth.expiresAt - Date.now()
      const hours = Math.floor(expiresIn / (1000 * 60 * 60))
      const minutes = Math.floor((expiresIn % (1000 * 60 * 60)) / (1000 * 60))
      console.log(`- Valid For: ${hours}h ${minutes}m`)

      console.log('\n⚠️  NOTE: A new account ID was created. Update any train configurations')
      console.log(
        `that referenced the old ID (${account.accountId}) to use the new ID (${newAccountId})`
      )
    } catch (error: any) {
      console.error('\n❌ Failed to refresh token:', error.message)

      if (error.errorCode === 'invalid_grant' || error.status === 400) {
        console.error('\nThe refresh token is invalid or has been revoked.')
        console.error('You need to re-authenticate to get new credentials.')
        console.error(`\nRun: bun run scripts/auth/oauth-login.ts <account-name>`)
      } else if (error.status) {
        console.error(`\nHTTP Status: ${error.status}`)
        console.error(`Error Code: ${error.errorCode || 'unknown'}`)
        console.error(`Description: ${error.errorDescription || 'No description provided'}`)
      }

      process.exit(1)
    }
  } catch (error) {
    console.error('Error:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

refreshOAuthToken()
