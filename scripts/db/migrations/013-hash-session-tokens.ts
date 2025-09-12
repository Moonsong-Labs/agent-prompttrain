#!/usr/bin/env bun
/**
 * Migration 013: Hash session tokens for security
 *
 * This migration updates the sessions table to store hashed tokens instead of plain text.
 * This is a critical security fix to prevent session hijacking if database is compromised.
 *
 * Changes:
 * 1. Rename token column to token_hash
 * 2. Change type to CHAR(64) for SHA-256 hex output
 * 3. Update indexes accordingly
 */

import { Pool } from 'pg'
import { config } from 'dotenv'

// Load environment variables
config()

async function migrate() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  })

  try {
    console.log('Migration 013: Hashing session tokens for security...')

    // Start transaction
    await pool.query('BEGIN')

    // Check if migration already applied
    console.log('\n1. Checking if migration already applied...')
    const columnCheck = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'sessions' 
      AND column_name IN ('token', 'token_hash')
    `)

    const hasTokenHash = columnCheck.rows.some(row => row.column_name === 'token_hash')
    const hasToken = columnCheck.rows.some(row => row.column_name === 'token')

    if (hasTokenHash) {
      console.log('Migration already applied - token_hash column exists')
      await pool.query('ROLLBACK')
      return
    }

    if (!hasToken) {
      throw new Error('Sessions table does not have token column - cannot migrate')
    }

    // Clear existing sessions since we can't hash existing plain text tokens
    console.log('\n2. Clearing existing sessions (cannot hash plain text tokens)...')
    const deletedSessions = await pool.query('DELETE FROM sessions')
    console.log(`Deleted ${deletedSessions.rowCount} existing sessions`)

    // Rename column and change type
    console.log('\n3. Renaming token column to token_hash...')
    await pool.query(`
      ALTER TABLE sessions 
      RENAME COLUMN token TO token_hash
    `)

    console.log('\n4. Changing token_hash type to CHAR(64) for SHA-256...')
    await pool.query(`
      ALTER TABLE sessions 
      ALTER COLUMN token_hash TYPE CHAR(64)
    `)

    // Update index
    console.log('\n5. Recreating index for token_hash...')
    await pool.query('DROP INDEX IF EXISTS idx_sessions_token')
    await pool.query('CREATE UNIQUE INDEX idx_sessions_token_hash ON sessions(token_hash)')

    // Update column comment
    console.log('\n6. Updating column comment...')
    await pool.query(`
      COMMENT ON COLUMN sessions.token_hash IS 'SHA-256 hash of the secure session token'
    `)

    // Verify migration
    console.log('\n7. Verifying migration...')
    const verifyCheck = await pool.query(`
      SELECT column_name, data_type, character_maximum_length
      FROM information_schema.columns 
      WHERE table_name = 'sessions' 
      AND column_name = 'token_hash'
    `)

    if (verifyCheck.rows.length === 0) {
      throw new Error('Migration failed - token_hash column not found')
    }

    const column = verifyCheck.rows[0]
    if (column.data_type !== 'character' || column.character_maximum_length !== 64) {
      throw new Error(
        `Migration failed - incorrect column type: ${column.data_type}(${column.character_maximum_length})`
      )
    }

    // Verify index exists
    const indexCheck = await pool.query(`
      SELECT indexname 
      FROM pg_indexes 
      WHERE tablename = 'sessions' 
      AND indexname = 'idx_sessions_token_hash'
    `)

    if (indexCheck.rows.length === 0) {
      throw new Error('Migration failed - token_hash index not found')
    }

    // Commit transaction
    await pool.query('COMMIT')

    console.log('\n✅ Migration 013 completed successfully!')
    console.log('- Renamed token column to token_hash')
    console.log('- Changed type to CHAR(64) for SHA-256 hashes')
    console.log('- Updated unique index')
    console.log('- All existing sessions were cleared')
    console.log('\n⚠️  IMPORTANT: All users will need to log in again')
  } catch (error) {
    // Rollback on error
    await pool.query('ROLLBACK')
    console.error('\n❌ Migration 013 failed:', error)
    throw error
  } finally {
    // Close the connection
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
