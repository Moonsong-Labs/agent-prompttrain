#!/usr/bin/env bun
import { createHash } from 'crypto'
import { Pool } from 'pg'
import { getCredentialByAccountId } from '../../packages/shared/src/database/queries/index.js'

const USAGE = 'Usage: bun run auth:oauth-status <account-id>'

async function checkOAuthStatus() {
  const accountId = process.argv[2]

  if (accountId === '--help' || accountId === '-h') {
    console.log(USAGE)
    console.log('Example: bun run auth:oauth-status acc_team_alpha')
    process.exit(0)
  }

  if (!accountId) {
    console.error(USAGE)
    console.error('Example: bun run auth:oauth-status acc_team_alpha')
    process.exit(1)
  }

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })

  try {
    const credential = await getCredentialByAccountId(pool, accountId)

    if (!credential) {
      console.error(`Credential not found: ${accountId}`)
      process.exit(1)
    }

    if (credential.provider !== 'anthropic') {
      console.error(`${accountId} is a ${credential.provider} credential, not Anthropic OAuth`)
      process.exit(1)
    }

    console.log(`Credential ID: ${credential.account_id}`)
    console.log(`Account Name: ${credential.account_name}`)
    console.log(`Created At: ${credential.created_at}`)

    const now = new Date()
    const expiresAt = credential.oauth_expires_at ? new Date(credential.oauth_expires_at) : null
    const isExpired = expiresAt ? now >= expiresAt : true
    const expiresIn = expiresAt ? Math.max(0, expiresAt.getTime() - now.getTime()) : 0
    // The proxy stores the SHA-256 of a refresh token Anthropic answered invalid_grant for
    const refreshTokenRejected =
      !!credential.oauth_refresh_token &&
      credential.oauth_refresh_rejected_token_hash ===
        createHash('sha256').update(credential.oauth_refresh_token, 'utf8').digest('hex')

    console.log('\nOAuth Details:')
    console.log(
      `- Access Token: ${credential.oauth_access_token ? credential.oauth_access_token.substring(0, 20) + '...' : 'missing'}`
    )
    console.log(
      `- Refresh Token: ${credential.oauth_refresh_token ? credential.oauth_refresh_token.substring(0, 20) + '...' : 'missing'}${refreshTokenRejected ? ' (REJECTED by Anthropic)' : ''}`
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

    if (refreshTokenRejected) {
      console.error(
        '\nERROR: Anthropic rejected the refresh token, so the access token cannot be refreshed.'
      )
      console.log(`Run: bun run auth:oauth-relogin --account ${credential.account_id}`)
    } else if (!credential.oauth_refresh_token) {
      console.warn(
        '\nWARNING: No refresh token available. Re-authentication will be required when access token expires.'
      )
      if (isExpired) {
        console.log(`Run: bun run auth:oauth-relogin --account ${credential.account_id}`)
      }
    } else if (isExpired) {
      console.log(
        '\nToken is expired but has refresh token. The proxy refreshes it on the next request.'
      )
      console.log(
        `Or refresh it now with: bun run scripts/auth/oauth-refresh.ts ${credential.account_id}`
      )
    }
  } catch (error) {
    console.error('Error checking OAuth status:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

checkOAuthStatus()
