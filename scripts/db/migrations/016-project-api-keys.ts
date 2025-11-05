import { Pool } from 'pg'

/**
 * Migration 016: Add API key to projects table
 *
 * Adds an api_key column to projects table for authentication.
 * Generates unique API keys for existing projects.
 */
export async function up(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    // Add api_key column if it doesn't exist
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'projects' AND column_name = 'api_key'
        ) THEN
          ALTER TABLE projects ADD COLUMN api_key VARCHAR(255) UNIQUE;
        END IF;
      END $$;
    `)

    // Generate API keys for existing projects that don't have one
    await client.query(`
      UPDATE projects
      SET api_key = 'msl_' || encode(gen_random_bytes(32), 'hex')
      WHERE api_key IS NULL
    `)

    // Make api_key NOT NULL after backfilling
    await client.query(`
      DO $$
      BEGIN
        ALTER TABLE projects ALTER COLUMN api_key SET NOT NULL;
      EXCEPTION
        WHEN others THEN
          -- Column might already be NOT NULL
          NULL;
      END $$;
    `)

    // Add index on api_key for fast lookup
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_projects_api_key
      ON projects(api_key)
    `)

    // Add comment to document the api_key column
    await client.query(`
      COMMENT ON COLUMN projects.api_key IS
      'Unique API key for project authentication. Format: msl_<64_hex_chars>. Used in MSL-Api-Key header.'
    `)

    await client.query('COMMIT')
    console.log('✅ Migration 016: Added api_key column to projects table')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Migration 016 failed:', error)
    throw error
  } finally {
    client.release()
  }
}

export async function down(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    // Drop index
    await client.query(`
      DROP INDEX IF EXISTS idx_projects_api_key
    `)

    // Drop column
    await client.query(`
      ALTER TABLE projects DROP COLUMN IF EXISTS api_key
    `)

    await client.query('COMMIT')
    console.log('✅ Migration 016 rollback: Removed api_key column from projects table')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Migration 016 rollback failed:', error)
    throw error
  } finally {
    client.release()
  }
}
