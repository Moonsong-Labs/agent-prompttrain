#!/usr/bin/env bun

/**
 * Replay a test sample JSON file against the Anthropic API.
 *
 * Reads a collected test sample, fetches an OAuth credential from the database,
 * refreshes the token if needed, and sends the request to api.anthropic.com.
 *
 * Usage:
 *   bun run scripts/replay-sample.ts <sample.json> [--account <name>] [--stream] [--dry-run]
 *
 * Arguments:
 *   sample.json         Path to the test sample JSON file
 *
 * Options:
 *   --account <name>    Use a specific account by name (default: first available Anthropic credential)
 *   --via-proxy <url>   Send through a running proxy instance instead of directly to Anthropic
 *                       (e.g. --via-proxy http://localhost:3000). Auth is handled by the proxy.
 *   --stream            Force streaming mode (overrides sample setting)
 *   --no-stream         Force non-streaming mode
 *   --dry-run           Print the request that would be sent without executing it
 *
 * Environment:
 *   DATABASE_URL        PostgreSQL connection string (loaded from .env)
 *   PROXY_API_URL       Default proxy URL when --via-proxy is used without a value
 */

import { promises as fs } from 'fs'
import { Pool } from 'pg'
import { config } from 'dotenv'

config()

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const OAUTH_BETA_HEADER = 'oauth-2025-04-20'
const DEFAULT_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const BILLING_HEADER = 'x-anthropic-billing-header: cc_version=replay; cc_entrypoint=cli;'

interface Credential {
  id: string
  account_id: string
  account_name: string
  provider: string
  oauth_access_token: string | null
  oauth_refresh_token: string | null
  oauth_expires_at: Date | null
}

interface TestSample {
  timestamp: string
  method: string
  path: string
  headers: Record<string, string>
  body: any
  queryParams: Record<string, string>
  metadata: {
    requestType: string
    isStreaming: boolean
    hasTools: boolean
    modelUsed: string
    messageCount: number
  }
  response?: any
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2)
  let samplePath: string | undefined
  let accountName: string | undefined
  let forceStream: boolean | undefined
  let dryRun = false
  let viaProxy: string | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--account' && args[i + 1]) {
      accountName = args[++i]
    } else if (args[i] === '--via-proxy') {
      // Next arg is the URL, or fall back to env
      if (args[i + 1] && !args[i + 1].startsWith('-')) {
        viaProxy = args[++i]
      } else {
        viaProxy = process.env.PROXY_API_URL || 'http://localhost:3000'
      }
    } else if (args[i] === '--stream') {
      forceStream = true
    } else if (args[i] === '--no-stream') {
      forceStream = false
    } else if (args[i] === '--dry-run') {
      dryRun = true
    } else if (!args[i].startsWith('-')) {
      samplePath = args[i]
    }
  }

  return { samplePath, accountName, forceStream, dryRun, viaProxy }
}

async function getCredential(pool: Pool, accountName?: string): Promise<Credential> {
  let result
  if (accountName) {
    result = await pool.query<Credential>(
      `SELECT * FROM credentials WHERE provider = 'anthropic' AND account_name = $1`,
      [accountName]
    )
    if (result.rows.length === 0) {
      throw new Error(`No Anthropic credential found with account name: ${accountName}`)
    }
  } else {
    result = await pool.query<Credential>(
      `SELECT * FROM credentials WHERE provider = 'anthropic' ORDER BY updated_at DESC LIMIT 1`
    )
    if (result.rows.length === 0) {
      throw new Error('No Anthropic credentials found in the database')
    }
  }
  return result.rows[0]
}

