#!/usr/bin/env bun
import { Pool } from 'pg'
import { randomBytes, createHash } from 'crypto'
import { createCredential } from '../../packages/shared/src/database/queries/index.js'

const DEFAULT_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

const OAUTH_CONFIG = {
  clientId: process.env.CLAUDE_OAUTH_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID,
  authorizationUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  scopes: ['org:create_api_key', 'user:profile', 'user:inference'],
  betaHeader: 'oauth-2025-04-20',
}

function base64URLEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function generateCodeVerifier(): string {
  return base64URLEncode(randomBytes(32))
}

function generateCodeChallenge(verifier: string): string {
  return base64URLEncode(createHash('sha256').update(verifier).digest())
}

function generateAuthorizationUrl(): { url: string; verifier: string } {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)

  const authUrl = new URL(OAUTH_CONFIG.authorizationUrl)
  authUrl.searchParams.set('code', 'true')
  authUrl.searchParams.set('client_id', OAUTH_CONFIG.clientId)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('redirect_uri', OAUTH_CONFIG.redirectUri)
  authUrl.searchParams.set('scope', OAUTH_CONFIG.scopes.join(' '))
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', codeVerifier)

  return { url: authUrl.toString(), verifier: codeVerifier }
}

async function promptInput(question: string): Promise<string> {
  const readline = await import('readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function exchangeCodeForTokens(
  codeWithState: string,
  codeVerifier: string
): Promise<{
  accessToken: string
  refreshToken: string
  expiresAt: Date
  scopes: string[]
  isMax: boolean
}> {
  const [code, state] = codeWithState.split('#')

  if (!code || !state) {
    throw new Error('Invalid authorization code format. Expected format: code#state')
  }

  const response = await fetch(OAUTH_CONFIG.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-beta': OAUTH_CONFIG.betaHeader,
    },
    body: JSON.stringify({
      code,
      state,
      grant_type: 'authorization_code',
      client_id: OAUTH_CONFIG.clientId,
      redirect_uri: OAUTH_CONFIG.redirectUri,
      code_verifier: codeVerifier,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to exchange code: ${response.status} - ${errorText}`)
  }

  const data = (await response.json()) as any

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    scopes: data.scope ? data.scope.split(' ') : OAUTH_CONFIG.scopes,
    isMax: data.is_max || true,
  }
}

async function performOAuthLogin(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })

  try {
    console.log('Starting OAuth login flow...\n')

    // Get account details
    const accountId = await promptInput('Enter account ID (e.g., acc_team_alpha): ')
    const accountName = await promptInput('Enter account name (e.g., Team Alpha): ')

    if (!accountId || !accountName) {
      console.error('Account ID and name are required')
      process.exit(1)
    }

    // Generate authorization URL
    const { url, verifier } = generateAuthorizationUrl()

    console.log('\nPlease visit the following URL to authorize:')
    console.log(url)
    console.log('\nAfter authorizing, you will see an authorization code.')
    console.log('Copy the entire code (it should contain a # character).\n')

    const code = await promptInput('Enter the authorization code: ')

    console.log('Exchanging authorization code for tokens...')
    const tokens = await exchangeCodeForTokens(code, verifier)

    // Save to database
    console.log('Saving credentials to database...')
    const credential = await createCredential(pool, {
      account_id: accountId,
      account_name: accountName,
      oauth_access_token: tokens.accessToken,
      oauth_refresh_token: tokens.refreshToken,
      oauth_expires_at: tokens.expiresAt,
      oauth_scopes: tokens.scopes,
      oauth_is_max: tokens.isMax,
    })

    console.log(`\n✅ OAuth credentials saved successfully!`)
    console.log(`   Account ID: ${credential.account_id}`)
    console.log(`   Account Name: ${credential.account_name}`)
    console.log(`   Expires At: ${credential.oauth_expires_at}`)
    console.log('\nNext steps:')
    console.log('1. Create or update a project via the dashboard')
    console.log('2. Link this credential to the project')
    console.log('3. Generate API keys for the project')
  } catch (err) {
    console.error('OAuth login failed:', err)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

performOAuthLogin()
