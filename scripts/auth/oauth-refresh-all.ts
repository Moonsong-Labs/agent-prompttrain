#!/usr/bin/env bun
import { Pool } from 'pg'
import { CredentialsRepository } from '../../packages/shared/src/database/credentials-repository'

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

async function refreshAllOAuthTokens() {
  const dryRun = process.argv.includes('--dry-run')

  console.log('OAuth Refresh All Tool')
  console.log('=====================')
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE'}\n`)

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const repo = new CredentialsRepository(pool)

  try {
    const accounts = await repo.listAccounts()
    const oauthAccounts = accounts.filter(a => a.credentialType === 'oauth')

    if (oauthAccounts.length === 0) {
      console.log('No OAuth accounts found in database.')
      process.exit(0)
    }

    console.log(`Found ${oauthAccounts.length} OAuth account(s)\n`)

    const results = {
      total: oauthAccounts.length,
      refreshed: 0,
      failed: 0,
      skipped: 0,
      errors: [] as { account: string; error: string }[],
    }

    for (const account of oauthAccounts) {
      console.log(`\n[${account.accountName}]`)

      const now = Date.now()
      const expiresAt = account.oauthExpiresAt || 0
      const isExpired = now >= expiresAt
      const willExpireSoon = now >= expiresAt - 300000 // 5 minutes before expiry

      if (!isExpired && !willExpireSoon) {
        const expiresIn = expiresAt - now
        const hours = Math.floor(expiresIn / (1000 * 60 * 60))
        console.log(`  ✓ Token valid for ${hours}h (skipping)`)
        results.skipped++
        continue
      }

      // Get refresh token
      const fullAccount = await pool.query<{
        oauth_refresh_token: string
      }>('SELECT oauth_refresh_token FROM accounts WHERE account_id = $1', [account.accountId])

      if (!fullAccount.rows[0]?.oauth_refresh_token) {
        console.log('  ⚠️  No refresh token available')
        results.failed++
        results.errors.push({ account: account.accountName, error: 'No refresh token' })
        continue
      }

      console.log(`  🔄 Refreshing ${isExpired ? 'expired' : 'expiring'} token...`)

      if (dryRun) {
        console.log('  📝 Would refresh token (dry run)')
        results.refreshed++
        continue
      }

      try {
        const refreshTokenValue = fullAccount.rows[0].oauth_refresh_token

        const newOAuth = await refreshToken(refreshTokenValue)

        // Delete old account and create new one (credentials are immutable)
        await repo.deleteAccount(account.accountId)

        const newAccountId = await repo.createAccount({
          accountName: account.accountName,
          credentialType: 'oauth',
          oauthAccessToken: newOAuth.accessToken,
          oauthRefreshToken: newOAuth.refreshToken,
          oauthExpiresAt: newOAuth.expiresAt,
          oauthScopes: newOAuth.scopes,
          oauthIsMax: newOAuth.isMax,
        })

        const expiresIn = newOAuth.expiresAt - Date.now()
        const hours = Math.floor(expiresIn / (1000 * 60 * 60))
        console.log(`  ✅ Refreshed! Valid for ${hours}h`)

        if (newAccountId !== account.accountId) {
          console.log(`  ⚠️  New account ID: ${newAccountId} (was: ${account.accountId})`)
        }

        results.refreshed++
      } catch (error: any) {
        console.log(`  ❌ Refresh failed: ${error.message}`)
        results.failed++
        results.errors.push({ account: account.accountName, error: error.message })
      }
    }

    // Summary
    console.log('\n\nSummary')
    console.log('=======')
    console.log(`Total OAuth accounts: ${results.total}`)
    console.log(`- Refreshed: ${results.refreshed}`)
    console.log(`- Skipped (valid): ${results.skipped}`)
    console.log(`- Failed: ${results.failed}`)

    if (results.errors.length > 0) {
      console.log('\nErrors:')
      results.errors.forEach(({ account, error }) => {
        console.log(`- ${account}: ${error}`)
      })
    }

    if (dryRun) {
      console.log('\n⚠️  This was a dry run. No changes were made.')
      console.log('Remove --dry-run to actually refresh tokens.')
    }

    if (results.refreshed > 0 && !dryRun) {
      console.log('\n⚠️  IMPORTANT: Account IDs may have changed during refresh.')
      console.log('Please update any train configurations that reference the old account IDs.')
    }

    process.exit(results.failed > 0 ? 1 : 0)
  } catch (error) {
    console.error('Error:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

refreshAllOAuthTokens()
