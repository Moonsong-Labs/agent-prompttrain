#!/usr/bin/env bun

/**
 * Migration: Add precomputed last-message summary columns to api_requests (ADR-037)
 *
 * last_message_summary holds a truncated copy of each request's last message and
 * user_text_message_count the number of user messages with visible text, so the
 * dashboard can render conversations without decompressing full request bodies.
 * Both columns are nullable without defaults, which makes this a metadata-only change.
 */

import { Pool } from 'pg'

async function up(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    // Never queue behind long-running queries on this very large table
    await client.query("SET LOCAL lock_timeout = '5s'")

    console.log('Adding last-message summary columns to api_requests...')

    await client.query(`
      ALTER TABLE api_requests
        ADD COLUMN IF NOT EXISTS last_message_summary JSONB,
        ADD COLUMN IF NOT EXISTS user_text_message_count INTEGER
    `)
    console.log('✓ Added summary columns')

    const result = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'api_requests'
        AND column_name IN ('last_message_summary', 'user_text_message_count')
    `)

    if (result.rows.length !== 2) {
      throw new Error('Verification failed: summary columns not found on api_requests')
    }

    console.log('✓ Verified columns exist')

    await client.query('COMMIT')
    console.log('✅ Last-message summary columns added successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to add last-message summary columns:', error)
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

    console.log('Removing last-message summary columns from api_requests...')

    await client.query(`
      ALTER TABLE api_requests
        DROP COLUMN IF EXISTS last_message_summary,
        DROP COLUMN IF EXISTS user_text_message_count
    `)

    await client.query('COMMIT')
    console.log('✅ Last-message summary columns removed successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to remove last-message summary columns:', error)
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
