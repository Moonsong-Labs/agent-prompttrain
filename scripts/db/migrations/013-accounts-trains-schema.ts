#!/usr/bin/env bun
import { Pool } from 'pg'

/**
 * Migration 013: Create accounts and trains tables for database-backed credential management
 *
 * This migration creates the schema for storing account credentials and train configurations
 * in the database instead of filesystem files. Follows ADR-026.
 */
async function migrateAccountsTrainsSchema() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  try {
    await pool.query('BEGIN')

    console.log('Creating accounts table...')
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        account_id VARCHAR(255) PRIMARY KEY,
        account_name VARCHAR(255) UNIQUE NOT NULL,
        credential_type VARCHAR(20) NOT NULL CHECK (credential_type IN ('api_key', 'oauth')),

        -- Encrypted credentials (base64-encoded ciphertext)
        api_key_encrypted TEXT,
        oauth_access_token_encrypted TEXT,
        oauth_refresh_token_encrypted TEXT,
        oauth_expires_at BIGINT,
        oauth_scopes TEXT[],
        oauth_is_max BOOLEAN DEFAULT false,

        -- Audit and metadata
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        last_used_at TIMESTAMPTZ,

        -- Constraint: ensure proper credentials based on type
        CONSTRAINT api_key_required CHECK (
          (credential_type = 'api_key' AND api_key_encrypted IS NOT NULL) OR
          (credential_type = 'oauth' AND oauth_access_token_encrypted IS NOT NULL AND oauth_refresh_token_encrypted IS NOT NULL)
        )
      )
    `)

    console.log('Creating trains table...')
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trains (
        train_id VARCHAR(255) PRIMARY KEY,
        description TEXT,

        -- Client API keys (SHA-256 hashed for security)
        client_api_keys_hashed TEXT[],

        -- Slack configuration (moved from accounts - per train)
        slack_config JSONB,

        -- Configuration
        default_account_id VARCHAR(255),
        is_active BOOLEAN DEFAULT true,

        -- Audit
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),

        -- Foreign key to accounts (nullable - can be set later)
        CONSTRAINT fk_default_account FOREIGN KEY (default_account_id)
          REFERENCES accounts(account_id) ON DELETE SET NULL
      )
    `)

    console.log('Creating train_account_mappings table...')
    await pool.query(`
      CREATE TABLE IF NOT EXISTS train_account_mappings (
        train_id VARCHAR(255) NOT NULL,
        account_id VARCHAR(255) NOT NULL,
        priority INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),

        PRIMARY KEY (train_id, account_id),

        CONSTRAINT fk_mapping_train FOREIGN KEY (train_id)
          REFERENCES trains(train_id) ON DELETE CASCADE,
        CONSTRAINT fk_mapping_account FOREIGN KEY (account_id)
          REFERENCES accounts(account_id) ON DELETE CASCADE
      )
    `)

    console.log('Creating indexes...')

    // Accounts indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_accounts_type
      ON accounts(credential_type)
    `)

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_accounts_active
      ON accounts(is_active)
      WHERE is_active = true
    `)

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_accounts_last_used
      ON accounts(last_used_at DESC NULLS LAST)
    `)

    // Trains indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_trains_active
      ON trains(is_active)
      WHERE is_active = true
    `)

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_trains_default_account
      ON trains(default_account_id)
      WHERE default_account_id IS NOT NULL
    `)

    // Train-account mappings indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_train_mappings_train
      ON train_account_mappings(train_id)
    `)

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_train_mappings_account
      ON train_account_mappings(account_id)
    `)

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_train_mappings_priority
      ON train_account_mappings(train_id, priority)
    `)

    console.log('Verifying table creation...')
    const tableCheck = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN ('accounts', 'trains', 'train_account_mappings')
      ORDER BY table_name
    `)

    const expectedTables = ['accounts', 'train_account_mappings', 'trains']
    const foundTables = tableCheck.rows.map(row => row.table_name)

    if (foundTables.length !== expectedTables.length) {
      throw new Error(
        `Expected ${expectedTables.length} tables but found ${foundTables.length}: ${foundTables.join(', ')}`
      )
    }

    console.log(`✓ All tables created successfully: ${foundTables.join(', ')}`)

    // Verify indexes
    const indexCheck = await pool.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
      AND tablename IN ('accounts', 'trains', 'train_account_mappings')
      AND indexname LIKE 'idx_%'
      ORDER BY indexname
    `)

    console.log(`✓ Created ${indexCheck.rows.length} indexes`)

    await pool.query('COMMIT')
    console.log('Migration 013 completed successfully!')
  } catch (error) {
    await pool.query('ROLLBACK')
    console.error('Migration 013 failed:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

migrateAccountsTrainsSchema().catch(console.error)
