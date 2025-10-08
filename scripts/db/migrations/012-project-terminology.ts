#!/usr/bin/env bun

/**
 * Comprehensive Project Terminology Migration (012-016)
 *
 * This migration combines migrations 012-016 into a single atomic migration:
 *
 * From 012: Rename domain → project_id columns
 * From 013: Create credential management tables
 * From 014: Create project_members table
 * From 015: Add default_account_id to projects
 * From 016: Ensure all tables use project_* naming
 *
 * IMPORTANT: This migration is idempotent and can be safely run multiple times.
 */

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
    console.log('Starting comprehensive project terminology migration (012-016)...')
    await client.query('BEGIN')

    // ============================================================
    // STEP 1: Rename domain → project_id columns
    // ============================================================
    console.log('\n[Step 1/4] Renaming domain columns to project_id...')

    const domainColumnTables = ['api_requests', 'analysis_audit_log', 'hourly_stats']

    for (const table of domainColumnTables) {
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_name = '${table}' AND column_name = 'domain'
          ) THEN
            ALTER TABLE ${table} RENAME COLUMN domain TO project_id;
          END IF;
        END
        $$;
      `)
    }

    console.log('✓ Domain columns renamed to project_id')

    // ============================================================
    // STEP 2: Create/update anthropic_credentials table
    // ============================================================
    console.log('\n[Step 2/4] Creating/updating credential management tables...')

    // Create credentials table with old schema first (for idempotency with existing databases)
    await client.query(`
      CREATE TABLE IF NOT EXISTS anthropic_credentials (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        account_email VARCHAR(255) NOT NULL UNIQUE,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        token_expiry TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    // Update credentials table schema to final form
    await client.query(`
      DO $$
      BEGIN
        -- Rename account_email to account_id if it exists
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'anthropic_credentials' AND column_name = 'account_email'
        ) THEN
          ALTER TABLE anthropic_credentials RENAME COLUMN account_email TO account_id;
        END IF;

        -- Rename access_token to oauth_access_token if needed
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'anthropic_credentials' AND column_name = 'access_token'
        ) THEN
          ALTER TABLE anthropic_credentials RENAME COLUMN access_token TO oauth_access_token;
        END IF;

        -- Rename refresh_token to oauth_refresh_token if needed
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'anthropic_credentials' AND column_name = 'refresh_token'
        ) THEN
          ALTER TABLE anthropic_credentials RENAME COLUMN refresh_token TO oauth_refresh_token;
        END IF;

        -- Rename token_expiry to oauth_expires_at if needed
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'anthropic_credentials' AND column_name = 'token_expiry'
        ) THEN
          ALTER TABLE anthropic_credentials RENAME COLUMN token_expiry TO oauth_expires_at;
        END IF;

        -- Add account_name column if it doesn't exist (default to account_id)
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'anthropic_credentials' AND column_name = 'account_name'
        ) THEN
          ALTER TABLE anthropic_credentials ADD COLUMN account_name VARCHAR(255);
          UPDATE anthropic_credentials SET account_name = account_id WHERE account_name IS NULL;
          ALTER TABLE anthropic_credentials ALTER COLUMN account_name SET NOT NULL;
        END IF;

        -- Add oauth_scopes column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'anthropic_credentials' AND column_name = 'oauth_scopes'
        ) THEN
          ALTER TABLE anthropic_credentials ADD COLUMN oauth_scopes TEXT[] NOT NULL DEFAULT '{}';
        END IF;

        -- Add oauth_is_max column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'anthropic_credentials' AND column_name = 'oauth_is_max'
        ) THEN
          ALTER TABLE anthropic_credentials ADD COLUMN oauth_is_max BOOLEAN NOT NULL DEFAULT false;
        END IF;

        -- Add last_refresh_at column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'anthropic_credentials' AND column_name = 'last_refresh_at'
        ) THEN
          ALTER TABLE anthropic_credentials ADD COLUMN last_refresh_at TIMESTAMPTZ;
        END IF;
      END
      $$;
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_credentials_account_id
      ON anthropic_credentials(account_id)
    `)

    console.log('✓ Credential management tables created')

    // ============================================================
    // STEP 3: Create projects table with all columns
    // ============================================================
    console.log('\n[Step 3/4] Creating/updating projects table...')

    // Create projects table
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id VARCHAR(255) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    // Add all required columns to projects table
    await client.query(`
      DO $$
      BEGIN
        -- Add default_account_id column
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'projects' AND column_name = 'default_account_id'
        ) THEN
          ALTER TABLE projects ADD COLUMN default_account_id UUID REFERENCES anthropic_credentials(id) ON DELETE SET NULL;
        END IF;

        -- Add slack_enabled column
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'projects' AND column_name = 'slack_enabled'
        ) THEN
          ALTER TABLE projects ADD COLUMN slack_enabled BOOLEAN NOT NULL DEFAULT false;
        END IF;

        -- Add slack_webhook_url column
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'projects' AND column_name = 'slack_webhook_url'
        ) THEN
          ALTER TABLE projects ADD COLUMN slack_webhook_url TEXT;
        END IF;

        -- Add slack_channel column
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'projects' AND column_name = 'slack_channel'
        ) THEN
          ALTER TABLE projects ADD COLUMN slack_channel VARCHAR(255);
        END IF;

        -- Add slack_username column
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'projects' AND column_name = 'slack_username'
        ) THEN
          ALTER TABLE projects ADD COLUMN slack_username VARCHAR(255);
        END IF;

        -- Add slack_icon_emoji column
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'projects' AND column_name = 'slack_icon_emoji'
        ) THEN
          ALTER TABLE projects ADD COLUMN slack_icon_emoji VARCHAR(255);
        END IF;

        -- Drop description column if it exists
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'projects' AND column_name = 'description'
        ) THEN
          ALTER TABLE projects DROP COLUMN description;
        END IF;
      END
      $$;
    `)

    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_projects_project_id
      ON projects(project_id)
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_projects_default_account
      ON projects(default_account_id)
    `)

    console.log('✓ Projects table created/updated')

    // ============================================================
    // STEP 4: Create project_members and project_api_keys tables
    // ============================================================
    console.log('\n[Step 4/4] Creating/updating project members and API keys tables...')

    // Create project_members table
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_email VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL CHECK (role IN ('owner', 'member')),
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        added_by VARCHAR(255) NOT NULL,
        UNIQUE(project_id, user_email)
      )
    `)

    // Create indexes for project_members
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_project_members_project_id
      ON project_members(project_id)
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_project_members_user_email
      ON project_members(user_email)
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_project_members_role
      ON project_members(project_id, role)
    `)

    // Backfill existing projects with default owner
    const defaultOwnerEmail = 'todo@localhost'
    await client.query(
      `
      INSERT INTO project_members (project_id, user_email, role, added_by)
      SELECT id, $1, 'owner', 'system'
      FROM projects
      WHERE NOT EXISTS (
        SELECT 1 FROM project_members WHERE project_members.project_id = projects.id
      )
      ON CONFLICT DO NOTHING
    `,
      [defaultOwnerEmail]
    )

    // Create project_api_keys table
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        api_key VARCHAR(255) NOT NULL UNIQUE,
        key_prefix VARCHAR(255) NOT NULL,
        key_suffix VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        created_by VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        revoked_by VARCHAR(255)
      )
    `)

    // Add missing columns to project_api_keys if they exist but with old schema
    await client.query(`
      DO $$
      BEGIN
        -- Add key_prefix if missing
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'project_api_keys' AND column_name = 'key_prefix'
        ) THEN
          ALTER TABLE project_api_keys ADD COLUMN key_prefix VARCHAR(255) NOT NULL DEFAULT 'cnp_live_';
        END IF;

        -- Add key_suffix if missing
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'project_api_keys' AND column_name = 'key_suffix'
        ) THEN
          ALTER TABLE project_api_keys ADD COLUMN key_suffix VARCHAR(255) NOT NULL DEFAULT '****';
        END IF;

        -- Add name if missing
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'project_api_keys' AND column_name = 'name'
        ) THEN
          ALTER TABLE project_api_keys ADD COLUMN name VARCHAR(255);
        END IF;

        -- Add created_by if missing
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'project_api_keys' AND column_name = 'created_by'
        ) THEN
          ALTER TABLE project_api_keys ADD COLUMN created_by VARCHAR(255);
        END IF;

        -- Add revoked_at if missing
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'project_api_keys' AND column_name = 'revoked_at'
        ) THEN
          ALTER TABLE project_api_keys ADD COLUMN revoked_at TIMESTAMPTZ;
        END IF;

        -- Add revoked_by if missing
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'project_api_keys' AND column_name = 'revoked_by'
        ) THEN
          ALTER TABLE project_api_keys ADD COLUMN revoked_by VARCHAR(255);
        END IF;

        -- Drop old is_active column if it exists (replaced by revoked_at)
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'project_api_keys' AND column_name = 'is_active'
        ) THEN
          ALTER TABLE project_api_keys DROP COLUMN is_active;
        END IF;

        -- Drop old key_hash column if it exists (replaced by key_prefix/suffix)
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'project_api_keys' AND column_name = 'key_hash'
        ) THEN
          ALTER TABLE project_api_keys DROP COLUMN key_hash;
        END IF;
      END
      $$;
    `)

    // Create indexes for project_api_keys
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_project_api_keys_project
      ON project_api_keys(project_id)
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_project_api_keys_key
      ON project_api_keys(api_key)
    `)

    console.log('✓ Project members and API keys tables created/updated')

    await client.query('COMMIT')
    console.log('\n✅ Comprehensive project terminology migration completed successfully!')
    console.log('   - Renamed domain columns to project_id')
    console.log('   - Created/updated anthropic_credentials table')
    console.log('   - Created/updated projects table with all columns')
    console.log('   - Created/updated project_members table')
    console.log('   - Created/updated project_api_keys table')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Migration failed:', error)
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
