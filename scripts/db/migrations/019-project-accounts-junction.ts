#!/usr/bin/env bun

/**
 * Migration: Create project_accounts junction table
 *
 * This migration creates the many-to-many junction table linking projects
 * to credentials, enabling the account pool auto-switching feature.
 * When a project has 2+ linked accounts, the proxy automatically selects
 * the least-utilized account under its threshold.
 */

import { Pool } from 'pg'

async function up(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log('Creating project_accounts junction table...')

    // Step 1: Create the junction table (idempotent)
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_accounts (
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        credential_id UUID NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (project_id, credential_id)
      )
    `)
    console.log('✓ Created project_accounts table')

    // Step 2: Create index for credential lookups (idempotent)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_project_accounts_credential_id
      ON project_accounts(credential_id)
    `)
    console.log('✓ Created credential_id index')

    // Step 3: Verify table was created
    const result = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_name = 'project_accounts'
        AND table_schema = 'public'
    `)

    if (result.rows.length === 0) {
      throw new Error('Verification failed: project_accounts table not found')
    }

    console.log('✓ Verified table exists')

    await client.query('COMMIT')
    console.log('✅ project_accounts junction table created successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to create project_accounts:', error)
    throw error
  } finally {
    client.release()
  }
}

async function down(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log('Dropping project_accounts junction table...')

    await client.query('DROP TABLE IF EXISTS project_accounts')
    console.log('✓ Dropped project_accounts table')

    await client.query('COMMIT')
    console.log('✅ project_accounts junction table dropped successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to drop project_accounts:', error)
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
