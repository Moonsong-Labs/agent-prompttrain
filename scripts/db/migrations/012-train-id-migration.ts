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
    console.log('Starting train ID migration (012)...')
    await client.query('BEGIN')

    console.log('Renaming api_requests.domain to train_id...')
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'api_requests' AND column_name = 'domain'
        ) THEN
          ALTER TABLE api_requests RENAME COLUMN domain TO train_id;
        END IF;
      END
      $$;
    `)

    console.log('Renaming analysis_audit_log.domain to train_id...')
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'analysis_audit_log' AND column_name = 'domain'
        ) THEN
          ALTER TABLE analysis_audit_log RENAME COLUMN domain TO train_id;
        END IF;
      END
      $$;
    `)

    console.log('Updating materialized view hourly_stats...')
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'hourly_stats' AND column_name = 'domain'
        ) THEN
          ALTER MATERIALIZED VIEW hourly_stats RENAME COLUMN domain TO train_id;
        END IF;
      END
      $$;
    `)

    console.log('Renaming indexes...')
    const indexRenames: Array<{ from: string; to: string }> = [
      { from: 'idx_api_requests_domain', to: 'idx_api_requests_train_id' },
      { from: 'idx_hourly_stats_hour_domain', to: 'idx_hourly_stats_hour_train' },
      {
        from: 'idx_api_requests_domain_timestamp_response',
        to: 'idx_api_requests_train_timestamp_response',
      },
      { from: 'idx_audit_domain', to: 'idx_audit_train' },
    ]

    for (const rename of indexRenames) {
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_class WHERE relname = '${rename.from}'
          ) THEN
            ALTER INDEX ${rename.from} RENAME TO ${rename.to};
          END IF;
        END
        $$;
      `)
    }

    console.log('Refreshing hourly_stats materialized view to ensure column changes are applied...')
    await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY hourly_stats;')

    await client.query('COMMIT')
    console.log('Train ID migration completed successfully.')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Train ID migration failed:', error)
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
