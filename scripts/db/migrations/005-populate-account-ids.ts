#!/usr/bin/env bun
import { Pool } from 'pg'

/**
 * Migration: Populate account_id based on train ID mappings
 * This migration populates the account_id column in api_requests table based on known train-to-account mappings
 */
async function populateAccountIds() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })

  try {
    console.log('Starting account ID population migration...')

    // Start transaction
    await pool.query('BEGIN')

    // Ensure the account_id column exists (from previous migration)
    console.log('Ensuring account_id column exists...')
    await pool.query(`
      ALTER TABLE api_requests 
      ADD COLUMN IF NOT EXISTS account_id VARCHAR(255)
    `)

    // Train ID to account ID mappings
    const trainMappings = [
      {
        accountId: 'claude-1',
        trains: ['claude-1.msldev.io', 'localhost:3000', 'localhost:3001'],
      },
      {
        accountId: 'claude-2',
        trains: ['claude-prividium.msldev.io', 'claude-ai-nexus.msldev.io', 'claude-2.msldev.io'],
      },
      {
        accountId: 'claude-3',
        trains: ['claude-kluster.msldev.io', 'claude-reviews.msldev.io', 'claude-3.msldev.io'],
      },
      {
        accountId: 'claude-4',
        trains: ['claude-tanssi.msldev.io', 'claude-datahaven.msldev.io', 'claude-4.msldev.io'],
      },
      {
        accountId: 'claude-5',
        trains: ['claude-moonbeam.msldev.io', 'claude-5.msldev.io'],
      },
    ]

    // Populate account_id based on train mappings
    console.log('Populating account IDs based on train mappings...')
    for (const mapping of trainMappings) {
      const result = await pool.query(
        `
        UPDATE api_requests 
        SET account_id = $1 
        WHERE train_id = ANY($2::text[])
          AND account_id IS NULL
      `,
        [mapping.accountId, mapping.trains]
      )

      console.log(
        `Updated ${result.rowCount} rows for ${mapping.accountId} (trains: ${mapping.trains.join(', ')})`
      )
    }

    // Create index for better performance
    console.log('Creating performance index...')
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_requests_account_timestamp 
      ON api_requests(account_id, timestamp DESC)
      WHERE account_id IS NOT NULL
    `)

    // Get statistics before and after
    const statsResult = await pool.query(`
      SELECT 
        COUNT(*) as total_rows,
        COUNT(account_id) as rows_with_account_id,
        COUNT(DISTINCT account_id) as unique_accounts
      FROM api_requests
    `)

    const stats = statsResult.rows[0]
    console.log('\nMigration statistics:')
    console.log(`  - Total rows: ${stats.total_rows}`)
    console.log(`  - Rows with account_id: ${stats.rows_with_account_id}`)
    console.log(`  - Unique accounts: ${stats.unique_accounts}`)

    // Analyze the table to update statistics after bulk update
    console.log('\nAnalyzing table to update statistics...')
    await pool.query('ANALYZE api_requests')

    // Commit transaction
    await pool.query('COMMIT')
    console.log('\nAccount ID population migration completed successfully!')
  } catch (error) {
    // Rollback on error
    await pool.query('ROLLBACK')
    console.error('Migration failed:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  } finally {
    await pool.end()
  }
}

// Run migration
populateAccountIds().catch(console.error)
