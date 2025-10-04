#!/usr/bin/env bun
import { loadCredentials } from '../../services/proxy/src/credentials'
import { resolve } from 'path'

async function checkOAuthStatus() {
  const credentialPath = process.argv[2]

  if (!credentialPath) {
    console.error('Usage: bun run scripts/check-oauth-status.ts <credential-path>')
    console.error(
      'Example: bun run scripts/check-oauth-status.ts credentials/example.com.credentials.json'
    )
    process.exit(1)
  }

  try {
    const fullPath = resolve(credentialPath)
    const credentials = loadCredentials(fullPath)

    if (!credentials) {
      console.error(`No credentials found at: ${fullPath}`)
      process.exit(1)
    }

    console.log(`Credential file: ${fullPath}`)
    console.log(`Type: ${credentials.type}`)

    if (credentials.type === 'oauth' && credentials.oauth) {
      const oauth = credentials.oauth
      const now = Date.now()
      const expiresAt = oauth.expiresAt || 0
      const isExpired = now >= expiresAt
      const expiresIn = Math.max(0, expiresAt - now)

      console.log('\nOAuth Details:')
      console.log(
        `- Access Token: ${oauth.accessToken ? oauth.accessToken.substring(0, 20) + '...' : 'missing'}`
      )
      console.log(
        `- Refresh Token: ${oauth.refreshToken ? oauth.refreshToken.substring(0, 20) + '...' : 'missing'}`
      )
      console.log(`- Expires At: ${expiresAt ? new Date(expiresAt).toISOString() : 'unknown'}`)
      console.log(`- Status: ${isExpired ? 'EXPIRED' : 'Valid'}`)

      if (!isExpired) {
        const hours = Math.floor(expiresIn / (1000 * 60 * 60))
        const minutes = Math.floor((expiresIn % (1000 * 60 * 60)) / (1000 * 60))
        console.log(`- Expires In: ${hours}h ${minutes}m`)
      } else {
        console.log(`- Expired: ${Math.floor((now - expiresAt) / (1000 * 60 * 60))} hours ago`)
      }

      console.log(`- Scopes: ${oauth.scopes ? oauth.scopes.join(', ') : 'none'}`)
      console.log(`- Is Max: ${oauth.isMax}`)

      if (!oauth.refreshToken) {
        console.warn(
          '\nWARNING: No refresh token available. Re-authentication will be required when access token expires.'
        )
      }

      if (isExpired && oauth.refreshToken) {
        console.log(
          '\nToken is expired but has refresh token. The proxy should automatically refresh it.'
        )
      } else if (isExpired && !oauth.refreshToken) {
        console.error(
          '\nERROR: Token is expired and no refresh token available. Re-authentication required!'
        )
        console.log(`Run: bun run scripts/auth/oauth-login.ts ${credentialPath}`)
      }
    } else if (credentials.type === 'api_key') {
      console.log(
        `\nAPI Key: ${credentials.api_key ? credentials.api_key.substring(0, 20) + '...' : 'missing'}`
      )
    }

    if (credentials.client_api_key) {
      console.log(
        `\nClient API Key (for proxy auth): ${credentials.client_api_key.substring(0, 20)}...`
      )
    }

    if (credentials.slack) {
      console.log('\nSlack integration: configured')
    }
  } catch (error) {
    console.error('Error checking OAuth status:', error)
    process.exit(1)
  }
}

checkOAuthStatus()
