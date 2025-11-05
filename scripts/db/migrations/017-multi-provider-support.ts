#!/usr/bin/env bun

/**
 * Migration: Add multi-provider support (Anthropic + AWS Bedrock)
 *
 * This migration transforms the anthropic_credentials table into a unified
 * credentials table that supports both Anthropic OAuth and AWS Bedrock API keys.
 */

import { Pool } from 'pg'

async function up(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log('Adding multi-provider support...')

    // Step 1: Rename anthropic_credentials to credentials
    await client.query(`
      ALTER TABLE anthropic_credentials RENAME TO credentials
    `)
    console.log('✓ Renamed anthropic_credentials to credentials')

    // Step 2: Add provider column with default 'anthropic' for existing records
    await client.query(`
      ALTER TABLE credentials
      ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic'
    `)
    console.log('✓ Added provider column')

    // Step 3: Make OAuth columns nullable (not needed for Bedrock)
    await client.query(`
      ALTER TABLE credentials
      ALTER COLUMN oauth_access_token DROP NOT NULL,
      ALTER COLUMN oauth_refresh_token DROP NOT NULL,
      ALTER COLUMN oauth_expires_at DROP NOT NULL,
      ALTER COLUMN oauth_scopes DROP NOT NULL,
      ALTER COLUMN oauth_is_max DROP NOT NULL
    `)
    console.log('✓ Made OAuth columns nullable')

    // Step 4: Add AWS Bedrock columns (nullable, only needed for Bedrock)
    await client.query(`
      ALTER TABLE credentials
      ADD COLUMN aws_api_key TEXT,
      ADD COLUMN aws_region TEXT DEFAULT 'us-east-1'
    `)
    console.log('✓ Added AWS Bedrock columns')

    // Step 5: Add check constraint to ensure correct fields are populated
    await client.query(`
      ALTER TABLE credentials
      ADD CONSTRAINT credentials_provider_check CHECK (
        (provider = 'anthropic' AND oauth_access_token IS NOT NULL) OR
        (provider = 'bedrock' AND aws_api_key IS NOT NULL)
      )
    `)
    console.log('✓ Added provider validation constraint')

    // Step 6: Create index on provider for efficient queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_credentials_provider
      ON credentials(provider)
    `)
    console.log('✓ Created provider index')

    // Step 7: Update foreign key references in project_accounts
    // (Foreign keys are automatically updated with table rename)
    console.log('✓ Foreign keys updated automatically')

    await client.query('COMMIT')
    console.log('✅ Multi-provider support added successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to add multi-provider support:', error)
    throw error
  } finally {
    client.release()
  }
}

async function down(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log('Reverting multi-provider support...')

    // Remove Bedrock-only records first
    await client.query(`
      DELETE FROM credentials WHERE provider = 'bedrock'
    `)
    console.log('✓ Removed Bedrock credentials')

    // Drop constraint
    await client.query(`
      ALTER TABLE credentials
      DROP CONSTRAINT IF EXISTS credentials_provider_check
    `)
    console.log('✓ Removed provider constraint')

    // Drop Bedrock columns
    await client.query(`
      ALTER TABLE credentials
      DROP COLUMN IF EXISTS aws_api_key,
      DROP COLUMN IF EXISTS aws_region
    `)
    console.log('✓ Removed AWS columns')

    // Drop provider column
    await client.query(`
      ALTER TABLE credentials
      DROP COLUMN IF EXISTS provider
    `)
    console.log('✓ Removed provider column')

    // Restore NOT NULL constraints on OAuth columns
    await client.query(`
      ALTER TABLE credentials
      ALTER COLUMN oauth_access_token SET NOT NULL,
      ALTER COLUMN oauth_refresh_token SET NOT NULL,
      ALTER COLUMN oauth_expires_at SET NOT NULL,
      ALTER COLUMN oauth_scopes SET NOT NULL,
      ALTER COLUMN oauth_is_max SET NOT NULL
    `)
    console.log('✓ Restored OAuth NOT NULL constraints')

    // Drop index
    await client.query(`
      DROP INDEX IF EXISTS idx_credentials_provider
    `)
    console.log('✓ Removed provider index')

    // Rename back to anthropic_credentials
    await client.query(`
      ALTER TABLE credentials RENAME TO anthropic_credentials
    `)
    console.log('✓ Renamed back to anthropic_credentials')

    await client.query('COMMIT')
    console.log('✅ Multi-provider support reverted successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to revert multi-provider support:', error)
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
