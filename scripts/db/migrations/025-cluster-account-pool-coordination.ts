#!/usr/bin/env bun

/**
 * Migration: Coordinate account-pool state across proxy instances.
 *
 * Adds independent five-hour and seven-day thresholds plus PostgreSQL-backed
 * usage refresh leases, account/model cooldowns, project affinity, and
 * in-flight request counters. The legacy token_limit_threshold column is kept
 * for rolling-deployment compatibility.
 */

import { Pool } from 'pg'

async function up(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    await client.query(`
      ALTER TABLE credentials
        ADD COLUMN IF NOT EXISTS five_hour_limit_threshold DECIMAL(3,2) NOT NULL DEFAULT 0.90,
        ADD COLUMN IF NOT EXISTS seven_day_limit_threshold DECIMAL(3,2) NOT NULL DEFAULT 0.95
    `)

    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'credentials_five_hour_limit_threshold_check'
        ) THEN
          ALTER TABLE credentials
            ADD CONSTRAINT credentials_five_hour_limit_threshold_check
            CHECK (five_hour_limit_threshold > 0 AND five_hour_limit_threshold <= 1);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'credentials_seven_day_limit_threshold_check'
        ) THEN
          ALTER TABLE credentials
            ADD CONSTRAINT credentials_seven_day_limit_threshold_check
            CHECK (seven_day_limit_threshold > 0 AND seven_day_limit_threshold <= 1);
        END IF;
      END $$
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS account_pool_account_state (
        credential_id UUID PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
        usage JSONB,
        usage_fetched_at TIMESTAMPTZ,
        usage_next_refresh_at TIMESTAMPTZ,
        usage_refresh_lease_until TIMESTAMPTZ,
        usage_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_failure_count >= 0),
        usage_last_force_refresh_at TIMESTAMPTZ,
        in_flight_requests INTEGER NOT NULL DEFAULT 0 CHECK (in_flight_requests >= 0),
        in_flight_updated_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    await client.query(`
      ALTER TABLE account_pool_account_state
      ADD COLUMN IF NOT EXISTS in_flight_updated_at TIMESTAMPTZ
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS account_pool_model_cooldowns (
        credential_id UUID NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
        model VARCHAR(255) NOT NULL,
        cooldown_until TIMESTAMPTZ NOT NULL,
        reason TEXT,
        retry_after_seconds INTEGER CHECK (retry_after_seconds IS NULL OR retry_after_seconds >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (credential_id, model)
      )
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_account_pool_cooldowns_active
      ON account_pool_model_cooldowns (model, cooldown_until)
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS account_pool_project_affinity (
        project_id VARCHAR(255) PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
        credential_id UUID NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_account_pool_affinity_credential
      ON account_pool_project_affinity (credential_id)
    `)

    await client.query('COMMIT')
    console.log('✅ Cluster account-pool coordination schema created successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to create cluster account-pool coordination schema:', error)
    throw error
  } finally {
    client.release()
  }
}

async function down(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    await client.query('DROP TABLE IF EXISTS account_pool_project_affinity')
    await client.query('DROP TABLE IF EXISTS account_pool_model_cooldowns')
    await client.query('DROP TABLE IF EXISTS account_pool_account_state')
    await client.query(`
      ALTER TABLE credentials
        DROP CONSTRAINT IF EXISTS credentials_five_hour_limit_threshold_check,
        DROP CONSTRAINT IF EXISTS credentials_seven_day_limit_threshold_check,
        DROP COLUMN IF EXISTS five_hour_limit_threshold,
        DROP COLUMN IF EXISTS seven_day_limit_threshold
    `)
    await client.query('COMMIT')
    console.log('✅ Cluster account-pool coordination schema removed successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to remove cluster account-pool coordination schema:', error)
    throw error
  } finally {
    client.release()
  }
}

async function main(): Promise<void> {
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
      throw new Error(`Unknown action: ${action}. Use 'up' or 'down'`)
    }
  } finally {
    await pool.end()
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error('❌ Migration failed:', error)
    process.exit(1)
  })
}
