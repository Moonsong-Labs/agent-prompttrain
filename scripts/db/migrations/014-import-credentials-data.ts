#!/usr/bin/env bun
import { Pool } from 'pg'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import crypto from 'crypto'

// Inline hashing function for client API keys
function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex')
}

/**
 * Migration 014: Import credentials from filesystem to database
 *
 * This migration reads existing credential files from the filesystem and imports them
 * into the database. It's idempotent and can be run multiple times safely.
 */

interface ClaudeCredentials {
  type: 'api_key' | 'oauth'
  accountId?: string
  api_key?: string
  oauth?: {
    accessToken: string
    refreshToken: string
    expiresAt: number
    scopes: string[]
    isMax: boolean
  }
}

interface TrainClientKeys {
  keys: string[]
}

async function migrateCredentialsData() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  try {
    await pool.query('BEGIN')

    const accountsDir = join(process.cwd(), 'credentials/accounts')
    const trainsDir = join(process.cwd(), 'credentials/train-client-keys')

    // Import accounts
    console.log('Importing account credentials...')
    let accountsImported = 0
    let accountsSkipped = 0

    try {
      const accountFiles = await readdir(accountsDir)

      for (const file of accountFiles) {
        if (!file.endsWith('.credentials.json')) {
          continue
        }

        const accountName = file.replace('.credentials.json', '')
        const filePath = join(accountsDir, file)

        try {
          const content = await readFile(filePath, 'utf-8')
          const credentials: ClaudeCredentials = JSON.parse(content)

          // Generate account ID if not present
          const accountId = credentials.accountId || `acc_${accountName}`

          // Insert with ON CONFLICT for idempotency
          const result = await pool.query(
            `
            INSERT INTO accounts (
              account_id, account_name, credential_type,
              api_key, oauth_access_token,
              oauth_refresh_token, oauth_expires_at,
              oauth_scopes, oauth_is_max
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (account_id) DO UPDATE SET
              account_name = EXCLUDED.account_name,
              credential_type = EXCLUDED.credential_type,
              api_key = EXCLUDED.api_key,
              oauth_access_token = EXCLUDED.oauth_access_token,
              oauth_refresh_token = EXCLUDED.oauth_refresh_token,
              oauth_expires_at = EXCLUDED.oauth_expires_at,
              oauth_scopes = EXCLUDED.oauth_scopes,
              oauth_is_max = EXCLUDED.oauth_is_max,
              updated_at = NOW()
            RETURNING (xmax = 0) AS inserted
          `,
            [
              accountId,
              accountName,
              credentials.type,
              credentials.api_key || null,
              credentials.oauth?.accessToken || null,
              credentials.oauth?.refreshToken || null,
              credentials.oauth?.expiresAt || null,
              credentials.oauth?.scopes || null,
              credentials.oauth?.isMax || false,
            ]
          )

          if (result.rows[0].inserted) {
            accountsImported++
            console.log(`  ✓ Imported account: ${accountName}`)
          } else {
            accountsSkipped++
            console.log(`  → Updated account: ${accountName}`)
          }
        } catch (error) {
          console.error(`  ✗ Failed to import ${file}:`, error)
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log('  No accounts directory found, skipping...')
      } else {
        throw error
      }
    }

    // Import trains
    console.log('\nImporting train configurations...')
    let trainsImported = 0
    let trainsSkipped = 0

    try {
      const trainFiles = await readdir(trainsDir)

      for (const file of trainFiles) {
        if (!file.endsWith('.client-keys.json')) {
          continue
        }

        const trainId = file.replace('.client-keys.json', '')
        const filePath = join(trainsDir, file)

        try {
          const content = await readFile(filePath, 'utf-8')
          const config: TrainClientKeys = JSON.parse(content)

          // Hash client API keys for storage
          const hashedKeys = config.keys.map(key => hashApiKey(key))

          // Insert with ON CONFLICT for idempotency
          const result = await pool.query(
            `
            INSERT INTO trains (train_id, client_api_keys_hashed)
            VALUES ($1, $2)
            ON CONFLICT (train_id) DO UPDATE SET
              client_api_keys_hashed = EXCLUDED.client_api_keys_hashed,
              updated_at = NOW()
            RETURNING (xmax = 0) AS inserted
          `,
            [trainId, hashedKeys]
          )

          if (result.rows[0].inserted) {
            trainsImported++
            console.log(`  ✓ Imported train: ${trainId} (${config.keys.length} keys)`)
          } else {
            trainsSkipped++
            console.log(`  → Updated train: ${trainId} (${config.keys.length} keys)`)
          }
        } catch (error) {
          console.error(`  ✗ Failed to import ${file}:`, error)
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log('  No trains directory found, skipping...')
      } else {
        throw error
      }
    }

    // Verify import
    console.log('\nVerifying data import...')
    const accountCount = await pool.query('SELECT COUNT(*) as count FROM accounts')
    const trainCount = await pool.query('SELECT COUNT(*) as count FROM trains')

    console.log(`\nSummary:`)
    console.log(
      `  Accounts: ${accountCount.rows[0].count} total (${accountsImported} new, ${accountsSkipped} updated)`
    )
    console.log(
      `  Trains: ${trainCount.rows[0].count} total (${trainsImported} new, ${trainsSkipped} updated)`
    )

    await pool.query('COMMIT')
    console.log('\nMigration 014 completed successfully!')
  } catch (error) {
    await pool.query('ROLLBACK')
    console.error('Migration 014 failed:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

migrateCredentialsData().catch(console.error)
