#!/usr/bin/env bun

/**
 * Migration: Add token_limit_threshold column to credentials table
 *
 * This migration adds a configurable threshold for account pool auto-switching.
 * When an account's token usage reaches this percentage of its limit,
 * the proxy will automatically switch to the next available account.
 */

import { Pool } from 'pg'

async function up(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log('Adding token_limit_threshold column to credentials...')

    // Step 1: Add token_limit_threshold column (idempotent)
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'credentials'
            AND column_name = 'token_limit_threshold'
        ) THEN
          ALTER TABLE credentials
          ADD COLUMN token_limit_threshold DECIMAL(3,2) NOT NULL DEFAULT 0.80;
        END IF;
      END $$
    `)
    console.log('✓ Added token_limit_threshold column')

    // Step 2: Add CHECK constraint (idempotent)
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.constraint_column_usage
          WHERE table_name = 'credentials'
            AND constraint_name = 'credentials_token_limit_threshold_check'
        ) THEN
          ALTER TABLE credentials
          ADD CONSTRAINT credentials_token_limit_threshold_check CHECK (
            token_limit_threshold > 0 AND token_limit_threshold <= 1
          );
        END IF;
      END $$
    `)
    console.log('✓ Added token_limit_threshold CHECK constraint (0 < value <= 1)')

    // Step 3: Verify column was added
    const result = await client.query(`
      SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'credentials'
        AND column_name = 'token_limit_threshold'
    `)

    if (result.rows.length === 0) {
      throw new Error('Verification failed: token_limit_threshold column not found')
    }

    console.log('✓ Verified column exists:', result.rows[0])

    await client.query('COMMIT')
    console.log('✅ token_limit_threshold column added successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to add token_limit_threshold:', error)
    throw error
  } finally {
    client.release()
  }
}

async function down(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log('Removing token_limit_threshold column from credentials...')

    // Drop constraint first
    await client.query(`
      ALTER TABLE credentials
      DROP CONSTRAINT IF EXISTS credentials_token_limit_threshold_check
    `)
    console.log('✓ Removed CHECK constraint')

    // Drop column
    await client.query(`
      ALTER TABLE credentials
      DROP COLUMN IF EXISTS token_limit_threshold
    `)
    console.log('✓ Removed token_limit_threshold column')

    await client.query('COMMIT')
    console.log('✅ token_limit_threshold column removed successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to remove token_limit_threshold:', error)
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
