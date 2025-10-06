#!/usr/bin/env bun
import { Pool } from 'pg'
import {
  getCredential,
  updateCredential,
} from '../../packages/shared/src/database/queries/index.js'
import { refreshOAuthToken } from '../../services/proxy/src/credentials/index.js'

async function refreshOAuthCredential() {
  const credentialId = process.argv[2]
  const forceRefresh = process.argv[3] === '--force'

  if (!credentialId) {
    console.error('Usage: bun run scripts/auth/oauth-refresh.ts <credential-id> [--force]')
    console.error('Example: bun run scripts/auth/oauth-refresh.ts acc_team_alpha')
    console.error('\nOptions:')
    console.error('  --force    Force refresh even if token is not expired')
    process.exit(1)
  }

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })

  try {
    console.log(`Loading credential: ${credentialId}`)

    // Load the credential from database
    const credential = await getCredential(pool, credentialId)

    if (!credential) {
      console.error(`Credential not found: ${credentialId}`)
      process.exit(1)
    }

    const now = new Date()
    const expiresAt = credential.oauth_expires_at
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
      console.error(`Run: bun run scripts/auth/oauth-login.ts`)
      process.exit(1)
    }

    // Perform the refresh
    console.log('\nRefreshing OAuth token...')
    const startTime = Date.now()

    try {
      const newTokens = await refreshOAuthToken(credential.oauth_refresh_token)

      // Update credential in database
      await updateCredential(pool, credentialId, {
        oauth_access_token: newTokens.accessToken,
        oauth_refresh_token: newTokens.refreshToken,
        oauth_expires_at: new Date(newTokens.expiresAt),
        oauth_scopes: newTokens.scopes,
        oauth_is_max: newTokens.isMax,
      })

      const refreshTime = Date.now() - startTime

      console.log(`\n✅ Token refreshed successfully in ${refreshTime}ms`)
      console.log('\nNew OAuth status:')
      console.log(`- Access Token: ${newTokens.accessToken.substring(0, 20)}...`)
      console.log(
        `- Refresh Token: ${newTokens.refreshToken ? newTokens.refreshToken.substring(0, 20) + '...' : 'reused existing'}`
      )
      console.log(`- Expires At: ${new Date(newTokens.expiresAt).toISOString()}`)
      console.log(`- Scopes: ${newTokens.scopes.join(', ')}`)
      console.log(`- Is Max: ${newTokens.isMax}`)

      const expiresIn = newTokens.expiresAt - Date.now()
      const hours = Math.floor(expiresIn / (1000 * 60 * 60))
      const minutes = Math.floor((expiresIn % (1000 * 60 * 60)) / (1000 * 60))
      console.log(`- Valid For: ${hours}h ${minutes}m`)

      console.log(`\nCredential updated in database: ${credentialId}`)
    } catch (error: any) {
      console.error('\n❌ Failed to refresh token:', error.message)

      if (error.errorCode === 'invalid_grant' || error.status === 400) {
        console.error('\nThe refresh token is invalid or has been revoked.')
        console.error('You need to re-authenticate to get new credentials.')
        console.error(`\nRun: bun run scripts/auth/oauth-login.ts`)
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

refreshOAuthCredential()
