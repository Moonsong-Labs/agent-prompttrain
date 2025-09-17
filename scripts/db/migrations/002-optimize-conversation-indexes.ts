#!/usr/bin/env bun
import { Pool } from 'pg'

/**
 * Optimization script for conversation queries - adds performance indexes
 */
async function optimizeConversationIndexes() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })

  try {
    console.log('Starting conversation index optimization...')

    // Start transaction
    await pool.query('BEGIN')

    // Create composite index for conversation queries
    console.log('Creating composite index for conversation queries...')
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_requests_conversation_timestamp 
      ON api_requests(conversation_id, timestamp) 
      WHERE conversation_id IS NOT NULL
    `)

    // Create covering index with commonly needed fields
    console.log('Creating covering index for conversation details...')
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_requests_conversation_detail
      ON api_requests(conversation_id, timestamp, request_id, domain, model, total_tokens, branch_id) 
      WHERE conversation_id IS NOT NULL
    `)

    // Analyze table to update statistics
    console.log('Analyzing api_requests table to update statistics...')
    await pool.query('ANALYZE api_requests')

    // Check current indexes
    console.log('Checking current indexes on api_requests...')
    const indexesResult = await pool.query(`
      SELECT 
        schemaname,
        tablename,
        indexname,
        indexdef
      FROM pg_indexes
      WHERE tablename = 'api_requests'
      ORDER BY indexname
    `)

    console.log(`Found ${indexesResult.rowCount} indexes on api_requests table`)

    // Check for the specific indexes we created
    const createdIndexes = indexesResult.rows.filter(
      row =>
        row.indexname === 'idx_requests_conversation_timestamp' ||
        row.indexname === 'idx_requests_conversation_detail'
    )

    if (createdIndexes.length < 2) {
      throw new Error('Not all expected indexes were created')
    }

    // Get table statistics
    console.log('Checking table statistics...')
    const statsResult = await pool.query(`
      SELECT 
        schemaname,
        tablename,
        n_live_tup as row_count,
        n_dead_tup as dead_rows,
        last_vacuum,
        last_autovacuum,
        last_analyze,
        last_autoanalyze
      FROM pg_stat_user_tables
      WHERE tablename = 'api_requests'
    `)

    if (statsResult.rows.length > 0) {
      const stats = statsResult.rows[0]
      console.log(`Table statistics:`)
      console.log(`  - Live rows: ${stats.row_count}`)
      console.log(`  - Dead rows: ${stats.dead_rows}`)
      console.log(`  - Last analyze: ${stats.last_analyze || stats.last_autoanalyze || 'Never'}`)
    }

    // Commit transaction
    await pool.query('COMMIT')
    console.log('Conversation index optimization completed successfully!')
    console.log('✅ All performance indexes created and table analyzed')
  } catch (error) {
    // Rollback on error
    await pool.query('ROLLBACK')
    console.error(
      'Index optimization failed:',
      error instanceof Error ? error.message : String(error)
    )
    process.exit(1)
  } finally {
    await pool.end()
  }
}

// Run optimization
optimizeConversationIndexes().catch(console.error)
