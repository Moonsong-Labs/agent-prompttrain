#!/usr/bin/env bun

/**
 * Migration: Add system_prompt_mode column to projects table
 *
 * Extends the system prompt override feature to support a "prepend" mode
 * in addition to the existing "replace" mode. In prepend mode, the project's
 * system prompt blocks are placed before the original request blocks instead
 * of replacing them entirely.
 */

import { Pool } from 'pg'

async function up(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log('Adding system_prompt_mode column to projects table...')

    // Add system_prompt_mode column with 'replace' as default (preserves existing behavior)
    await client.query(`
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS system_prompt_mode VARCHAR(10) NOT NULL DEFAULT 'replace'
    `)
    console.log('✓ Added system_prompt_mode column')

    // Verify column was added
    const result = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'projects'
        AND table_schema = 'public'
        AND column_name = 'system_prompt_mode'
    `)

    if (result.rows.length === 0) {
      throw new Error('Verification failed: system_prompt_mode column not found in projects table')
    }

    console.log('✓ Verified column exists')

    await client.query('COMMIT')
    console.log('✅ system_prompt_mode column added to projects table successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to add system_prompt_mode column:', error)
    throw error
  } finally {
    client.release()
  }
}

async function down(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log('Removing system_prompt_mode column from projects table...')

    await client.query(`
      ALTER TABLE projects DROP COLUMN IF EXISTS system_prompt_mode
    `)
    console.log('✓ Dropped system_prompt_mode column')

    await client.query('COMMIT')
    console.log('✅ system_prompt_mode column removed from projects table successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to remove system_prompt_mode column:', error)
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
