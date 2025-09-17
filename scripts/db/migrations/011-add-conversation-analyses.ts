#!/usr/bin/env bun
/**
 * Migration 011: Add complete AI analysis infrastructure
 *
 * This migration creates all tables and structures needed for AI-powered conversation analysis:
 * 1. conversation_analyses table - Stores AI-generated analyses of conversations
 * 2. analysis_audit_log table - Tracks all AI analysis related events
 *
 * Features:
 * - ENUM type for status field (better than CHECK constraint)
 * - Automatic updated_at trigger
 * - Custom prompt support
 * - Comprehensive audit logging
 * - Optimized indexes for queue processing and lookups
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
    console.log('Migration 011: Creating AI analysis infrastructure...')

    // Start transaction
    await pool.query('BEGIN')

    // Create ENUM type for status
    console.log('\n1. Creating conversation_analysis_status ENUM type...')
    await pool.query(`
      DO $$
      BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conversation_analysis_status') THEN
              CREATE TYPE conversation_analysis_status AS ENUM (
                  'pending',
                  'processing',
                  'completed',
                  'failed'
              );
              RAISE NOTICE 'Created conversation_analysis_status ENUM type';
          ELSE
              RAISE NOTICE 'conversation_analysis_status ENUM type already exists';
          END IF;
      END$$;
    `)
    console.log('✓ ENUM type ready')

    // Create or replace the updated_at trigger function
    console.log('\n2. Creating trigger_set_timestamp function...')
    await pool.query(`
      CREATE OR REPLACE FUNCTION trigger_set_timestamp()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)
    console.log('✓ Trigger function created')

    // Create the conversation_analyses table
    console.log('\n3. Creating conversation_analyses table...')
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversation_analyses (
          id BIGSERIAL PRIMARY KEY,
          conversation_id UUID NOT NULL,
          branch_id VARCHAR(255) NOT NULL DEFAULT 'main',
          status conversation_analysis_status NOT NULL DEFAULT 'pending',
          model_used VARCHAR(255) DEFAULT 'gemini-2.5-pro',
          analysis_content TEXT,
          analysis_data JSONB,
          raw_response JSONB,
          error_message TEXT,
          retry_count INTEGER DEFAULT 0,
          generated_at TIMESTAMPTZ,
          processing_duration_ms INTEGER,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ,
          custom_prompt TEXT,
          UNIQUE (conversation_id, branch_id)
      );
    `)
    console.log('✓ conversation_analyses table created')

    // Create the updated_at trigger
    console.log('\n4. Creating updated_at trigger...')
    await pool.query(`
      DROP TRIGGER IF EXISTS set_timestamp_on_conversation_analyses ON conversation_analyses;
      CREATE TRIGGER set_timestamp_on_conversation_analyses
      BEFORE UPDATE ON conversation_analyses
      FOR EACH ROW
      EXECUTE FUNCTION trigger_set_timestamp();
    `)
    console.log('✓ Trigger created')

    // Create indexes for conversation_analyses
    console.log('\n5. Creating indexes for conversation_analyses...')

    // Index for finding pending analyses
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_conversation_analyses_status
      ON conversation_analyses (status)
      WHERE status = 'pending';
    `)
    console.log('  ✓ Created partial index on status for pending analyses')

    // Index for conversation lookups
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_conversation_analyses_conversation
      ON conversation_analyses (conversation_id, branch_id);
    `)
    console.log('  ✓ Created composite index on (conversation_id, branch_id)')

    // Index for custom prompts
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_conversation_analyses_has_custom_prompt
      ON conversation_analyses ((custom_prompt IS NOT NULL))
      WHERE custom_prompt IS NOT NULL;
    `)
    console.log('  ✓ Created index for custom prompts')

    // Add column comments for conversation_analyses
    console.log('\n6. Adding column comments for conversation_analyses...')
    await pool.query(`
      COMMENT ON TABLE conversation_analyses IS 'Stores AI-generated analyses of conversations';
      COMMENT ON COLUMN conversation_analyses.conversation_id IS 'UUID of the conversation being analyzed';
      COMMENT ON COLUMN conversation_analyses.branch_id IS 'Branch within the conversation (defaults to main)';
      COMMENT ON COLUMN conversation_analyses.status IS 'Processing status: pending, processing, completed, or failed';
      COMMENT ON COLUMN conversation_analyses.model_used IS 'AI model used for analysis (e.g., gemini-2.5-pro)';
      COMMENT ON COLUMN conversation_analyses.analysis_content IS 'Human-readable analysis text';
      COMMENT ON COLUMN conversation_analyses.analysis_data IS 'Structured analysis data in JSON format';
      COMMENT ON COLUMN conversation_analyses.raw_response IS 'Complete raw response from the AI model';
      COMMENT ON COLUMN conversation_analyses.error_message IS 'Error details if analysis failed';
      COMMENT ON COLUMN conversation_analyses.retry_count IS 'Number of retry attempts for failed analyses';
      COMMENT ON COLUMN conversation_analyses.generated_at IS 'Timestamp when the analysis was completed';
      COMMENT ON COLUMN conversation_analyses.processing_duration_ms IS 'Time taken to generate the analysis in milliseconds';
      COMMENT ON COLUMN conversation_analyses.prompt_tokens IS 'Number of tokens used in the prompt';
      COMMENT ON COLUMN conversation_analyses.completion_tokens IS 'Number of tokens in the completion';
      COMMENT ON COLUMN conversation_analyses.completed_at IS 'Timestamp when the analysis was completed (status changed to completed or failed)';
      COMMENT ON COLUMN conversation_analyses.custom_prompt IS 'Optional custom prompt provided by the user to guide the analysis';
    `)
    console.log('✓ Column comments added')

    // Create analysis_audit_log table
    console.log('\n7. Creating analysis_audit_log table...')
    await pool.query(`
      CREATE TABLE IF NOT EXISTS analysis_audit_log (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(50) NOT NULL,
        outcome VARCHAR(50) NOT NULL,
        conversation_id UUID NOT NULL,
        branch_id VARCHAR(255) NOT NULL,
        domain VARCHAR(255) NOT NULL,
        request_id VARCHAR(255) NOT NULL,
        user_context JSONB DEFAULT '{}',
        metadata JSONB DEFAULT '{}',
        timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `)
    console.log('✓ analysis_audit_log table created')

    // Create indexes for analysis_audit_log
    console.log('\n8. Creating indexes for analysis_audit_log...')
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_conversation ON analysis_audit_log (conversation_id, branch_id);
      CREATE INDEX IF NOT EXISTS idx_audit_domain ON analysis_audit_log (domain);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON analysis_audit_log (timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_event_type ON analysis_audit_log (event_type);
    `)
    console.log('✓ Indexes created for audit log')

    // Add comment on analysis_audit_log
    await pool.query(`
      COMMENT ON TABLE analysis_audit_log IS 
        'Audit log for AI analysis operations. Consider partitioning by timestamp for high-volume deployments.'
    `)

    // Analyze tables to update statistics
    console.log('\n9. Analyzing tables...')
    await pool.query('ANALYZE conversation_analyses')
    await pool.query('ANALYZE analysis_audit_log')
    console.log('✓ Tables analyzed')

    // Commit transaction
    await pool.query('COMMIT')

    // Show final status
    console.log('\n10. Verifying migration results...')

    // Check conversation_analyses table structure
    const tableCheck = await pool.query(`
      SELECT 
        column_name,
        data_type,
        column_default,
        is_nullable
      FROM information_schema.columns
      WHERE table_name = 'conversation_analyses'
      ORDER BY ordinal_position
    `)

    console.log('\nconversation_analyses table:')
    console.log('Columns:', tableCheck.rows.length)

    // Check indexes
    const indexCheck = await pool.query(`
      SELECT 
        tablename,
        indexname
      FROM pg_indexes
      WHERE tablename IN ('conversation_analyses', 'analysis_audit_log')
      ORDER BY tablename, indexname
    `)

    console.log('\nIndexes created:')
    for (const idx of indexCheck.rows) {
      console.log(`  - ${idx.tablename}.${idx.indexname}`)
    }

    console.log('\n✅ Migration 011 completed successfully!')
    console.log('\nAI Analysis infrastructure is ready:')
    console.log('  - conversation_analyses table for storing AI-generated analyses')
    console.log('  - analysis_audit_log table for tracking all analysis events')
    console.log('  - Support for custom prompts')
    console.log('  - Comprehensive indexing for optimal performance')
    console.log('  - Automatic timestamp management')
  } catch (error) {
    await pool.query('ROLLBACK')
    console.error('❌ Migration failed:', error)
    throw error
  } finally {
    await pool.end()
  }
}

// Run migration
migrate().catch(error => {
  console.error('Migration error:', error)
  process.exit(1)
})
