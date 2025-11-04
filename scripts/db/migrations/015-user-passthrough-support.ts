#!/usr/bin/env bun

/**
 * Migration 015: User Passthrough Support
 *
 * Adds support for projects to use user-provided credentials instead of
 * organization accounts. When default_account_id is null, the proxy will
 * accept and forward user-provided Authorization headers directly to Anthropic.
 *
 * Changes:
 * - No schema changes needed (default_account_id is already nullable)
 * - This migration documents the feature and ensures the column allows NULL
 *
 * IMPORTANT: This migration is idempotent and can be safely run multiple times.
 */

import { Pool } from 'pg'

async function migrate() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })
  const client = await pool.connect()

  try {
    console.log('Starting user passthrough support migration (015)...')
    await client.query('BEGIN')

    // Verify that default_account_id is nullable (should already be from migration 012)
    const columnCheck = await client.query(`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_name = 'projects'
        AND column_name = 'default_account_id'
    `)

    if (columnCheck.rows[0]?.is_nullable !== 'YES') {
      console.log('Making default_account_id nullable...')
      await client.query(`
        ALTER TABLE projects
        ALTER COLUMN default_account_id DROP NOT NULL
      `)
      console.log('✓ default_account_id is now nullable')
    } else {
      console.log('✓ default_account_id is already nullable')
    }

    // Add comment documenting the user passthrough behavior
    await client.query(`
      COMMENT ON COLUMN projects.default_account_id IS
      'Default organization account for this project. When NULL, the project uses user-provided credentials passed via Authorization header (user passthrough mode).'
    `)
    console.log('✓ Added column documentation')

    await client.query('COMMIT')
    console.log('\n✅ Migration 015 completed successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('\n❌ Migration failed:', error)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

// Run migration if executed directly
if (import.meta.main) {
  migrate().catch(error => {
    console.error('Migration failed:', error)
    process.exit(1)
  })
}

export { migrate }
