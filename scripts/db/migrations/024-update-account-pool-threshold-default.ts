#!/usr/bin/env bun

/**
 * Migration: Raise the default token_limit_threshold from 0.80 to 0.95
 *
 * Migration 018 introduced the per-account `token_limit_threshold` column
 * (account pool auto-switching, see ADR-031) with a default of 0.80. This
 * migration raises that default to 0.95 so accounts run closer to their limit
 * before the pool switches to an alternative.
 *
 * Because migration 018 already ran on existing databases, this migration:
 *   1. Changes the column DEFAULT so newly-inserted credentials use 0.95.
 *   2. Migrates existing rows that are still at the old 0.80 default to 0.95.
 *      Rows with a customized value are left untouched (only rows exactly at
 *      the old default are updated).
 */

import { Pool } from 'pg'

const OLD_DEFAULT = '0.80'
const NEW_DEFAULT = '0.95'

async function up(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log(`Updating token_limit_threshold default ${OLD_DEFAULT} -> ${NEW_DEFAULT}...`)

    // Step 1: Change the column default for newly-inserted credentials
    await client.query(`
      ALTER TABLE credentials
      ALTER COLUMN token_limit_threshold SET DEFAULT ${NEW_DEFAULT}
    `)
    console.log(`✓ Set token_limit_threshold column default to ${NEW_DEFAULT}`)

    // Step 2: Migrate existing rows still at the old default (custom values kept)
    const updateResult = await client.query(
      `
      UPDATE credentials
      SET token_limit_threshold = $1
      WHERE token_limit_threshold = $2
    `,
      [NEW_DEFAULT, OLD_DEFAULT]
    )
    console.log(
      `✓ Migrated ${updateResult.rowCount ?? 0} existing account(s) from ${OLD_DEFAULT} to ${NEW_DEFAULT}`
    )

    // Step 3: Verify the new default is in place
    const result = await client.query(`
      SELECT column_default
      FROM information_schema.columns
      WHERE table_name = 'credentials'
        AND column_name = 'token_limit_threshold'
    `)

    const columnDefault = result.rows[0]?.column_default as string | undefined
    if (!columnDefault || !columnDefault.includes(NEW_DEFAULT)) {
      throw new Error(
        `Verification failed: expected default ${NEW_DEFAULT}, found ${columnDefault ?? 'none'}`
      )
    }

    console.log('✓ Verified column default:', columnDefault)

    await client.query('COMMIT')
    console.log(`✅ token_limit_threshold default raised to ${NEW_DEFAULT} successfully`)
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to update token_limit_threshold default:', error)
    throw error
  } finally {
    client.release()
  }
}

async function down(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log(`Reverting token_limit_threshold default ${NEW_DEFAULT} -> ${OLD_DEFAULT}...`)

    // Restore the previous column default
    await client.query(`
      ALTER TABLE credentials
      ALTER COLUMN token_limit_threshold SET DEFAULT ${OLD_DEFAULT}
    `)
    console.log(`✓ Restored token_limit_threshold column default to ${OLD_DEFAULT}`)

    // Best-effort inverse: move rows still at the new default back to the old one
    const updateResult = await client.query(
      `
      UPDATE credentials
      SET token_limit_threshold = $1
      WHERE token_limit_threshold = $2
    `,
      [OLD_DEFAULT, NEW_DEFAULT]
    )
    console.log(
      `✓ Reverted ${updateResult.rowCount ?? 0} account(s) from ${NEW_DEFAULT} to ${OLD_DEFAULT}`
    )

    await client.query('COMMIT')
    console.log(`✅ token_limit_threshold default reverted to ${OLD_DEFAULT} successfully`)
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to revert token_limit_threshold default:', error)
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
