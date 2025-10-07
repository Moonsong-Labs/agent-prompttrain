#!/usr/bin/env bun
import { Pool } from 'pg'
import {
  listCredentials,
  updateCredential,
} from '../../packages/shared/src/database/queries/index.js'
import { refreshOAuthToken } from '../../services/proxy/src/credentials/index.js'

async function refreshAllOAuthTokens() {
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
    // Get all credentials from database
    const credentials = await listCredentials(pool)

    if (credentials.length === 0) {
      console.log('No credentials found in database.')
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
        const expiresAt = credential.oauth_expires_at
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
          const newTokens = await refreshOAuthToken(credential.oauth_refresh_token)

          // Update credential in database
          await updateCredential(pool, accountId, {
            oauth_access_token: newTokens.accessToken,
            oauth_refresh_token: newTokens.refreshToken,
            oauth_expires_at: new Date(newTokens.expiresAt),
            oauth_scopes: newTokens.scopes,
            oauth_is_max: newTokens.isMax,
          })

          const expiresIn = newTokens.expiresAt - Date.now()
          const hours = Math.floor(expiresIn / (1000 * 60 * 60))
          console.log(`  ✅ Refreshed! Valid for ${hours}h`)
          results.refreshed++
        } catch (error: any) {
          console.log(`  ❌ Refresh failed: ${error.message}`)
          results.failed++
          results.errors.push({ accountId, error: error.message })
        }
      } catch (error: any) {
        console.log(`  ❌ Error: ${error.message}`)
        results.failed++
        results.errors.push({ accountId, error: error.message })
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