async function ensureFreshToken(pool: Pool, credential: Credential): Promise<string> {
  const expiresAt = new Date(credential.oauth_expires_at || 0)

  if (Date.now() < expiresAt.getTime() - 60000) {
    return credential.oauth_access_token!
  }

  console.log('Token expired or expiring soon, refreshing...')

  const response = await fetch('https://console.anthropic.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-beta': OAUTH_BETA_HEADER,
    },
    body: JSON.stringify({
      client_id: process.env.CLAUDE_OAUTH_CLIENT_ID || DEFAULT_OAUTH_CLIENT_ID,
      refresh_token: credential.oauth_refresh_token,
      grant_type: 'refresh_token',
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Token refresh failed: ${response.status} - ${errorText}`)
  }

  const payload = (await response.json()) as any
  const newAccessToken = payload.access_token
  const newRefreshToken = payload.refresh_token || credential.oauth_refresh_token
  const newExpiresAt = new Date(Date.now() + payload.expires_in * 1000)

  await pool.query(
    `UPDATE credentials
     SET oauth_access_token = $2, oauth_refresh_token = $3, oauth_expires_at = $4,
         updated_at = NOW(), last_refresh_at = NOW()
     WHERE id = $1`,
    [credential.id, newAccessToken, newRefreshToken, newExpiresAt]
  )

  console.log('Token refreshed successfully.')
  return newAccessToken
}

function injectBillingHeader(body: any) {
  const hasBilling = (text: string) => text.includes('x-anthropic-billing-header')

  if (!body.system) {
    body.system = [{ type: 'text', text: BILLING_HEADER }]
  } else if (typeof body.system === 'string') {
    if (!hasBilling(body.system)) {
      body.system = [
        { type: 'text', text: BILLING_HEADER },
        { type: 'text', text: body.system },
      ]
    }
  } else if (Array.isArray(body.system)) {
    const alreadyHas = body.system.some((b: any) => b.type === 'text' && hasBilling(b.text))
    if (!alreadyHas) {
      body.system.unshift({ type: 'text', text: BILLING_HEADER })
    }
  }
}

async function replayRequest(
  sample: TestSample,
  accessToken: string | undefined,
  forceStream: boolean | undefined,
  dryRun: boolean,
  options?: { viaProxy?: string; accountId?: string; proxyApiKey?: string }
) {
  const body = { ...sample.body }

  if (forceStream !== undefined) {
    body.stream = forceStream
  }

  const isStreaming = body.stream ?? false

  let targetUrl: string
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': sample.headers['anthropic-version'] || ANTHROPIC_VERSION,
  }

  if (options?.viaProxy) {
    // Via proxy: authenticate with project API key, let proxy handle upstream auth
    targetUrl = `${options.viaProxy.replace(/\/$/, '')}/v1/messages`
    headers['Authorization'] = `Bearer ${options.proxyApiKey}`
    if (options.accountId) {
      headers['MSL-Account'] = options.accountId
    }
    // Forward beta headers from original sample (proxy merges its own OAuth beta)
    const originalBeta = sample.headers['anthropic-beta']
    if (originalBeta) {
      headers['anthropic-beta'] = originalBeta
    }
  } else {
    // Direct to Anthropic: use token as X-Api-Key
    targetUrl = ANTHROPIC_API_URL
    headers['X-Api-Key'] = accessToken!

    // Forward beta headers from original sample (without OAuth beta)
    const originalBeta = sample.headers['anthropic-beta']
    if (originalBeta) {
      headers['anthropic-beta'] = originalBeta
    }

    // Inject billing header into system prompt (required for OAuth tokens)
    injectBillingHeader(body)
  }

  // Forward user-agent from original sample if present
  if (sample.headers['user-agent']) {
    headers['user-agent'] = sample.headers['user-agent']
  }

  console.log(`\nRequest details:`)
  console.log(`  URL:     ${targetUrl}`)
  console.log(`  Model:   ${body.model}`)
  console.log(`  Stream:  ${isStreaming}`)
  console.log(`  Messages: ${body.messages?.length || 0}`)
  if (body.tools?.length) {
    console.log(`  Tools:   ${body.tools.length}`)
  }
  if (body.system) {
    console.log(`  System:  yes`)
  }

  if (dryRun) {
    console.log('\n--- DRY RUN ---')
    console.log('Headers:', JSON.stringify(headers, null, 2))
    console.log('Body:', JSON.stringify(body, null, 2))
    return
  }

  console.log(`\nSending request...`)
  const startTime = Date.now()

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  const elapsed = Date.now() - startTime
  console.log(`\nResponse: ${response.status} ${response.statusText} (${elapsed}ms)`)

  if (isStreaming && response.ok) {
    console.log('\n--- Streaming response ---')
    const reader = response.body?.getReader()
    if (!reader) {
      console.error('No response body reader available')
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6)
          if (data === '[DONE]') {
            console.log('\n[DONE]')
          } else {
            try {
              const event = JSON.parse(data)
              if (event.type === 'content_block_delta' && event.delta?.text) {
                process.stdout.write(event.delta.text)
              } else if (event.type === 'message_start') {
                console.log(`[message_start] model=${event.message?.model} id=${event.message?.id}`)
              } else if (event.type === 'message_delta') {
                const usage = event.usage
                if (usage) {
                  console.log(
                    `\n[message_delta] stop=${event.delta?.stop_reason} output_tokens=${usage.output_tokens}`
                  )
                }
              } else if (event.type === 'error') {
                console.error(`\n[error] ${JSON.stringify(event.error)}`)
              }
            } catch {
              // Non-JSON line, ignore
            }
          }
        }
      }
    }
  } else {
    const responseBody = await response.text()
    try {
      const json = JSON.parse(responseBody)
      console.log('\n--- Response body ---')
      console.log(JSON.stringify(json, null, 2))
    } catch {
      console.log('\n--- Response body (raw) ---')
      console.log(responseBody)
    }
  }
}

async function main() {
  const { samplePath, accountName, forceStream, dryRun, viaProxy } = parseArgs(process.argv)

  if (!samplePath) {
    console.error(
      'Usage: bun run scripts/replay-sample.ts <sample.json> [--account <name>] [--via-proxy [url]] [--stream] [--no-stream] [--dry-run]'
    )
    process.exit(1)
  }

  // Read sample file
  let sample: TestSample
  try {
    const content = await fs.readFile(samplePath, 'utf-8')
    sample = JSON.parse(content)
  } catch (error) {
    console.error(`Failed to read sample file: ${samplePath}`)
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }

  console.log(`Sample: ${samplePath}`)
  console.log(`  Captured:  ${sample.timestamp}`)
  console.log(`  Type:      ${sample.metadata.requestType}`)
  console.log(`  Model:     ${sample.metadata.modelUsed}`)
  console.log(`  Streaming: ${sample.metadata.isStreaming}`)
  console.log(`  Messages:  ${sample.metadata.messageCount}`)
  if (sample.response) {
    console.log(`  Original response: ${sample.response.status}`)
  } else {
    console.log(`  Original response: none (request failed before response)`)
  }

  if (viaProxy) {
    // Via proxy mode: need DB to get a project API key and resolve account
    if (!process.env.DATABASE_URL) {
      console.error('Error: DATABASE_URL is required to fetch proxy API key.')
      process.exit(1)
    }

    console.log(`\nRouting via proxy: ${viaProxy}`)

    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    try {
      // Get a valid project API key
      const keyResult = await pool.query<{ api_key: string; project_id: string }>(
        `SELECT api_key, project_id FROM project_api_keys WHERE revoked_at IS NULL LIMIT 1`
      )
      if (keyResult.rows.length === 0) {
        throw new Error('No active project API keys found in database')
      }
      const { api_key: proxyApiKey, project_id: projectId } = keyResult.rows[0]
      console.log(`  Project: ${projectId}`)

      // Resolve account_id from name if provided
      let accountId: string | undefined
      if (accountName) {
        const credential = await getCredential(pool, accountName)
        accountId = credential.account_id
        console.log(`  Account: ${credential.account_name} (${accountId})`)
      }

      await replayRequest(sample, undefined, forceStream, dryRun, {
        viaProxy,
        accountId,
        proxyApiKey,
      })
    } finally {
      await pool.end()
    }
  } else {
    // Direct mode: need DB for credential
    if (!process.env.DATABASE_URL) {
      console.error('Error: DATABASE_URL is not set. Ensure .env is configured.')
      process.exit(1)
    }

    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    try {
      const credential = await getCredential(pool, accountName)
      console.log(`\nUsing account: ${credential.account_name} (${credential.account_id})`)
      const accessToken = await ensureFreshToken(pool, credential)
      await replayRequest(sample, accessToken, forceStream, dryRun)
    } finally {
      await pool.end()
    }
  }
}

main().catch(error => {
  console.error('\nFatal error:', error instanceof Error ? error.message : error)
  process.exit(1)
})
