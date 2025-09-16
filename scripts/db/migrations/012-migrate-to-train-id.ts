#!/usr/bin/env bun

import { Pool } from 'pg'
import * as dotenv from 'dotenv'
import * as path from 'path'

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env') })

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

/**
 * Migration 012: Replace domain with train_id
 *
 * This migration adds train_id column and migrates existing data from domain.
 * The train_id represents the train identifier from X-TRAIN-ID header, used to
 * group requests by project/user.
 *
 * Changes:
 * 1. Add train_id column to api_requests and conversation_analyses tables
 * 2. Migrate existing domain values to train_id
 * 3. Create appropriate indexes for train_id
 * 4. Mark domain column as deprecated (not dropped for safety)
 */
async function migrate() {
  const client = await pool.connect()

  try {
    console.log('Starting migration 012: Replace domain with train_id...')

    await client.query('BEGIN')

    // Safety check - skip if already migrated
    console.log('Checking if migration has already been applied...')
    const alreadyMigrated = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'api_requests' 
        AND column_name = 'train_id' 
        AND is_nullable = 'NO'
      ) as migrated
    `)

    if (alreadyMigrated.rows[0].migrated) {
      console.log('✅ Migration already completed - train_id column exists and is NOT NULL')
      await client.query('COMMIT')
      return
    }

    // Step 1: Add train_id column (nullable initially for migration)
    console.log('Step 1: Adding train_id column to api_requests...')
    await client.query(`
      ALTER TABLE api_requests 
      ADD COLUMN IF NOT EXISTS train_id VARCHAR(255)
    `)

    // Step 2: Migrate existing data - copy domain values to train_id
    console.log('Step 2: Migrating existing data from domain to train_id...')
    const migrateResult = await client.query(`
      UPDATE api_requests 
      SET train_id = COALESCE(domain, 'default')
      WHERE train_id IS NULL
    `)
    console.log(`   → Migrated ${migrateResult.rowCount} rows`)

    // Step 3: Set default value for train_id
    console.log('Step 3: Setting default value for train_id...')
    await client.query(`
      ALTER TABLE api_requests 
      ALTER COLUMN train_id SET DEFAULT 'default'
    `)

    // Step 4: Verify all rows have train_id before making it NOT NULL
    console.log('Step 4: Verifying data integrity before setting NOT NULL constraint...')
    const nullCheck = await client.query(`
      SELECT COUNT(*) as null_count FROM api_requests WHERE train_id IS NULL
    `)

    if (parseInt(nullCheck.rows[0].null_count) > 0) {
      throw new Error(
        `Cannot make train_id NOT NULL: ${nullCheck.rows[0].null_count} rows still have NULL values`
      )
    }

    await client.query(`
      ALTER TABLE api_requests 
      ALTER COLUMN train_id SET NOT NULL
    `)

    // Step 5: Create indexes for train_id
    console.log('Step 5: Creating indexes for train_id...')
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_requests_train_id ON api_requests(train_id)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_requests_train_id_timestamp ON api_requests(train_id, timestamp DESC)
    `)

    // Step 6: Drop domain column indexes (they will be replaced by train_id indexes)
    console.log('Step 6: Dropping old domain column indexes...')
    await client.query(`DROP INDEX IF EXISTS idx_requests_domain`)
    await client.query(`DROP INDEX IF EXISTS idx_api_requests_domain_timestamp_response`)

    // Step 7: Remove NOT NULL constraint from domain column (preparation for eventual removal)
    console.log('Step 7: Removing NOT NULL constraint from domain column...')
    await client.query(`
      ALTER TABLE api_requests 
      ALTER COLUMN domain DROP NOT NULL
    `)

    // Step 8: Add column comment for train_id
    console.log('Step 8: Adding column documentation...')
    await client.query(`
      COMMENT ON COLUMN api_requests.train_id IS 
      'Train identifier from X-TRAIN-ID header, used to group requests by project/user'
    `)

    // Step 9: Update conversation_analyses table if it exists
    console.log('Step 9: Updating conversation_analyses table...')
    const tableExists = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = 'conversation_analyses'
      ) as exists
    `)

    if (tableExists.rows[0].exists) {
      console.log('   → Adding train_id column to conversation_analyses...')
      await client.query(`
        ALTER TABLE conversation_analyses 
        ADD COLUMN IF NOT EXISTS train_id VARCHAR(255)
      `)

      const analysesResult = await client.query(`
        UPDATE conversation_analyses 
        SET train_id = 'default' 
        WHERE train_id IS NULL
      `)
      console.log(`   → Migrated ${analysesResult.rowCount} conversation analysis rows`)

      await client.query(`
        ALTER TABLE conversation_analyses 
        ALTER COLUMN train_id SET DEFAULT 'default'
      `)

      // Check if we can set NOT NULL constraint
      const analysesNullCheck = await client.query(`
        SELECT COUNT(*) as null_count FROM conversation_analyses WHERE train_id IS NULL
      `)

      if (parseInt(analysesNullCheck.rows[0].null_count) === 0) {
        await client.query(`
          ALTER TABLE conversation_analyses 
          ALTER COLUMN train_id SET NOT NULL
        `)
        console.log('   → Set train_id as NOT NULL in conversation_analyses')
      } else {
        console.warn(
          `   → Warning: conversation_analyses has ${analysesNullCheck.rows[0].null_count} rows with NULL train_id, skipping NOT NULL constraint`
        )
      }
    } else {
      console.log('   → conversation_analyses table does not exist, skipping')
    }

    // Mark domain column as deprecated
    await client.query(`
      COMMENT ON COLUMN api_requests.domain IS 
      'DEPRECATED: Use train_id instead. Will be removed in future migration.'
    `)

    // Final verification
    console.log('Performing final verification...')
    const verification = await client.query(`
      SELECT 
        COUNT(*) as total_count,
        COUNT(*) FILTER (WHERE train_id IS NOT NULL) as train_id_count,
        COUNT(*) FILTER (WHERE domain IS NOT NULL) as domain_count
      FROM api_requests
    `)

    const stats = verification.rows[0]
    console.log(
      `   → api_requests: ${stats.total_count} total rows, ${stats.train_id_count} with train_id, ${stats.domain_count} with domain`
    )

    if (parseInt(stats.train_id_count) !== parseInt(stats.total_count)) {
      throw new Error(
        `Migration verification failed: ${stats.total_count} rows but only ${stats.train_id_count} have train_id`
      )
    }

    // Check conversation_analyses if it exists
    if (tableExists.rows[0].exists) {
      const analysesVerification = await client.query(`
        SELECT 
          COUNT(*) as total_count,
          COUNT(*) FILTER (WHERE train_id IS NOT NULL) as train_id_count
        FROM conversation_analyses
      `)
      const analysesStats = analysesVerification.rows[0]
      console.log(
        `   → conversation_analyses: ${analysesStats.total_count} total rows, ${analysesStats.train_id_count} with train_id`
      )
    }

    await client.query('COMMIT')
    console.log('✅ Migration 012 completed successfully!')
    console.log('')
    console.log('Summary of changes:')
    console.log('- Added train_id column to api_requests (NOT NULL, default: "default")')
    console.log('- Migrated all existing domain values to train_id')
    console.log('- Created indexes: idx_requests_train_id, idx_requests_train_id_timestamp')
    console.log(
      '- Dropped old domain indexes: idx_requests_domain, idx_api_requests_domain_timestamp_response'
    )
    console.log('- Made domain column nullable (marked as DEPRECATED)')
    console.log('- Updated conversation_analyses table with train_id column')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error(
      '❌ Migration 012 failed:',
      error instanceof Error ? error.message : String(error)
    )
    throw error
  } finally {
    client.release()
  }
}

/**
 * Rollback function to reverse the migration
 */
async function rollback() {
  const client = await pool.connect()

  try {
    console.log('Rolling back migration 012...')

    await client.query('BEGIN')

    // Drop train_id indexes
    console.log('Dropping train_id indexes...')
    await client.query('DROP INDEX IF EXISTS idx_requests_train_id')
    await client.query('DROP INDEX IF EXISTS idx_requests_train_id_timestamp')

    // Restore domain indexes
    console.log('Restoring domain indexes...')
    await client.query('CREATE INDEX IF NOT EXISTS idx_requests_domain ON api_requests(domain)')
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_requests_domain_timestamp_response
      ON api_requests(domain, timestamp DESC)
      WHERE response_body IS NOT NULL
    `)

    // Restore domain NOT NULL constraint
    console.log('Restoring domain NOT NULL constraint...')
    await client.query(`
      ALTER TABLE api_requests 
      ALTER COLUMN domain SET NOT NULL
    `)

    // Remove train_id column from conversation_analyses if it exists
    const tableExists = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = 'conversation_analyses'
      ) as exists
    `)

    if (tableExists.rows[0].exists) {
      console.log('Removing train_id from conversation_analyses...')
      await client.query('ALTER TABLE conversation_analyses DROP COLUMN IF EXISTS train_id')
    }

    // Remove train_id column from api_requests
    console.log('Removing train_id column from api_requests...')
    await client.query('ALTER TABLE api_requests DROP COLUMN IF EXISTS train_id')

    // Restore original domain column comment
    await client.query(`
      COMMENT ON COLUMN api_requests.domain IS NULL
    `)

    await client.query('COMMIT')
    console.log('✅ Rollback 012 completed successfully!')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Rollback 012 failed:', error instanceof Error ? error.message : String(error))
    throw error
  } finally {
    client.release()
  }
}

// Main execution
async function main() {
  const command = process.argv[2]

  try {
    if (command === 'rollback') {
      await rollback()
    } else {
      await migrate()
    }
  } catch (error) {
    console.error('Error:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
