#!/usr/bin/env bun
import { Pool } from 'pg'

/**
 * Initial database setup - creates core tables and indexes
 */
async function initDatabase() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })

  try {
    console.log('Starting initial database setup...')

    // Start transaction
    await pool.query('BEGIN')

    // Create api_requests table
    console.log('Creating api_requests table...')
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_requests (
        request_id UUID PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL,
        domain VARCHAR(255) NOT NULL,
        method VARCHAR(10) NOT NULL,
        path VARCHAR(1024) NOT NULL,
        headers JSONB NOT NULL,
        body JSONB,
        request_type VARCHAR(50),
        api_key_id VARCHAR(50),
        model VARCHAR(100),
        ip_address VARCHAR(45),
        response_status INTEGER,
        response_headers JSONB,
        response_body JSONB,
        response_streaming BOOLEAN DEFAULT FALSE,
        duration_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_creation_input_tokens INTEGER DEFAULT 0,
        cache_read_input_tokens INTEGER DEFAULT 0,
        usage_data JSONB,
        tool_call_count INTEGER DEFAULT 0,
        error TEXT,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)

    // Create indexes for api_requests
    console.log('Creating indexes for api_requests...')
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_requests_domain ON api_requests(domain)`)
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_api_requests_timestamp ON api_requests(timestamp)`
    )
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_requests_model ON api_requests(model)`)
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_api_requests_request_type ON api_requests(request_type)`
    )

    // Create streaming_chunks table
    console.log('Creating streaming_chunks table...')
    await pool.query(`
      CREATE TABLE IF NOT EXISTS streaming_chunks (
        id SERIAL PRIMARY KEY,
        request_id UUID NOT NULL REFERENCES api_requests(request_id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL,
        data TEXT NOT NULL,
        token_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(request_id, chunk_index)
      )
    `)

    // Create index for streaming_chunks
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_streaming_chunks_request_id ON streaming_chunks(request_id, chunk_index)`
    )

    // Create materialized view for dashboard stats
    console.log('Creating hourly_stats materialized view...')
    await pool.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS hourly_stats AS
      SELECT 
        DATE_TRUNC('hour', timestamp) as hour,
        domain,
        model,
        COUNT(*) as request_count,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        SUM(cache_creation_input_tokens) as total_cache_creation_tokens,
        SUM(cache_read_input_tokens) as total_cache_read_tokens,
        AVG(duration_ms) as avg_response_time,
        SUM(tool_call_count) as total_tool_calls
      FROM api_requests
      WHERE timestamp > NOW() - INTERVAL '7 days'
      GROUP BY DATE_TRUNC('hour', timestamp), domain, model
    `)

    // Create index on materialized view
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_hourly_stats_hour_domain ON hourly_stats(hour DESC, domain)`
    )

    // Create function to refresh stats
    console.log('Creating refresh_hourly_stats function...')
    await pool.query(`
      CREATE OR REPLACE FUNCTION refresh_hourly_stats()
      RETURNS void AS $$
      BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY hourly_stats;
      END;
      $$ LANGUAGE plpgsql
    `)

    // Add table and column comments
    console.log('Adding table and column comments...')
    await pool.query(
      `COMMENT ON TABLE api_requests IS 'Stores all API requests and responses for the Claude proxy'`
    )
    await pool.query(
      `COMMENT ON TABLE streaming_chunks IS 'Stores individual chunks from streaming responses'`
    )
    await pool.query(
      `COMMENT ON MATERIALIZED VIEW hourly_stats IS 'Pre-aggregated hourly statistics for dashboard performance'`
    )
    await pool.query(
      `COMMENT ON COLUMN api_requests.cache_creation_input_tokens IS 'Number of tokens written to cache'`
    )
    await pool.query(
      `COMMENT ON COLUMN api_requests.cache_read_input_tokens IS 'Number of tokens read from cache'`
    )
    await pool.query(
      `COMMENT ON COLUMN api_requests.usage_data IS 'Complete usage object from Claude API response'`
    )
    await pool.query(
      `COMMENT ON COLUMN api_requests.tool_call_count IS 'Number of tool calls in the response'`
    )

    // Verify tables exist
    console.log('Verifying database setup...')
    const tableCheck = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('api_requests', 'streaming_chunks')
    `)

    const foundTables = tableCheck.rows.map(row => row.table_name)
    const expectedTables = ['api_requests', 'streaming_chunks']
    const missingTables = expectedTables.filter(table => !foundTables.includes(table))

    if (missingTables.length > 0) {
      throw new Error(`Missing tables after migration: ${missingTables.join(', ')}`)
    }

    // Commit transaction
    await pool.query('COMMIT')
    console.log('Database initialization completed successfully!')
    console.log('✅ All tables and indexes created')
  } catch (error) {
    // Rollback on error
    await pool.query('ROLLBACK')
    console.error(
      'Database initialization failed:',
      error instanceof Error ? error.message : String(error)
    )
    process.exit(1)
  } finally {
    await pool.end()
  }
}

// Run initialization
initDatabase().catch(console.error)
