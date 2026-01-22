#!/usr/bin/env bun

/**
 * Migration: Add indexes for conversation content search
 *
 * This migration adds indexes to optimize JSONB content search queries
 * for the conversation search feature.
 */

import { Pool } from 'pg'

async function up(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log('Adding indexes for conversation content search...')

    // GIN index on body column for JSONB search (mirrors response_body)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_requests_body_gin
      ON api_requests USING GIN (body)
    `)
    console.log('✓ Created idx_api_requests_body_gin')

    // Index for conversation grouping optimization
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_requests_conversation_id
      ON api_requests(conversation_id)
      WHERE conversation_id IS NOT NULL
    `)
    console.log('✓ Created idx_api_requests_conversation_id')

    // Analyze the table to update statistics
    console.log('Analyzing api_requests table to update statistics...')
    await client.query('ANALYZE api_requests')
    console.log('✓ Table analyzed')

    await client.query('COMMIT')
    console.log('✅ Conversation search indexes created successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to create search indexes:', error)
    throw error
  } finally {
    client.release()
  }
}

async function down(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log('Removing conversation search indexes...')

    await client.query('DROP INDEX IF EXISTS idx_api_requests_body_gin')
    await client.query('DROP INDEX IF EXISTS idx_api_requests_conversation_id')

    await client.query('COMMIT')
    console.log('✅ Search indexes removed successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to remove search indexes:', error)
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
