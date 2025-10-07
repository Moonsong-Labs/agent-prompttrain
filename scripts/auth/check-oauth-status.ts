#!/usr/bin/env bun
import { Pool } from 'pg'
import { getCredential } from '../../packages/shared/src/database/queries/index.js'

async function checkOAuthStatus() {
  const credentialId = process.argv[2]

  if (!credentialId) {
    console.error('Usage: bun run scripts/auth/check-oauth-status.ts <credential-id>')
    console.error('Example: bun run scripts/auth/check-oauth-status.ts acc_team_alpha')
    process.exit(1)
  }

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })

  try {
    const credential = await getCredential(pool, credentialId)

    if (!credential) {
      console.error(`Credential not found: ${credentialId}`)
      process.exit(1)
    }

    console.log(`Credential ID: ${credential.account_id}`)
    console.log(`Account Name: ${credential.account_name}`)
    console.log(`Created At: ${credential.created_at}`)

    const now = new Date()
    const expiresAt = credential.oauth_expires_at
    const isExpired = expiresAt ? now >= expiresAt : true
    const expiresIn = expiresAt ? Math.max(0, expiresAt.getTime() - now.getTime()) : 0

    console.log('\nOAuth Details:')
    console.log(
      `- Access Token: ${credential.oauth_access_token ? credential.oauth_access_token.substring(0, 20) + '...' : 'missing'}`
    )
    console.log(
      `- Refresh Token: ${credential.oauth_refresh_token ? credential.oauth_refresh_token.substring(0, 20) + '...' : 'missing'}`
    )
    console.log(`- Expires At: ${expiresAt ? expiresAt.toISOString() : 'unknown'}`)
    console.log(`- Status: ${isExpired ? 'EXPIRED' : 'Valid'}`)

    if (!isExpired && expiresAt) {
      const hours = Math.floor(expiresIn / (1000 * 60 * 60))
      const minutes = Math.floor((expiresIn % (1000 * 60 * 60)) / (1000 * 60))
      console.log(`- Expires In: ${hours}h ${minutes}m`)
    } else if (isExpired && expiresAt) {
      console.log(
        `- Expired: ${Math.floor((now.getTime() - expiresAt.getTime()) / (1000 * 60 * 60))} hours ago`
      )
    }

    console.log(
      `- Scopes: ${credential.oauth_scopes ? credential.oauth_scopes.join(', ') : 'none'}`
    )
    console.log(`- Is Max: ${credential.oauth_is_max}`)

    if (!credential.oauth_refresh_token) {
      console.warn(
        '\nWARNING: No refresh token available. Re-authentication will be required when access token expires.'
      )
    }

    if (isExpired && credential.oauth_refresh_token) {
      console.log(
        '\nToken is expired but has refresh token. The proxy should automatically refresh it.'
      )
      console.log('Or manually refresh with: bun run scripts/auth/oauth-refresh.ts ' + credentialId)
    } else if (isExpired && !credential.oauth_refresh_token) {
      console.error(
        '\nERROR: Token is expired and no refresh token available. Re-authentication required!'
      )
      console.log('Run: bun run scripts/auth/oauth-login.ts')
    }
  } catch (error) {
    console.error('Error checking OAuth status:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

checkOAuthStatus()
