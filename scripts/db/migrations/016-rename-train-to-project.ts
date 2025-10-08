#!/usr/bin/env bun
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
    console.log('Starting train to project terminology migration (016)...')
    await client.query('BEGIN')

    // Rename tables
    console.log('Renaming projects table to projects...')
    await client.query(`
      ALTER TABLE IF EXISTS projects RENAME TO projects
    `)

    console.log('Renaming train_accounts table to project_accounts...')
    await client.query(`
      ALTER TABLE IF EXISTS train_accounts RENAME TO project_accounts
    `)

    console.log('Renaming train_api_keys table to project_api_keys...')
    await client.query(`
      ALTER TABLE IF EXISTS train_api_keys RENAME TO project_api_keys
    `)

    console.log('Renaming train_members table to project_members...')
    await client.query(`
      ALTER TABLE IF EXISTS train_members RENAME TO project_members
    `)

    // Note: Column renames train_id -> project_id were already done in migration 013
    // The tables were created with project_id from the start due to sed replacements

    // Rename indexes
    console.log('Renaming indexes...')
    await client.query(`
      ALTER INDEX IF EXISTS idx_trains_train_id
      RENAME TO idx_projects_project_id
    `)

    await client.query(`
      ALTER INDEX IF EXISTS idx_train_accounts_train
      RENAME TO idx_project_accounts_project
    `)

    await client.query(`
      ALTER INDEX IF EXISTS idx_train_accounts_credential
      RENAME TO idx_project_accounts_credential
    `)

    await client.query(`
      ALTER INDEX IF EXISTS idx_train_api_keys_train
      RENAME TO idx_project_api_keys_project
    `)

    await client.query(`
      ALTER INDEX IF EXISTS idx_train_api_keys_key
      RENAME TO idx_project_api_keys_key
    `)

    await client.query(`
      ALTER INDEX IF EXISTS idx_train_members_train_id
      RENAME TO idx_project_members_project_id
    `)

    await client.query(`
      ALTER INDEX IF EXISTS idx_train_members_user_email
      RENAME TO idx_project_members_user_email
    `)

    await client.query(`
      ALTER INDEX IF EXISTS idx_train_members_role
      RENAME TO idx_project_members_role
    `)

    await client.query(`
      ALTER INDEX IF EXISTS idx_requests_train_id
      RENAME TO idx_requests_project_id
    `)

    await client.query(`
      ALTER INDEX IF EXISTS idx_conversations_train_id
      RENAME TO idx_conversations_project_id
    `)

    await client.query(`
      ALTER INDEX IF EXISTS idx_subtasks_train_id
      RENAME TO idx_subtasks_project_id
    `)

    await client.query(`
      ALTER INDEX IF EXISTS idx_token_usage_train_id
      RENAME TO idx_token_usage_project_id
    `)

    await client.query('COMMIT')
    console.log('Train to project terminology migration completed successfully.')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Migration failed:', error)
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
