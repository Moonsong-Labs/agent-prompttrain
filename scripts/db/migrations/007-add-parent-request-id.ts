#!/usr/bin/env bun

import { Pool } from 'pg'
import dotenv from 'dotenv'
import path from 'path'

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env') })

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

async function migrate() {
  const client = await pool.connect()

  try {
    console.log('Starting migration 007: Add parent_request_id column...')

    await client.query('BEGIN')

    // Add parent_request_id column
    console.log('Adding parent_request_id column to api_requests table...')
    await client.query(`
      ALTER TABLE api_requests 
      ADD COLUMN IF NOT EXISTS parent_request_id UUID REFERENCES api_requests(request_id);
    `)

    // Create index for parent_request_id
    console.log('Creating index on parent_request_id...')
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_requests_parent_request_id 
      ON api_requests(parent_request_id);
    `)

    // Add comment to document the column
    await client.query(`
      COMMENT ON COLUMN api_requests.parent_request_id IS 
      'UUID of the parent request in the conversation chain, references the immediate parent';
    `)

    // Populate parent_request_id for existing conversations
    console.log('Populating parent_request_id for existing conversations...')

    // This query finds parent requests by matching parent_message_hash with current_message_hash
    // We only populate where parent_request_id is NULL to avoid overwriting existing data
    const updateQuery = `
      WITH parent_mapping AS (
        SELECT 
          child.request_id AS child_id,
          parent.request_id AS parent_id
        FROM api_requests child
        INNER JOIN api_requests parent ON 
          child.domain = parent.domain 
          AND child.parent_message_hash = parent.current_message_hash
          AND child.conversation_id = parent.conversation_id
          AND child.request_id != parent.request_id
        WHERE child.parent_message_hash IS NOT NULL
          AND child.parent_request_id IS NULL
      )
      UPDATE api_requests
      SET parent_request_id = parent_mapping.parent_id
      FROM parent_mapping
      WHERE api_requests.request_id = parent_mapping.child_id;
    `

    const result = await client.query(updateQuery)
    console.log(`Updated ${result.rowCount} records with parent_request_id`)

    // Add constraint to ensure parent_request_id != request_id
    console.log('Adding check constraint to prevent self-referencing...')
    await client.query(`
      ALTER TABLE api_requests
      ADD CONSTRAINT chk_parent_request_not_self
      CHECK (parent_request_id != request_id);
    `)

    await client.query('COMMIT')
    console.log('Migration 007 completed successfully!')

    // Report statistics
    const stats = await client.query(`
      SELECT 
        COUNT(*) FILTER (WHERE parent_request_id IS NOT NULL) as with_parent,
        COUNT(*) FILTER (WHERE parent_request_id IS NULL AND parent_message_hash IS NOT NULL) as missing_parent,
        COUNT(*) as total
      FROM api_requests
    `)
    console.log('Statistics:', stats.rows[0])
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Migration 007 failed:', error)
    throw error
  } finally {
    client.release()
  }
}

// Rollback function for reversibility
async function rollback() {
  const client = await pool.connect()

  try {
    console.log('Rolling back migration 007...')

    await client.query('BEGIN')

    // Drop constraint first
    await client.query(
      'ALTER TABLE api_requests DROP CONSTRAINT IF EXISTS chk_parent_request_not_self;'
    )

    // Drop index
    await client.query('DROP INDEX IF EXISTS idx_api_requests_parent_request_id;')

    // Drop column
    await client.query('ALTER TABLE api_requests DROP COLUMN IF EXISTS parent_request_id;')

    await client.query('COMMIT')
    console.log('Rollback 007 completed successfully!')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Rollback 007 failed:', error)
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
