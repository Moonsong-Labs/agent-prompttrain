#!/usr/bin/env bun
import { Pool } from 'pg'
import { getCredentialByAccountId } from '../../packages/shared/src/database/queries/index.js'
import { OAuthRefreshError, refreshAccessToken } from '../../services/proxy/src/credentials.ts'

const USAGE = 'Usage: bun run scripts/auth/oauth-refresh.ts <account-id> [--force]'

function printUsage(log: (message: string) => void) {
  log(USAGE)
  log('Example: bun run scripts/auth/oauth-refresh.ts acc_team_alpha')
  log('\nOptions:')
  log('  --force    Force refresh even if token is not expired')
}

async function refreshOAuthCredential() {
  const args = process.argv.slice(2)
  const accountId = args.find(arg => !arg.startsWith('-'))
  const forceRefresh = args.includes('--force')

  if (args.includes('--help') || args.includes('-h')) {
    printUsage(console.log)
    process.exit(0)
  }

  if (!accountId) {
    printUsage(console.error)
    process.exit(1)
  }

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })

  try {
    console.log(`Loading credential: ${accountId}`)

    const credential = await getCredentialByAccountId(pool, accountId)

    if (!credential) {
      console.error(`Credential not found: ${accountId}`)
      process.exit(1)
    }

    if (credential.provider !== 'anthropic') {
      console.error(`${accountId} is a ${credential.provider} credential, not Anthropic OAuth`)
      process.exit(1)
    }

    const now = new Date()
    const expiresAt = credential.oauth_expires_at ? new Date(credential.oauth_expires_at) : null
    const isExpired = expiresAt ? now >= expiresAt : true
    const willExpireSoon = expiresAt ? now >= new Date(expiresAt.getTime() - 60000) : true // 1 minute before expiry

    console.log('\nCurrent OAuth status:')
    console.log(
      `- Access Token: ${credential.oauth_access_token ? credential.oauth_access_token.substring(0, 20) + '...' : 'missing'}`
    )
    console.log(
      `- Refresh Token: ${credential.oauth_refresh_token ? credential.oauth_refresh_token.substring(0, 20) + '...' : 'missing'}`
    )
    console.log(`- Expires At: ${expiresAt ? expiresAt.toISOString() : 'unknown'}`)
    console.log(`- Status: ${isExpired ? 'EXPIRED' : willExpireSoon ? 'EXPIRING SOON' : 'VALID'}`)

    if (!isExpired && !willExpireSoon && !forceRefresh) {
      const expiresIn = expiresAt!.getTime() - now.getTime()
      const hours = Math.floor(expiresIn / (1000 * 60 * 60))
      const minutes = Math.floor((expiresIn % (1000 * 60 * 60)) / (1000 * 60))
      console.log(`- Expires In: ${hours}h ${minutes}m`)
      console.log('\nToken is still valid. Use --force to refresh anyway.')
      process.exit(0)
    }

    if (!credential.oauth_refresh_token) {
      console.error('\nERROR: No refresh token available. Re-authentication required.')
      console.error(`Run: bun run auth:oauth-relogin --account ${credential.account_id}`)
      process.exit(1)
    }

    // Refresh under the same cluster-wide lock as the proxy: Anthropic revokes a refresh
    // token presented twice, so a refresh racing a proxy task would kill the account
    console.log('\nRefreshing OAuth token...')
    const startTime = Date.now()

    try {
      await refreshAccessToken(pool, credential.id, { force: forceRefresh })

      const refreshed = await getCredentialByAccountId(pool, accountId)
      const newExpiresAt = refreshed?.oauth_expires_at ? new Date(refreshed.oauth_expires_at) : null
      const rotated = refreshed?.oauth_refresh_token !== credential.oauth_refresh_token

      console.log(
        rotated
          ? `\n✅ Token refreshed successfully in ${Date.now() - startTime}ms`
          : '\n✅ Another proxy instance had already refreshed this token'
      )
      console.log(`- Expires At: ${newExpiresAt ? newExpiresAt.toISOString() : 'unknown'}`)

      if (newExpiresAt) {
        const expiresIn = newExpiresAt.getTime() - Date.now()
        const hours = Math.floor(expiresIn / (1000 * 60 * 60))
        const minutes = Math.floor((expiresIn % (1000 * 60 * 60)) / (1000 * 60))
        console.log(`- Valid For: ${hours}h ${minutes}m`)
      }

      console.log(`\nCredential updated in database: ${accountId}`)
    } catch (error) {
      console.error(
        '\n❌ Failed to refresh token:',
        error instanceof Error ? error.message : String(error)
      )

      if (error instanceof OAuthRefreshError) {
        if (error.isRefreshTokenRejected) {
          console.error('\nThe refresh token is invalid or has been revoked.')
          console.error('You need to re-authenticate to get new credentials.')
          console.error(`\nRun: bun run auth:oauth-relogin --account ${credential.account_id}`)
        } else {
          console.error(`\nHTTP Status: ${error.status}`)
          console.error(`Error Code: ${error.errorCode || 'unknown'}`)
          console.error(`Description: ${error.description || 'No description provided'}`)
        }
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

refreshOAuthCredential()
