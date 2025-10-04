#!/usr/bin/env bun
import { loadCredentials, refreshToken } from '../../services/proxy/src/credentials'
import { resolve, dirname } from 'path'
import { writeFileSync, mkdirSync, readFileSync } from 'fs'

async function refreshOAuthToken() {
  const credentialPath = process.argv[2]
  const forceRefresh = process.argv[3] === '--force'

  if (!credentialPath) {
    console.error('Usage: bun run scripts/oauth-refresh.ts <credential-path> [--force]')
    console.error(
      'Example: bun run scripts/oauth-refresh.ts credentials/example.com.credentials.json'
    )
    console.error('\nOptions:')
    console.error('  --force    Force refresh even if token is not expired')
    process.exit(1)
  }

  try {
    const fullPath = resolve(credentialPath)
    console.log(`Loading credentials from: ${fullPath}`)

    // Load the credentials
    const credentials = loadCredentials(fullPath)

    if (!credentials) {
      console.error(`Failed to load credentials from: ${fullPath}`)
      process.exit(1)
    }

    if (credentials.type !== 'oauth' || !credentials.oauth) {
      console.error('This script only works with OAuth credentials')
      console.error(`Found credential type: ${credentials.type}`)
      process.exit(1)
    }

    const oauth = credentials.oauth
    const now = Date.now()
    const expiresAt = oauth.expiresAt || 0
    const isExpired = now >= expiresAt
    const willExpireSoon = now >= expiresAt - 60000 // 1 minute before expiry

    console.log('\nCurrent OAuth status:')
    console.log(
      `- Access Token: ${oauth.accessToken ? oauth.accessToken.substring(0, 20) + '...' : 'missing'}`
    )
    console.log(
      `- Refresh Token: ${oauth.refreshToken ? oauth.refreshToken.substring(0, 20) + '...' : 'missing'}`
    )
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

    if (!oauth.refreshToken) {
      console.error('\nERROR: No refresh token available. Re-authentication required.')
      console.error(`Run: bun run scripts/auth/oauth-login.ts ${credentialPath}`)
      process.exit(1)
    }

    // Perform the refresh
    console.log('\nRefreshing OAuth token...')
    const startTime = Date.now()

    try {
      const newOAuth = await refreshToken(oauth.refreshToken)

      // Update credentials with new OAuth data
      credentials.oauth = newOAuth

      // Load existing file to preserve non-OAuth fields
      let existingData: any = {}
      try {
        const content = readFileSync(fullPath, 'utf-8')
        existingData = JSON.parse(content)
      } catch (err) {
        // If we can't read existing data, we'll just save the new data
      }

      // Merge the OAuth data with existing data, preserving other fields
      const mergedCredentials = {
        ...existingData,
        ...credentials,
        // Explicitly preserve fields that might exist
        client_api_key: existingData.client_api_key,
        slack: existingData.slack,
      }

      // Save updated credentials
      mkdirSync(dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, JSON.stringify(mergedCredentials, null, 2))

      const refreshTime = Date.now() - startTime

      console.log(`\n✅ Token refreshed successfully in ${refreshTime}ms`)
      console.log('\nNew OAuth status:')
      console.log(`- Access Token: ${newOAuth.accessToken.substring(0, 20)}...`)
      console.log(
        `- Refresh Token: ${newOAuth.refreshToken ? newOAuth.refreshToken.substring(0, 20) + '...' : 'reused existing'}`
      )
      console.log(`- Expires At: ${new Date(newOAuth.expiresAt).toISOString()}`)
      console.log(`- Scopes: ${newOAuth.scopes.join(', ')}`)
      console.log(`- Is Max: ${newOAuth.isMax}`)

      const expiresIn = newOAuth.expiresAt - Date.now()
      const hours = Math.floor(expiresIn / (1000 * 60 * 60))
      const minutes = Math.floor((expiresIn % (1000 * 60 * 60)) / (1000 * 60))
      console.log(`- Valid For: ${hours}h ${minutes}m`)

      console.log(`\nCredentials saved to: ${fullPath}`)
    } catch (error: any) {
      console.error('\n❌ Failed to refresh token:', error.message)

      if (error.errorCode === 'invalid_grant' || error.status === 400) {
        console.error('\nThe refresh token is invalid or has been revoked.')
        console.error('You need to re-authenticate to get new credentials.')
        console.error(`\nRun: bun run scripts/oauth-login.ts ${credentialPath}`)
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
  }
}

refreshOAuthToken()
