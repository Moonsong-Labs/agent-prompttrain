#!/usr/bin/env bun

/**
 * Migration: Add the conversation_summaries table (ADR-039)
 *
 * One row per conversation and project with its first and last activity and the accounts used.
 * The proxy upserts it for every stored request and
 * scripts/db/backfill-conversation-summaries.ts fills it from history, so GET /api/conversations
 * can select pages and count totals from it when CONVERSATION_SUMMARIES_ENABLED=true.
 * Created empty, so it is effectively instant.
 */

import { Pool } from 'pg'

const EXPECTED_INDEXES = [
  'conversation_summaries_pkey',
  'idx_conversation_summaries_account_ids',
  'idx_conversation_summaries_last_activity',
  'idx_conversation_summaries_project_last_activity',
]

async function up(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    // Never queue behind long-running queries
    await client.query("SET LOCAL lock_timeout = '5s'")

    console.log('Creating conversation_summaries...')

    await client.query(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        conversation_id   UUID         NOT NULL,
        project_id        VARCHAR(255) NOT NULL,
        first_activity_at TIMESTAMPTZ  NOT NULL,
        last_activity_at  TIMESTAMPTZ  NOT NULL,
        account_ids       TEXT[]       NOT NULL DEFAULT '{}',
        PRIMARY KEY (conversation_id, project_id)
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_conversation_summaries_last_activity
        ON conversation_summaries (last_activity_at DESC, conversation_id DESC)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_conversation_summaries_project_last_activity
        ON conversation_summaries (project_id, last_activity_at DESC, conversation_id DESC)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_conversation_summaries_account_ids
        ON conversation_summaries USING GIN (account_ids)
    `)
    console.log('✓ Created table and indexes')

    const result = await client.query(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'conversation_summaries'
         AND indexname = ANY($1)`,
      [EXPECTED_INDEXES]
    )

    if (result.rows.length !== EXPECTED_INDEXES.length) {
      throw new Error(
        'Verification failed: conversation_summaries or one of its indexes is missing'
      )
    }

    console.log('✓ Verified table and indexes exist')

    await client.query('COMMIT')
    console.log('✅ conversation_summaries created successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to create conversation_summaries:', error)
    throw error
  } finally {
    client.release()
  }
}

async function down(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout = '5s'")

    console.log('Dropping conversation_summaries...')

    await client.query('DROP TABLE IF EXISTS conversation_summaries')

    await client.query('COMMIT')
    console.log('✅ conversation_summaries dropped successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to drop conversation_summaries:', error)
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

export { up, down }
