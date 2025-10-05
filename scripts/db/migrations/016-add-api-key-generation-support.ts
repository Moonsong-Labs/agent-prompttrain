#!/usr/bin/env bun
import { Pool } from 'pg'

/**
 * Migration 016: Add API key generation support
 *
 * Adds columns to track generated API keys and enable revocation:
 * - is_generated: Boolean flag to distinguish generated vs manually-added keys
 * - key_hash: SHA-256 hash of the API key for display and revocation without decryption
 * - revoked_at: Timestamp for soft deletion/revocation
 *
 * This migration is idempotent and can be run multiple times safely.
 */
async function addApiKeyGenerationSupport() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  try {
    await pool.query('BEGIN')

    console.log('Adding API key generation support columns to accounts table...')

    // Add is_generated column
    const isGeneratedCheck = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = 'accounts'
      AND column_name = 'is_generated'
    `)

    if (isGeneratedCheck.rowCount === 0) {
      console.log('  Adding is_generated column...')
      await pool.query(`
        ALTER TABLE accounts
        ADD COLUMN is_generated BOOLEAN NOT NULL DEFAULT FALSE
      `)
      console.log('  ✓ Added is_generated column')
    } else {
      console.log('  is_generated column already exists, skipping')
    }

    // Add key_hash column for SHA-256 hash (64 hex characters)
    const keyHashCheck = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = 'accounts'
      AND column_name = 'key_hash'
    `)

    if (keyHashCheck.rowCount === 0) {
      console.log('  Adding key_hash column...')
      await pool.query(`
        ALTER TABLE accounts
        ADD COLUMN key_hash VARCHAR(64)
      `)
      console.log('  ✓ Added key_hash column')
    } else {
      console.log('  key_hash column already exists, skipping')
    }

    // Add revoked_at column for soft deletion
    const revokedAtCheck = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = 'accounts'
      AND column_name = 'revoked_at'
    `)

    if (revokedAtCheck.rowCount === 0) {
      console.log('  Adding revoked_at column...')
      await pool.query(`
        ALTER TABLE accounts
        ADD COLUMN revoked_at TIMESTAMP
      `)
      console.log('  ✓ Added revoked_at column')
    } else {
      console.log('  revoked_at column already exists, skipping')
    }

    // Add index on key_hash for efficient lookups
    const indexCheck = await pool.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'accounts'
      AND indexname = 'idx_accounts_key_hash'
    `)

    if (indexCheck.rowCount === 0) {
      console.log('  Creating index on key_hash...')
      await pool.query(`
        CREATE INDEX idx_accounts_key_hash ON accounts(key_hash)
        WHERE key_hash IS NOT NULL
      `)
      console.log('  ✓ Created index on key_hash')
    } else {
      console.log('  Index on key_hash already exists, skipping')
    }

    // Verify all columns exist
    const verifyCheck = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = 'accounts'
      AND column_name IN ('is_generated', 'key_hash', 'revoked_at')
      ORDER BY column_name
    `)

    if (verifyCheck.rowCount !== 3) {
      throw new Error(
        `Expected 3 new columns, found ${verifyCheck.rowCount}: ${verifyCheck.rows.map(r => r.column_name).join(', ')}`
      )
    }

    console.log('✓ Migration 016 completed successfully!')

    await pool.query('COMMIT')
  } catch (error) {
    await pool.query('ROLLBACK')
    console.error('Migration 016 failed:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

addApiKeyGenerationSupport().catch(console.error)
