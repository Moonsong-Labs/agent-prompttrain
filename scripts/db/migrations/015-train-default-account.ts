#!/usr/bin/env bun

/**
 * Migration 015: Project Default Account
 *
 * Changes train-account relationship from explicit linking to default account selection.
 * - Adds default_account_id to projects table
 * - All projects have access to all credentials
 * - Each train has one default account used for API calls
 * - Drops train_accounts junction table (no longer needed)
 *
 * Backfills existing projects with their first linked account as default
 */

import { Pool } from 'pg'

async function migrate() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })

  try {
    console.log('Starting migration 015: Project default account...')

    await pool.query('BEGIN')

    // 1. Add default_account_id column to projects table
    console.log('Adding default_account_id column to projects table...')
    await pool.query(`
      ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS default_account_id UUID REFERENCES anthropic_credentials(id) ON DELETE SET NULL;
    `)

    // 2. Backfill default_account_id from existing train_accounts
    console.log('Backfilling default accounts from train_accounts...')
    await pool.query(`
      UPDATE projects t
      SET default_account_id = (
        SELECT ta.credential_id
        FROM train_accounts ta
        WHERE ta.project_id = t.id
        ORDER BY ta.created_at ASC
        LIMIT 1
      )
      WHERE EXISTS (
        SELECT 1 FROM train_accounts ta WHERE ta.project_id = t.id
      );
    `)

    // 3. Create index on default_account_id
    console.log('Creating index on default_account_id...')
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_trains_default_account
      ON projects(default_account_id);
    `)

    // 4. Drop description column from projects (no longer needed)
    console.log('Dropping description column from projects...')
    await pool.query(`
      ALTER TABLE projects DROP COLUMN IF EXISTS description;
    `)

    // 5. Drop train_accounts table (no longer needed)
    console.log('Dropping train_accounts table...')
    await pool.query(`
      DROP TABLE IF EXISTS train_accounts;
    `)

    await pool.query('COMMIT')

    console.log('✅ Migration 015 completed successfully')
    console.log('  - Added default_account_id to projects table')
    console.log('  - Backfilled defaults from train_accounts')
    console.log('  - Dropped description column from projects')
    console.log('  - Dropped train_accounts table')
    console.log('  - All projects now have access to all credentials')
  } catch (error) {
    await pool.query('ROLLBACK')
    console.error('❌ Migration 015 failed:', error)
    throw error
  } finally {
    await pool.end()
  }
}

// Run migration
migrate().catch(error => {
  console.error('Migration failed:', error)
  process.exit(1)
})
