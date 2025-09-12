#!/usr/bin/env bun
/**
 * Migration 012: Add OAuth authentication infrastructure
 *
 * This migration creates all tables and structures needed for Google OAuth authentication:
 * 1. users table - Stores user information from Google OAuth
 * 2. sessions table - Manages user sessions with secure tokens
 *
 * Features:
 * - UUID primary keys for security
 * - Unique constraints on email and google_id
 * - Session expiry management
 * - Indexes for performance
 * - Automatic updated_at trigger for users
 */

import { Pool } from 'pg'
import { config } from 'dotenv'

// Load environment variables
config()

async function migrate() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  })

  try {
    console.log('Migration 012: Creating OAuth authentication infrastructure...')

    // Start transaction
    await pool.query('BEGIN')

    // Ensure pgcrypto extension for UUID generation
    console.log('\n0. Ensuring pgcrypto extension...')
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')

    // Create users table
    console.log('\n1. Creating users table...')
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255),
        google_id VARCHAR(255) UNIQUE NOT NULL,
        allowed_domain VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `)

    // Add comment to users table
    await pool.query(`
      COMMENT ON TABLE users IS 'Stores user information from Google OAuth authentication';
    `)

    // Add comments to users columns
    await pool.query(`
      COMMENT ON COLUMN users.id IS 'Unique identifier for the user';
      COMMENT ON COLUMN users.email IS 'User email from Google account';
      COMMENT ON COLUMN users.name IS 'User display name from Google account';
      COMMENT ON COLUMN users.google_id IS 'Unique Google account identifier';
      COMMENT ON COLUMN users.allowed_domain IS 'Domain restriction for enterprise accounts';
      COMMENT ON COLUMN users.created_at IS 'When the user first logged in';
      COMMENT ON COLUMN users.updated_at IS 'When the user record was last modified';
    `)

    // Create sessions table
    console.log('\n2. Creating sessions table...')
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token VARCHAR(255) UNIQUE NOT NULL,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `)

    // Add comment to sessions table
    await pool.query(`
      COMMENT ON TABLE sessions IS 'Manages user sessions with secure tokens';
    `)

    // Add comments to sessions columns
    await pool.query(`
      COMMENT ON COLUMN sessions.id IS 'Unique identifier for the session';
      COMMENT ON COLUMN sessions.user_id IS 'Reference to the authenticated user';
      COMMENT ON COLUMN sessions.token IS 'Secure session token stored in cookie';
      COMMENT ON COLUMN sessions.expires_at IS 'When this session expires';
      COMMENT ON COLUMN sessions.created_at IS 'When this session was created';
    `)

    // Create indexes for performance
    console.log('\n3. Creating indexes...')

    // Index for session token lookups (most common query)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    `)

    // Index for cleaning up expired sessions
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    `)

    // Index for finding sessions by user
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    `)

    // Create updated_at trigger function if it doesn't exist
    console.log('\n4. Creating or verifying updated_at trigger function...')
    await pool.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
      END;
      $$ language 'plpgsql';
    `)

    // Add updated_at trigger to users table
    console.log('\n5. Adding updated_at trigger to users table...')
    await pool.query(`
      DROP TRIGGER IF EXISTS update_users_updated_at ON users;
      CREATE TRIGGER update_users_updated_at
        BEFORE UPDATE ON users
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
    `)

    // Verify tables were created
    console.log('\n6. Verifying migration...')

    const usersCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'users'
      );
    `)

    const sessionsCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'sessions'
      );
    `)

    if (!usersCheck.rows[0].exists || !sessionsCheck.rows[0].exists) {
      throw new Error('Tables were not created successfully')
    }

    // Verify indexes
    const indexCheck = await pool.query(`
      SELECT COUNT(*) as index_count
      FROM pg_indexes
      WHERE tablename IN ('users', 'sessions')
      AND schemaname = 'public';
    `)

    console.log(`Created ${indexCheck.rows[0].index_count} indexes`)

    // Commit transaction
    await pool.query('COMMIT')

    console.log('\n✅ Migration 012 completed successfully!')
    console.log('Created:')
    console.log('- users table with OAuth user information')
    console.log('- sessions table for session management')
    console.log('- Performance indexes on session tokens and expiry')
    console.log('- Automatic updated_at trigger for users')
  } catch (error) {
    // Rollback on error
    await pool.query('ROLLBACK')
    console.error('\n❌ Migration 012 failed:', error)
    throw error
  } finally {
    // Close the connection
    await pool.end()
  }
}

// Run migration if executed directly
if (import.meta.main) {
  migrate().catch(error => {
    console.error('Migration failed:', error)
    process.exit(1)
  })
}

export { migrate }
