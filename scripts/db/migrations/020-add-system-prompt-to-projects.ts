#!/usr/bin/env bun

/**
 * Migration: Add system prompt columns to projects table
 *
 * This migration adds system_prompt_enabled and system_prompt columns to the
 * projects table, enabling project-level system prompt override functionality.
 * When enabled, the proxy replaces the system field in incoming API requests
 * with the project's configured system prompt.
 */

import { Pool } from 'pg'

async function up(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log('Adding system prompt columns to projects table...')

    // Step 1: Add system_prompt_enabled column (idempotent)
    await client.query(`
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS system_prompt_enabled BOOLEAN NOT NULL DEFAULT false
    `)
    console.log('✓ Added system_prompt_enabled column')

    // Step 2: Add system_prompt column (idempotent)
    await client.query(`
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS system_prompt JSONB DEFAULT NULL
    `)
    console.log('✓ Added system_prompt column')

    // Step 3: Verify columns were added
    const result = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'projects'
        AND table_schema = 'public'
        AND column_name IN ('system_prompt_enabled', 'system_prompt')
    `)

    if (result.rows.length < 2) {
      throw new Error('Verification failed: system_prompt columns not found in projects table')
    }

    console.log('✓ Verified columns exist')

    await client.query('COMMIT')
    console.log('✅ System prompt columns added to projects table successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to add system prompt columns:', error)
    throw error
  } finally {
    client.release()
  }
}

async function down(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log('Removing system prompt columns from projects table...')

    await client.query(`
      ALTER TABLE projects DROP COLUMN IF EXISTS system_prompt
    `)
    console.log('✓ Dropped system_prompt column')

    await client.query(`
      ALTER TABLE projects DROP COLUMN IF EXISTS system_prompt_enabled
    `)
    console.log('✓ Dropped system_prompt_enabled column')

    await client.query('COMMIT')
    console.log('✅ System prompt columns removed from projects table successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to remove system prompt columns:', error)
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
