#!/usr/bin/env bun

/**
 * Migration 013: Remove streaming_chunks Table
 *
 * This migration removes the unused streaming_chunks table and its indexes.
 * The streaming chunks feature was never fully implemented - while the table
 * and write infrastructure existed, no code ever called the write methods,
 * resulting in an empty table in production.
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
    console.log('Starting migration 013: Remove streaming_chunks table...')
    await client.query('BEGIN')

    // Check if table exists and has any data
    const countResult = await client.query(`
      SELECT COUNT(*) as count
      FROM streaming_chunks
      WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'streaming_chunks')
    `)

    const rowCount = countResult.rows[0]?.count || 0
    if (rowCount > 0) {
      console.warn(
        `⚠️  Warning: streaming_chunks table contains ${rowCount} rows. This data will be deleted.`
      )
    } else {
      console.log('✓ streaming_chunks table is empty (as expected)')
    }

    // Drop indexes first
    await client.query(`
      DROP INDEX IF EXISTS idx_streaming_chunks_request_id
    `)
    console.log('✓ Dropped idx_streaming_chunks_request_id')

    await client.query(`
      DROP INDEX IF EXISTS idx_streaming_chunks_request_chunk
    `)
    console.log('✓ Dropped idx_streaming_chunks_request_chunk')

    // Drop the table
    await client.query(`
      DROP TABLE IF EXISTS streaming_chunks
    `)
    console.log('✓ Dropped streaming_chunks table')

    await client.query('COMMIT')
    console.log('\n✅ Migration 013 completed successfully!')
    console.log('   - Removed streaming_chunks table')
    console.log('   - Removed associated indexes')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Migration failed:', error)
    process.exitCode = 1
  } finally {
    client.release()
    await pool.end()
  }
}

migrate().catch(err => {
  console.error('Migration execution error:', err)
  process.exit(1)
})
