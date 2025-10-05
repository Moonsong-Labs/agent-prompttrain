#!/usr/bin/env bun
import { Pool } from 'pg'
import { CredentialsRepository } from '../../packages/shared/src/database/credentials-repository'
import { randomBytes, createHash } from 'crypto'
import { question } from 'readline-sync'

const DEFAULT_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

const OAUTH_CONFIG = {
  clientId: process.env.CLAUDE_OAUTH_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID,
  authorizationUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  scopes: ['org:create_api_key', 'user:profile', 'user:inference'],
  betaHeader: 'oauth-2025-04-20',
}

// PKCE helpers
function base64URLEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function generateCodeVerifier(): string {
  return base64URLEncode(randomBytes(32))
}

function generateCodeChallenge(verifier: string): string {
  return base64URLEncode(createHash('sha256').update(verifier).digest())
}

function generateAuthorizationUrl() {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)

  const params = new URLSearchParams({
    client_id: OAUTH_CONFIG.clientId,
    redirect_uri: OAUTH_CONFIG.redirectUri,
    response_type: 'code',
    scope: OAUTH_CONFIG.scopes.join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })

  return {
    url: `${OAUTH_CONFIG.authorizationUrl}?${params.toString()}`,
    verifier: codeVerifier,
  }
}

async function exchangeCodeForTokens(code: string, verifier: string) {
  const response = await fetch(OAUTH_CONFIG.tokenUrl, {
    headers: {
      'Content-Type': 'application/json',
      'anthropic-beta': OAUTH_CONFIG.betaHeader,
    },
    method: 'POST',
    body: JSON.stringify({
      client_id: OAUTH_CONFIG.clientId,
      redirect_uri: OAUTH_CONFIG.redirectUri,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to exchange authorization code: ${response.status} ${errorText}`)
  }

  const payload = (await response.json()) as any
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
    scopes: payload.scope ? payload.scope.split(' ') : OAUTH_CONFIG.scopes,
    isMax: payload.is_max || true,
  }
}

async function main() {
  const accountName = process.argv[2]

  if (!accountName) {
    console.error('Usage: bun run scripts/auth/oauth-login.ts <account-name>')
    console.error('Example: bun run scripts/auth/oauth-login.ts my-oauth-account')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const repo = new CredentialsRepository(pool)

  try {
    console.log(`Starting OAuth login for account: ${accountName}`)
    console.log('You will need to:')
    console.log('1. Visit the authorization URL in your browser')
    console.log('2. Log in to Claude and authorize the application')
    console.log('3. Copy the authorization code (contains a # character)')
    console.log('4. Paste the code here when prompted\n')

    // Generate authorization URL
    const { url, verifier } = generateAuthorizationUrl()

    console.log('Please visit the following URL to authorize:')
    console.log(`\n${url}\n`)

    const authCode = question('Enter the authorization code: ')

    if (!authCode || authCode.trim().length === 0) {
      console.error('No authorization code provided')
      process.exit(1)
    }

    console.log('\nExchanging code for tokens...')
    const oauth = await exchangeCodeForTokens(authCode.trim(), verifier)

    console.log('OAuth token obtained successfully!')

    // Create account in database
    console.log('\nCreating account in database...')
    const accountId = await repo.createAccount({
      accountName,
      credentialType: 'oauth',
      oauthAccessToken: oauth.accessToken,
      oauthRefreshToken: oauth.refreshToken,
      oauthExpiresAt: oauth.expiresAt,
      oauthScopes: oauth.scopes,
      oauthIsMax: oauth.isMax,
    })

    console.log('\nOAuth login successful!')
    console.log(`Account ID: ${accountId}`)
    console.log(`Account Name: ${accountName}`)
    console.log(`Expires At: ${new Date(oauth.expiresAt).toISOString()}`)
    console.log(`Scopes: ${oauth.scopes.join(', ')}`)
    console.log(`Is Max: ${oauth.isMax}`)
    console.log('\nThe account has been saved to the database.')
    console.log('You can now use this account ID in your train configurations.')
  } catch (error) {
    console.error('OAuth login failed:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
