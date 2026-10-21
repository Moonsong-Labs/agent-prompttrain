#!/usr/bin/env bun
import { Pool } from 'pg'
import { listAnthropicCredentials } from '../../packages/shared/src/database/queries/index.js'
import { OAuthRefreshError, refreshAccessToken } from '../../services/proxy/src/credentials.ts'

async function refreshAllOAuthTokens() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: bun run auth:oauth-refresh [--dry-run]')
    console.log('\nRefreshes every Anthropic OAuth token that expires within 5 minutes.')
    console.log('  --dry-run    List the tokens that would be refreshed without refreshing them')
    process.exit(0)
  }

  const dryRun = process.argv.includes('--dry-run')

  console.log('OAuth Refresh All Tool')
  console.log('=====================')
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE'}\n`)

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })

  try {
    const credentials = await listAnthropicCredentials(pool)

    if (credentials.length === 0) {
      console.log('No Anthropic OAuth credentials found in database.')
      process.exit(0)
    }

    console.log(`Found ${credentials.length} credentials\n`)

    const results = {
      total: credentials.length,
      refreshed: 0,
      failed: 0,
      skipped: 0,
      errors: [] as { accountId: string; error: string }[],
    }

    for (const credential of credentials) {
      const accountId = credential.account_id

      console.log(`\n[${accountId}]`)
      console.log(`  Account Name: ${credential.account_name}`)

      try {
        const now = new Date()
        const expiresAt = credential.oauth_expires_at ? new Date(credential.oauth_expires_at) : null
        const isExpired = expiresAt ? now >= expiresAt : true
        const willExpireSoon = expiresAt ? now >= new Date(expiresAt.getTime() - 300000) : true // 5 minutes before expiry

        if (!isExpired && !willExpireSoon) {
          const expiresIn = expiresAt!.getTime() - now.getTime()
          const hours = Math.floor(expiresIn / (1000 * 60 * 60))
          console.log(`  ✓ Token valid for ${hours}h (skipping)`)
          results.skipped++
          continue
        }

        if (!credential.oauth_refresh_token) {
          console.log('  ⚠️  No refresh token available')
          results.failed++
          results.errors.push({ accountId, error: 'No refresh token' })
          continue
        }

        console.log(`  🔄 Refreshing ${isExpired ? 'expired' : 'expiring'} token...`)

        if (dryRun) {
          console.log('  📝 Would refresh token (dry run)')
          results.refreshed++
          continue
        }

        try {
          // Same cluster-wide lock as the proxy, so this never races a proxy refresh;
          // forced because the proxy itself only refreshes within a minute of expiry
          await refreshAccessToken(pool, credential.id, { force: true })
          console.log('  ✅ Refreshed!')
          results.refreshed++
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.log(`  ❌ Refresh failed: ${message}`)
          if (error instanceof OAuthRefreshError && error.isRefreshTokenRejected) {
            console.log(`  Run: bun run auth:oauth-relogin --account ${accountId}`)
          }
          results.failed++
          results.errors.push({ accountId, error: message })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.log(`  ❌ Error: ${message}`)
        results.failed++
        results.errors.push({ accountId, error: message })
      }
    }

    // Summary
    console.log('\n\nSummary')
    console.log('=======')
    console.log(`Total credentials: ${results.total}`)
    console.log(`\nProcessed OAuth credentials:`)
    console.log(`- Refreshed: ${results.refreshed}`)
    console.log(`- Skipped (valid): ${results.skipped}`)
    console.log(`- Failed: ${results.failed}`)

    if (results.errors.length > 0) {
      console.log('\nErrors:')
      results.errors.forEach(({ accountId, error }) => {
        console.log(`- ${accountId}: ${error}`)
      })
    }

    if (dryRun) {
      console.log('\n⚠️  This was a dry run. No changes were made.')
      console.log('Remove --dry-run to actually refresh tokens.')
    }

    process.exit(results.failed > 0 ? 1 : 0)
  } catch (error) {
    console.error('Error:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

refreshAllOAuthTokens()
