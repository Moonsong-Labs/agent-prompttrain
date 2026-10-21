#!/usr/bin/env bun

/**
 * Migration: Add oauth_refresh_rejected_token_hash column to credentials
 *
 * Holds the SHA-256 of the refresh token Anthropic rejected with invalid_grant.
 * While it matches the stored refresh token, the account cannot refresh and account
 * pools skip it. A relogin stores a new refresh token, which clears the state without
 * writing this column (ADR-040).
 * The column is nullable without a default, which makes this a metadata-only change.
 */

import { Pool } from 'pg'

async function up(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    // The proxy updates credentials on every token refresh; never queue behind it
    await client.query("SET LOCAL lock_timeout = '5s'")

    console.log('Adding oauth_refresh_rejected_token_hash column to credentials...')

    await client.query(`
      ALTER TABLE credentials
        ADD COLUMN IF NOT EXISTS oauth_refresh_rejected_token_hash TEXT
    `)

    const result = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'credentials'
        AND column_name = 'oauth_refresh_rejected_token_hash'
    `)

    if (result.rows.length !== 1) {
      throw new Error('Verification failed: oauth_refresh_rejected_token_hash not found')
    }

    console.log('✓ Verified column exists')

    await client.query('COMMIT')
    console.log('✅ Refresh token rejection column added successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to add refresh token rejection column:', error)
    throw error
  } finally {
    client.release()
  }
}

async function down(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout = '5s'")

    console.log('Removing oauth_refresh_rejected_token_hash column from credentials...')

    await client.query(`
      ALTER TABLE credentials
        DROP COLUMN IF EXISTS oauth_refresh_rejected_token_hash
    `)

    await client.query('COMMIT')
    console.log('✅ Refresh token rejection column removed successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to remove refresh token rejection column:', error)
    throw error
  } finally {
    client.release()
  }
}

// Main execution
async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })

  try {
    const action = process.argv[2] || 'up'

    if (action === 'up') {
      await up(pool)
    } else if (action === 'down') {
      await down(pool)
    } else {
      console.error(`❌ Unknown action: ${action}. Use 'up' or 'down'`)
      process.exit(1)
    }
  } catch (error) {
    console.error('❌ Migration failed:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

// Run if executed directly
if (import.meta.main) {
  main()
}

export { up, down }
