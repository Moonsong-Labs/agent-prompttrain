#!/usr/bin/env bun
import { Pool } from 'pg'
import {
  listAnthropicCredentials,
  upsertAnthropicCredential,
} from '../../packages/shared/src/database/queries/index.js'
import { authorizeOAuthCredential, promptInput, type OAuthFlowOptions } from './oauth-login.ts'

type ReloginResult = {
  accountId: string
  status: 'updated' | 'skipped' | 'failed'
  error?: string
}

export interface ReloginCliOptions extends OAuthFlowOptions {
  accountId?: string
  help: boolean
}

export function parseReloginOptions(args: string[]): ReloginCliOptions {
  const options: ReloginCliOptions = {
    openBrowser: true,
    useClipboard: true,
    gmailAssisted: false,
    help: false,
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--account') {
      const accountId = args[++index]
      if (!accountId) {
        throw new Error('--account requires an account ID')
      }
      options.accountId = accountId
    } else if (arg.startsWith('--account=')) {
      const accountId = arg.slice('--account='.length)
      if (!accountId) {
        throw new Error('--account requires an account ID')
      }
      options.accountId = accountId
    } else if (arg === '--no-browser') {
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

  if (options.gmailAssisted && !options.openBrowser) {
    throw new Error('--gmail cannot be combined with --no-browser')
  }

  return options
}

export async function reloginAllOAuthCredentials(options: ReloginCliOptions): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    return 1
  }

  const pool = new Pool({ connectionString: databaseUrl })
  const results: ReloginResult[] = []

  try {
    console.log('OAuth Relogin All Tool')
    console.log('======================\n')

    const credentials = await listAnthropicCredentials(pool)
    const selectedCredentials = options.accountId
      ? credentials.filter(credential => credential.account_id === options.accountId)
      : credentials

    if (selectedCredentials.length === 0) {
      console.error(
        options.accountId
          ? `Anthropic credential not found: ${options.accountId}`
          : 'No Anthropic OAuth credentials found in database.'
      )
      return options.accountId ? 1 : 0
    }

    console.log(`Selected ${selectedCredentials.length} Anthropic OAuth credential(s).`)
    console.log('Each account will be reauthorized and overwritten in place.\n')

    for (const [index, credential] of selectedCredentials.entries()) {
      const email = credential.account_email || '(email not stored)'

      console.log(`\n[${index + 1}/${selectedCredentials.length}] ${credential.account_id}`)
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

      try {
        const tokens = await authorizeOAuthCredential(credential.account_email, options)

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

    return failed.length > 0 ? 1 : 0
  } catch (error) {
    console.error('Error:', error)
    return 1
  } finally {
    await pool.end()
  }
}

if (import.meta.main) {
  try {
    const options = parseReloginOptions(process.argv.slice(2))
    if (options.help) {
      console.log(
        'Usage: bun run scripts/auth/oauth-relogin-all.ts [--gmail] [--account <id>] [--no-browser] [--no-clipboard]'
      )
    } else {
      process.exitCode = await reloginAllOAuthCredentials(options)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
