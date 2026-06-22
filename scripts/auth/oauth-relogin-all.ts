#!/usr/bin/env bun
import { Pool } from 'pg'
import {
  listAnthropicCredentials,
  upsertAnthropicCredential,
} from '../../packages/shared/src/database/queries/index.js'
import { exchangeCodeForTokens, generateAuthorizationUrl, promptInput } from './oauth-login.ts'

type ReloginResult = {
  accountId: string
  status: 'updated' | 'skipped' | 'failed'
  error?: string
}

async function reloginAllOAuthCredentials(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })
  const results: ReloginResult[] = []

  try {
    console.log('OAuth Relogin All Tool')
    console.log('======================\n')

    const credentials = await listAnthropicCredentials(pool)

    if (credentials.length === 0) {
      console.log('No Anthropic OAuth credentials found in database.')
      process.exit(0)
    }

    console.log(`Found ${credentials.length} Anthropic OAuth credentials.`)
    console.log('Each account will be reauthorized and overwritten in place.\n')

    for (const [index, credential] of credentials.entries()) {
      const email = credential.account_email || '(email not stored)'

      console.log(`\n[${index + 1}/${credentials.length}] ${credential.account_id}`)
      console.log(`  Account Name: ${credential.account_name}`)
      console.log(`  Email to use: ${email}`)

      if (!credential.account_email) {
        console.log(
          '  Note: Store the email next time with scripts/auth/oauth-login.ts to make this explicit.'
        )
      }

      const action = await promptInput('Press Enter to relogin, "s" to skip, or "q" to quit: ')
      const normalizedAction = action.toLowerCase()

      if (normalizedAction === 'q') {
        break
      }

      if (normalizedAction === 's') {
        results.push({ accountId: credential.account_id, status: 'skipped' })
        continue
      }

      const { url, verifier } = generateAuthorizationUrl()

      console.log('\nPlease visit the following URL to authorize:')
      console.log(url)
      console.log(`\nSign in with: ${email}`)
      console.log('After authorizing, copy the entire code (it should contain a # character).\n')

      try {
        const code = await promptInput('Enter the authorization code: ')

        console.log('Exchanging authorization code for tokens...')
        const tokens = await exchangeCodeForTokens(code, verifier)

        await upsertAnthropicCredential(pool, {
          account_id: credential.account_id,
          account_name: credential.account_name,
          account_email: credential.account_email,
          oauth_access_token: tokens.accessToken,
          oauth_refresh_token: tokens.refreshToken,
          oauth_expires_at: tokens.expiresAt,
          oauth_scopes: tokens.scopes,
          oauth_is_max: tokens.isMax,
        })

        console.log(
          `✅ Updated ${credential.account_id}; expires at ${tokens.expiresAt.toISOString()}`
        )
        results.push({ accountId: credential.account_id, status: 'updated' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`❌ Failed to relogin ${credential.account_id}: ${message}`)
        results.push({ accountId: credential.account_id, status: 'failed', error: message })
      }
    }

    const updated = results.filter(result => result.status === 'updated').length
    const skipped = results.filter(result => result.status === 'skipped').length
    const failed = results.filter(result => result.status === 'failed')

    console.log('\nSummary')
    console.log('=======')
    console.log(`Updated: ${updated}`)
    console.log(`Skipped: ${skipped}`)
    console.log(`Failed: ${failed.length}`)

    if (failed.length > 0) {
      console.log('\nFailures:')
      for (const result of failed) {
        console.log(`- ${result.accountId}: ${result.error}`)
      }
    }

    process.exit(failed.length > 0 ? 1 : 0)
  } catch (error) {
    console.error('Error:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

if (import.meta.main) {
  reloginAllOAuthCredentials()
}
