#!/usr/bin/env bun

/**
 * Migration: Add indexes for project privacy performance optimization
 *
 * This migration adds indexes to optimize JOIN performance when filtering
 * private projects based on membership.
 */

import { Pool } from 'pg'

async function up(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log('Adding indexes for project privacy optimization...')

    // Composite index for membership lookups by project and user
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_project_members_project_user
      ON project_members(project_id, user_email)
    `)
    console.log('✓ Created idx_project_members_project_user')

    // Index for finding all projects a user is member of
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_project_members_user
      ON project_members(user_email)
    `)
    console.log('✓ Created idx_project_members_user')

    // Partial index for private projects (smaller index, faster lookups)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_projects_private
      ON projects(is_private)
      WHERE is_private = true
    `)
    console.log('✓ Created idx_projects_private')

    // Index for normalized email lookups if emails are stored in mixed case
    // This is a functional index that will help with case-insensitive searches
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_project_members_user_lower
      ON project_members(LOWER(user_email))
    `)
    console.log('✓ Created idx_project_members_user_lower')

    await client.query('COMMIT')
    console.log('✅ Privacy optimization indexes created successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to create indexes:', error)
    throw error
  } finally {
    client.release()
  }
}

async function down(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log('Removing project privacy indexes...')

    await client.query('DROP INDEX IF EXISTS idx_project_members_project_user')
    await client.query('DROP INDEX IF EXISTS idx_project_members_user')
    await client.query('DROP INDEX IF EXISTS idx_projects_private')
    await client.query('DROP INDEX IF EXISTS idx_project_members_user_lower')

    await client.query('COMMIT')
    console.log('✅ Privacy indexes removed successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to remove indexes:', error)
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
