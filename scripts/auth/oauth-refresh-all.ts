#!/usr/bin/env bun
import { readdirSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { loadCredentials, refreshToken } from '../../services/proxy/src/credentials'

async function refreshAllOAuthTokens() {
  const credentialsDir = process.argv[2] || 'credentials'
  const dryRun = process.argv.includes('--dry-run')

  console.log('OAuth Refresh All Tool')
  console.log('=====================')
  console.log(`Credentials directory: ${credentialsDir}`)
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE'}\n`)

  if (!credentialsDir) {
    console.error('Usage: bun run scripts/oauth-refresh-all.ts [credentials-dir] [--dry-run]')
    console.error('Example: bun run scripts/oauth-refresh-all.ts credentials')
    process.exit(1)
  }

  try {
    const fullDir = resolve(credentialsDir)

    // Get all credential files
    const files = readdirSync(fullDir)
      .filter(file => file.endsWith('.credentials.json'))
      .sort()

    if (files.length === 0) {
      console.log('No credential files found.')
      process.exit(0)
    }

    console.log(`Found ${files.length} credential files\n`)

    const results = {
      total: files.length,
      oauth: 0,
      apiKey: 0,
      refreshed: 0,
      failed: 0,
      skipped: 0,
      errors: [] as { file: string; error: string }[],
    }

    for (const file of files) {
      const filePath = join(fullDir, file)
      const trainId = file.replace('.credentials.json', '')

      console.log(`\n[${trainId}]`)

      try {
        const credentials = loadCredentials(filePath)

        if (!credentials) {
          console.log('  ❌ Failed to load credentials')
          results.failed++
          results.errors.push({ file, error: 'Failed to load' })
          continue
        }

        if (credentials.type === 'api_key') {
          console.log('  ℹ️  API key credential (skipping)')
          results.apiKey++
          results.skipped++
          continue
        }

        if (credentials.type === 'oauth' && credentials.oauth) {
          results.oauth++
          const oauth = credentials.oauth
          const now = Date.now()
          const expiresAt = oauth.expiresAt || 0
          const isExpired = now >= expiresAt
          const willExpireSoon = now >= expiresAt - 300000 // 5 minutes before expiry

          if (!isExpired && !willExpireSoon) {
            const expiresIn = expiresAt - now
            const hours = Math.floor(expiresIn / (1000 * 60 * 60))
            console.log(`  ✓ Token valid for ${hours}h (skipping)`)
            results.skipped++
            continue
          }

          if (!oauth.refreshToken) {
            console.log('  ⚠️  No refresh token available')
            results.failed++
            results.errors.push({ file, error: 'No refresh token' })
            continue
          }

          console.log(`  🔄 Refreshing ${isExpired ? 'expired' : 'expiring'} token...`)

          if (dryRun) {
            console.log('  📝 Would refresh token (dry run)')
            results.refreshed++
            continue
          }

          try {
            const newOAuth = await refreshToken(oauth.refreshToken)
            credentials.oauth = newOAuth

            // Load existing file to preserve non-OAuth fields
            let existingData: any = {}
            try {
              const content = readFileSync(filePath, 'utf-8')
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
            mkdirSync(dirname(filePath), { recursive: true })
            writeFileSync(filePath, JSON.stringify(mergedCredentials, null, 2))

            const expiresIn = newOAuth.expiresAt - Date.now()
            const hours = Math.floor(expiresIn / (1000 * 60 * 60))
            console.log(`  ✅ Refreshed! Valid for ${hours}h`)
            results.refreshed++
          } catch (error: any) {
            console.log(`  ❌ Refresh failed: ${error.message}`)
            results.failed++
            results.errors.push({ file, error: error.message })
          }
        }
      } catch (error: any) {
        console.log(`  ❌ Error: ${error.message}`)
        results.failed++
        results.errors.push({ file, error: error.message })
      }
    }

    // Summary
    console.log('\n\nSummary')
    console.log('=======')
    console.log(`Total files: ${results.total}`)
    console.log(`- OAuth: ${results.oauth}`)
    console.log(`- API Key: ${results.apiKey}`)
    console.log(`\nProcessed OAuth credentials:`)
    console.log(`- Refreshed: ${results.refreshed}`)
    console.log(`- Skipped (valid): ${results.skipped - results.apiKey}`)
    console.log(`- Failed: ${results.failed}`)

    if (results.errors.length > 0) {
      console.log('\nErrors:')
      results.errors.forEach(({ file, error }) => {
        console.log(`- ${file}: ${error}`)
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
  }
}

refreshAllOAuthTokens()
