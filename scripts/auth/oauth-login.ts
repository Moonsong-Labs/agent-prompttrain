#!/usr/bin/env bun
import { Pool } from 'pg'
import { randomBytes, createHash } from 'crypto'
import {
  getCredentialByAccountId,
  upsertAnthropicCredential,
} from '../../packages/shared/src/database/queries/index.js'
import {
  copyTextToClipboard,
  openPrivateBrowser,
  readTextFromClipboard,
  validateAuthorizationCode,
} from './oauth-browser.ts'

const DEFAULT_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

const OAUTH_CONFIG = {
  clientId: process.env.CLAUDE_OAUTH_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID,
  authorizationUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  scopes: ['org:create_api_key', 'user:profile', 'user:inference'],
  betaHeader: 'oauth-2025-04-20',
}

export interface OAuthFlowOptions {
  openBrowser: boolean
  useClipboard: boolean
  gmailAssisted: boolean
}

export interface OAuthLoginCliOptions extends OAuthFlowOptions {
  help: boolean
}

export function parseOAuthLoginOptions(args: string[]): OAuthLoginCliOptions {
  const options: OAuthLoginCliOptions = {
    openBrowser: true,
    useClipboard: true,
    gmailAssisted: false,
    help: false,
  }

  for (const arg of args) {
    if (arg === '--no-browser') {
      options.openBrowser = false
    } else if (arg === '--no-clipboard') {
      options.useClipboard = false
    } else if (arg === '--gmail') {
      options.gmailAssisted = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }

  return options
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

export function generateAuthorizationUrl(): { url: string; verifier: string } {
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

export async function promptInput(question: string): Promise<string> {
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

export async function exchangeCodeForTokens(
  codeWithState: string,
  codeVerifier: string
): Promise<{
  accessToken: string
  refreshToken: string
  expiresAt: Date
  scopes: string[]
  isMax: boolean
}> {
  const [code, state] = validateAuthorizationCode(codeWithState, codeVerifier).split('#')

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
    isMax: data.is_max ?? true,
  }
}

export async function authorizeOAuthCredential(
  accountEmail: string | null | undefined,
  options: OAuthFlowOptions
): ReturnType<typeof exchangeCodeForTokens> {
  const { url, verifier } = generateAuthorizationUrl()

  if (options.gmailAssisted) {
    if (!accountEmail) {
      throw new Error('Gmail-assisted relogin requires a stored credential email.')
    }
    if (!options.openBrowser) {
      throw new Error('Gmail-assisted relogin requires the controlled browser.')
    }

    const [{ createGmailClient, waitForAnthropicLoginLink }, { launchControlledOAuthBrowser }] =
      await Promise.all([import('./gmail-auth.ts'), import('./oauth-controlled-browser.ts')])
    const gmail = await createGmailClient()
    const browser = await launchControlledOAuthBrowser()

    try {
      console.log(`\nOpening an isolated browser for ${accountEmail}.`)
      await browser.openAuthorization(url)

      const requestedAfter = Date.now()
      const emailSubmitted = await browser.submitAccountEmail(accountEmail)
      if (emailSubmitted) {
        console.log('Submitted the stored credential email. Waiting for Gmail...')
      } else {
        console.log(`Enter ${accountEmail} in the controlled browser and request the login email.`)
        console.log('Waiting for Gmail while you complete that step...')
      }

      const configuredTimeout = Number(process.env.GMAIL_AUTH_POLL_TIMEOUT_MS)
      const loginLink = await waitForAnthropicLoginLink(gmail, {
        accountEmail,
        requestedAfter,
        timeoutMs:
          Number.isFinite(configuredTimeout) && configuredTimeout > 0
            ? configuredTimeout
            : undefined,
      })

      console.log('Received and validated a fresh Anthropic login email.')
      await browser.openLoginLink(loginLink.url)
      console.log('Review the Anthropic request and click Authorize in the browser.')
      const authorizationCode = await browser.waitForAuthorizationCode(verifier)
      console.log('Authorization approved. Exchanging the code...')
      return exchangeCodeForTokens(authorizationCode, verifier)
    } finally {
      await browser.close()
    }
  }

  if (accountEmail) {
    console.log(`\nSign in with: ${accountEmail}`)
    if (options.useClipboard) {
      const copied = await copyTextToClipboard(accountEmail)
      console.log(
        copied
          ? 'Credential email copied to the clipboard.'
          : 'Clipboard integration unavailable; copy the email shown above.'
      )
    }
  }

  const browserOpened = options.openBrowser ? await openPrivateBrowser(url) : false
  if (browserOpened) {
    console.log('Opened a private browser window for authorization.')
  } else if (options.openBrowser) {
    console.log('Private browser launch unavailable; open the URL below manually.')
  }

  console.log('\nAuthorization URL (manual fallback):')
  console.log(url)
  console.log('\nComplete Anthropic email verification and approve access.')
  console.log('Copy the complete authorization code (it must contain #).')

  const input = await promptInput(
    'Authorization code (paste it, or press Enter to read the clipboard): '
  )
  const clipboardValue = !input && options.useClipboard ? readTextFromClipboard() : null
  if (!input && clipboardValue) {
    console.log('Read authorization code from the clipboard.')
  }

  return exchangeCodeForTokens(validateAuthorizationCode(input || clipboardValue || ''), verifier)
}

export async function performOAuthLogin(options: OAuthFlowOptions): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exitCode = 1
    return
  }

  const pool = new Pool({ connectionString: databaseUrl })

  try {
    console.log('Starting OAuth login flow...\n')

    const accountId = await promptInput('Enter account ID (e.g., acc_team_alpha): ')
    if (!accountId) {
      console.error('Account ID is required')
      process.exitCode = 1
      return
    }

    const existing = await getCredentialByAccountId(pool, accountId)
    if (existing && existing.provider !== 'anthropic') {
      console.error(`Account ID ${accountId} already exists for provider ${existing.provider}`)
      process.exitCode = 1
      return
    }

    const existingAnthropic = existing?.provider === 'anthropic' ? existing : null
    const accountNamePrompt = existingAnthropic
      ? `Enter account name [${existingAnthropic.account_name}]: `
      : 'Enter account name (e.g., Team Alpha): '
    const accountNameInput = await promptInput(accountNamePrompt)
    const accountName = accountNameInput || existingAnthropic?.account_name || ''

    const accountEmailPrompt = existingAnthropic?.account_email
      ? `Enter credential email [${existingAnthropic.account_email}]: `
      : 'Enter credential email (optional, used by relogin scripts only): '
    const accountEmailInput = await promptInput(accountEmailPrompt)
    const accountEmail = accountEmailInput || existingAnthropic?.account_email || null

    if (!accountName) {
      console.error('Account name is required')
      process.exitCode = 1
      return
    }

    const tokens = await authorizeOAuthCredential(accountEmail, options)

    // Save to database
    console.log('\nSaving credentials to database...')
    const credential = await upsertAnthropicCredential(pool, {
      account_id: accountId,
      account_name: accountName,
      account_email: accountEmail,
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
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

if (import.meta.main) {
  try {
    const options = parseOAuthLoginOptions(process.argv.slice(2))
    if (options.help) {
      console.log(
        'Usage: bun run scripts/auth/oauth-login.ts [--gmail] [--no-browser] [--no-clipboard]'
      )
    } else {
      await performOAuthLogin(options)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
