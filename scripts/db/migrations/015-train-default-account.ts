#!/usr/bin/env bun

/**
 * Migration 015: Train Default Account
 *
 * Changes train-account relationship from explicit linking to default account selection.
 * - Adds default_account_id to trains table
 * - All trains have access to all credentials
 * - Each train has one default account used for API calls
 * - Drops train_accounts junction table (no longer needed)
 *
 * Backfills existing trains with their first linked account as default
 */

import { createPool } from '@agent-prompttrain/shared/database'

async function migrate() {
  const pool = createPool()

  try {
    console.log('Starting migration 015: Train default account...')

    await pool.query('BEGIN')

    // 1. Add default_account_id column to trains table
    console.log('Adding default_account_id column to trains table...')
    await pool.query(`
      ALTER TABLE trains
      ADD COLUMN IF NOT EXISTS default_account_id UUID REFERENCES anthropic_credentials(id) ON DELETE SET NULL;
    `)

    // 2. Backfill default_account_id from existing train_accounts
    console.log('Backfilling default accounts from train_accounts...')
    await pool.query(`
      UPDATE trains t
      SET default_account_id = (
        SELECT ta.credential_id
        FROM train_accounts ta
        WHERE ta.train_id = t.id
        ORDER BY ta.linked_at ASC
        LIMIT 1
      )
      WHERE EXISTS (
        SELECT 1 FROM train_accounts ta WHERE ta.train_id = t.id
      );
    `)

    // 3. Create index on default_account_id
    console.log('Creating index on default_account_id...')
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_trains_default_account
      ON trains(default_account_id);
    `)

    // 4. Drop train_accounts table (no longer needed)
    console.log('Dropping train_accounts table...')
    await pool.query(`
      DROP TABLE IF EXISTS train_accounts;
    `)

    await pool.query('COMMIT')

    console.log('✅ Migration 015 completed successfully')
    console.log('  - Added default_account_id to trains table')
    console.log('  - Backfilled defaults from train_accounts')
    console.log('  - Dropped train_accounts table')
    console.log('  - All trains now have access to all credentials')
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
