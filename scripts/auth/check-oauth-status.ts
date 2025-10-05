#!/usr/bin/env bun
import { Pool } from 'pg'
import { CredentialsRepository } from '../../packages/shared/src/database/credentials-repository'
import { decrypt } from '../../packages/shared/src/utils/encryption'

async function checkOAuthStatus() {
  const accountIdOrName = process.argv[2]

  if (!accountIdOrName) {
    console.error('Usage: bun run scripts/auth/check-oauth-status.ts <account-id-or-name>')
    console.error('Example: bun run scripts/auth/check-oauth-status.ts acc_example')
    console.error('Example: bun run scripts/auth/check-oauth-status.ts my-account')
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
    // Try to find account by ID first, then by name
    let account = await repo.getAccountById(accountIdOrName)

    if (!account) {
      // Try to find by name
      const accounts = await repo.listAccounts()
      account = accounts.find(a => a.accountName === accountIdOrName) || null
    }

    if (!account) {
      console.error(`No account found with ID or name: ${accountIdOrName}`)
      process.exit(1)
    }

    console.log(`Account ID: ${account.accountId}`)
    console.log(`Account Name: ${account.accountName}`)
    console.log(`Type: ${account.credentialType}`)
    console.log(`Status: ${account.isActive ? 'Active' : 'Inactive'}`)
    console.log(`Created: ${new Date(account.createdAt).toLocaleString()}`)
    console.log(`Updated: ${new Date(account.updatedAt).toLocaleString()}`)

    if (account.credentialType === 'oauth') {
      const now = Date.now()
      const expiresAt = account.oauthExpiresAt || 0
      const isExpired = now >= expiresAt
      const expiresIn = Math.max(0, expiresAt - now)

      console.log('\nOAuth Details:')
      console.log(`- Expires At: ${expiresAt ? new Date(expiresAt).toISOString() : 'unknown'}`)
      console.log(`- Status: ${isExpired ? 'EXPIRED' : 'Valid'}`)

      if (!isExpired) {
        const hours = Math.floor(expiresIn / (1000 * 60 * 60))
        const minutes = Math.floor((expiresIn % (1000 * 60 * 60)) / (1000 * 60))
        console.log(`- Expires In: ${hours}h ${minutes}m`)
      } else {
        console.log(`- Expired: ${Math.floor((now - expiresAt) / (1000 * 60 * 60))} hours ago`)
      }

      console.log(`- Scopes: ${account.oauthScopes ? account.oauthScopes.join(', ') : 'none'}`)
      console.log(`- Is Max: ${account.oauthIsMax}`)

      // Get encrypted credentials to check if refresh token exists
      const fullAccount = await pool.query(
        'SELECT oauth_refresh_token_encrypted FROM accounts WHERE account_id = $1',
        [account.accountId]
      )

      const hasRefreshToken = fullAccount.rows[0]?.oauth_refresh_token_encrypted != null

      if (!hasRefreshToken) {
        console.warn(
          '\nWARNING: No refresh token available. Re-authentication will be required when access token expires.'
        )
      }

      if (isExpired && hasRefreshToken) {
        console.log('\nToken is expired but has refresh token. Run oauth-refresh.ts to refresh it.')
      } else if (isExpired && !hasRefreshToken) {
        console.error(
          '\nERROR: Token is expired and no refresh token available. Re-authentication required!'
        )
        console.log(`Run: bun run scripts/auth/oauth-login.ts ${account.accountId}`)
      }
    }

    if (account.lastUsedAt) {
      console.log(`\nLast Used: ${new Date(account.lastUsedAt).toLocaleString()}`)
    }
  } catch (error) {
    console.error('Error checking OAuth status:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

checkOAuthStatus()
