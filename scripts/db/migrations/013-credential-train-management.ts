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
    console.log('Starting credential and train management migration (013)...')
    await client.query('BEGIN')

    // Create anthropic_credentials table
    console.log('Creating anthropic_credentials table...')
    await client.query(`
      CREATE TABLE IF NOT EXISTS anthropic_credentials (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id VARCHAR(255) UNIQUE NOT NULL,
        account_name VARCHAR(255) UNIQUE NOT NULL,
        oauth_access_token TEXT NOT NULL,
        oauth_refresh_token TEXT NOT NULL,
        oauth_expires_at TIMESTAMPTZ NOT NULL,
        oauth_scopes TEXT[] NOT NULL,
        oauth_is_max BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        last_refresh_at TIMESTAMPTZ
      )
    `)

    console.log('Creating index on anthropic_credentials.account_id...')
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_credentials_account_id
      ON anthropic_credentials(account_id)
    `)

    // Create trains table
    console.log('Creating trains table...')
    await client.query(`
      CREATE TABLE IF NOT EXISTS trains (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        train_id VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        slack_enabled BOOLEAN DEFAULT false,
        slack_webhook_url TEXT,
        slack_channel VARCHAR(255),
        slack_username VARCHAR(255),
        slack_icon_emoji VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)

    console.log('Creating index on trains.train_id...')
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_trains_train_id
      ON trains(train_id)
    `)

    // Create train_accounts junction table
    console.log('Creating train_accounts junction table...')
    await client.query(`
      CREATE TABLE IF NOT EXISTS train_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        train_id UUID NOT NULL REFERENCES trains(id) ON DELETE CASCADE,
        credential_id UUID NOT NULL REFERENCES anthropic_credentials(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(train_id, credential_id)
      )
    `)

    console.log('Creating indexes on train_accounts...')
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_train_accounts_train
      ON train_accounts(train_id)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_train_accounts_credential
      ON train_accounts(credential_id)
    `)

    // Create train_api_keys table
    console.log('Creating train_api_keys table...')
    await client.query(`
      CREATE TABLE IF NOT EXISTS train_api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        train_id UUID NOT NULL REFERENCES trains(id) ON DELETE CASCADE,
        api_key TEXT UNIQUE NOT NULL,
        key_prefix VARCHAR(20) NOT NULL,
        key_suffix VARCHAR(10) NOT NULL,
        name VARCHAR(255),
        created_by VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        revoked_by VARCHAR(255)
      )
    `)

    console.log('Creating indexes on train_api_keys...')
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_train_api_keys_train
      ON train_api_keys(train_id)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_train_api_keys_key
      ON train_api_keys(api_key) WHERE revoked_at IS NULL
    `)

    await client.query('COMMIT')
    console.log('Credential and train management migration completed successfully.')
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
