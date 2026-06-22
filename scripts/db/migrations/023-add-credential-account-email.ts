#!/usr/bin/env bun

/**
 * Migration: Add account_email column to credentials
 *
 * Stores the login email used for Anthropic OAuth relogin workflows.
 * This value is intentionally omitted from safe credential API/dashboard payloads.
 */

import { Pool } from 'pg'

async function up(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log('Adding account_email column to credentials...')

    await client.query(`
      ALTER TABLE credentials
      ADD COLUMN IF NOT EXISTS account_email VARCHAR(255)
    `)

    await client.query(`
      COMMENT ON COLUMN credentials.account_email
      IS 'Optional login email for credential maintenance scripts; not exposed in safe dashboard payloads'
    `)

    await client.query('COMMIT')
    console.log('✅ account_email column added successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to add account_email:', error)
    throw error
  } finally {
    client.release()
  }
}

async function down(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log('Removing account_email column from credentials...')

    await client.query(`
      ALTER TABLE credentials
      DROP COLUMN IF EXISTS account_email
    `)

    await client.query('COMMIT')
    console.log('✅ account_email column removed successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to remove account_email:', error)
    throw error
  } finally {
    client.release()
  }
}

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

if (import.meta.main) {
  main()
}
