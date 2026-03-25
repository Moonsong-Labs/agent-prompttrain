#!/usr/bin/env bun

/**
 * Migration: Add disabled column to projects table
 *
 * This migration adds a `disabled` boolean column to the projects table.
 * When a project is disabled, its API keys are rejected at authentication time,
 * preventing any member from using the project. Disabled projects remain visible
 * in the dashboard for historical reference but cannot process new requests.
 */

import { Pool } from 'pg'

async function up(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log('Adding disabled column to projects table...')

    // Step 1: Add disabled column (idempotent)
    await client.query(`
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT false
    `)
    console.log('✓ Added disabled column')

    // Step 2: Add index for efficient filtering
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_projects_disabled ON projects (disabled) WHERE disabled = true
    `)
    console.log('✓ Added partial index on disabled column')

    // Step 3: Verify column was added
    const result = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'projects'
        AND table_schema = 'public'
        AND column_name = 'disabled'
    `)

    if (result.rows.length === 0) {
      throw new Error('Verification failed: disabled column not found in projects table')
    }

    console.log('✓ Verified column exists')

    await client.query('COMMIT')
    console.log('✅ Disabled column added to projects table successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to add disabled column:', error)
    throw error
  } finally {
    client.release()
  }
}

async function down(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log('Removing disabled column from projects table...')

    await client.query(`
      DROP INDEX IF EXISTS idx_projects_disabled
    `)
    console.log('✓ Dropped disabled index')

    await client.query(`
      ALTER TABLE projects DROP COLUMN IF EXISTS disabled
    `)
    console.log('✓ Dropped disabled column')

    await client.query('COMMIT')
    console.log('✅ Disabled column removed from projects table successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to remove disabled column:', error)
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
