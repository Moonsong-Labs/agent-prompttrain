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
    console.log('Starting train members migration (014)...')
    await client.query('BEGIN')

    // Create train_members table
    console.log('Creating train_members table...')
    await client.query(`
      CREATE TABLE IF NOT EXISTS train_members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_email VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL CHECK (role IN ('owner', 'member')),
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        added_by VARCHAR(255) NOT NULL,
        UNIQUE(project_id, user_email)
      )
    `)

    console.log('Creating indexes on train_members...')
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_train_members_train_id
      ON train_members(project_id)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_train_members_user_email
      ON train_members(user_email)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_train_members_role
      ON train_members(project_id, role)
    `)

    // Backfill existing projects with default owner
    console.log('Backfilling existing projects with default owner...')
    const defaultOwnerEmail = 'todo@localhost'

    await client.query(
      `
      INSERT INTO train_members (project_id, user_email, role, added_by)
      SELECT id, $1, 'owner', 'system'
      FROM projects
      WHERE NOT EXISTS (
        SELECT 1 FROM train_members WHERE train_members.project_id = projects.id
      )
    `,
      [defaultOwnerEmail]
    )

    const backfillResult = await client.query(
      'SELECT COUNT(*) as count FROM train_members WHERE user_email = $1',
      [defaultOwnerEmail]
    )
    console.log(
      `Backfilled ${backfillResult.rows[0].count} existing projects with owner: ${defaultOwnerEmail}`
    )

    await client.query('COMMIT')
    console.log('Project members migration completed successfully.')
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
