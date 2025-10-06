-- Initialize Agent Prompt Train Database
-- This script creates the necessary tables for the proxy

-- Create api_requests table with all required columns including branch_id
CREATE TABLE IF NOT EXISTS api_requests (
    request_id UUID PRIMARY KEY,
    train_id VARCHAR(255) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    method VARCHAR(10) NOT NULL,
    path VARCHAR(255) NOT NULL,
    headers JSONB,
    body JSONB,
    api_key_hash VARCHAR(50),
    model VARCHAR(100),
    request_type VARCHAR(50),
    response_status INTEGER,
    response_headers JSONB,
    response_body JSONB,
    response_streaming BOOLEAN DEFAULT false,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    cache_creation_input_tokens INTEGER DEFAULT 0,
    cache_read_input_tokens INTEGER DEFAULT 0,
    usage_data JSONB,
    first_token_ms INTEGER,
    duration_ms INTEGER,
    error TEXT,
    tool_call_count INTEGER DEFAULT 0,
    current_message_hash CHAR(64),
    parent_message_hash CHAR(64),
    conversation_id UUID,
    branch_id VARCHAR(255) DEFAULT 'main',
    message_count INTEGER DEFAULT 0,
    parent_task_request_id UUID REFERENCES api_requests(request_id),
    is_subtask BOOLEAN DEFAULT false,
    task_tool_invocation JSONB,
    account_id VARCHAR(255),
    parent_request_id UUID REFERENCES api_requests(request_id),
    system_hash VARCHAR(64),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT chk_parent_request_not_self CHECK (parent_request_id != request_id)
);

-- Create streaming_chunks table
CREATE TABLE IF NOT EXISTS streaming_chunks (
    id SERIAL PRIMARY KEY,
    request_id UUID NOT NULL,
    chunk_index INTEGER NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    data TEXT NOT NULL,
    token_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    FOREIGN KEY (request_id) REFERENCES api_requests(request_id) ON DELETE CASCADE,
    UNIQUE(request_id, chunk_index)
);

-- Create indexes for api_requests
CREATE INDEX IF NOT EXISTS idx_requests_train_id ON api_requests(train_id);
CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON api_requests(timestamp);
CREATE INDEX IF NOT EXISTS idx_requests_model ON api_requests(model);
CREATE INDEX IF NOT EXISTS idx_requests_request_type ON api_requests(request_type);
CREATE INDEX IF NOT EXISTS idx_requests_conversation_id ON api_requests(conversation_id);
CREATE INDEX IF NOT EXISTS idx_requests_branch_id ON api_requests(branch_id);
CREATE INDEX IF NOT EXISTS idx_requests_conversation_branch ON api_requests(conversation_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_requests_message_count ON api_requests(message_count);
CREATE INDEX IF NOT EXISTS idx_requests_parent_hash ON api_requests(parent_message_hash);
CREATE INDEX IF NOT EXISTS idx_requests_current_hash ON api_requests(current_message_hash);
CREATE INDEX IF NOT EXISTS idx_requests_account_id ON api_requests(account_id);

-- Performance indexes for window function queries (from migration 004)
CREATE INDEX IF NOT EXISTS idx_requests_conversation_timestamp_id 
ON api_requests(conversation_id, timestamp DESC, request_id DESC) 
WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_requests_conversation_subtask 
ON api_requests(conversation_id, is_subtask, timestamp ASC, request_id ASC) 
WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_requests_request_id 
ON api_requests(request_id);

-- Create index for parent_request_id
CREATE INDEX IF NOT EXISTS idx_api_requests_parent_request_id 
ON api_requests(parent_request_id);

-- Create index for system_hash
CREATE INDEX IF NOT EXISTS idx_api_requests_system_hash 
ON api_requests(system_hash);

-- Create indexes for Task invocation queries (from migration 008)
-- GIN index for faster JSONB searches on response_body
CREATE INDEX IF NOT EXISTS idx_api_requests_response_body_task
ON api_requests USING gin (response_body)
WHERE response_body IS NOT NULL;

-- Composite index for train_id + timestamp queries
CREATE INDEX IF NOT EXISTS idx_api_requests_train_timestamp_response
ON api_requests(train_id, timestamp DESC)
WHERE response_body IS NOT NULL;

-- Functional index for faster text searches
CREATE INDEX IF NOT EXISTS idx_api_requests_task_name
ON api_requests ((response_body::text))
WHERE response_body IS NOT NULL 
  AND response_body::text LIKE '%"name":"Task"%';

-- Create indexes for streaming_chunks
CREATE INDEX IF NOT EXISTS idx_chunks_request_id ON streaming_chunks(request_id);

-- Add column comments
COMMENT ON COLUMN api_requests.current_message_hash IS 'SHA-256 hash of the last message in this request';
COMMENT ON COLUMN api_requests.parent_message_hash IS 'SHA-256 hash of the previous message (null for conversation start)';
COMMENT ON COLUMN api_requests.conversation_id IS 'UUID grouping related messages into conversations';
COMMENT ON COLUMN api_requests.branch_id IS 'Branch identifier within a conversation (defaults to main)';
COMMENT ON COLUMN api_requests.message_count IS 'Total number of messages in the conversation up to this request';
COMMENT ON COLUMN api_requests.parent_task_request_id IS 'Links sub-task requests to their parent task';
COMMENT ON COLUMN api_requests.is_subtask IS 'Boolean flag indicating if a request is a sub-task';
COMMENT ON COLUMN api_requests.task_tool_invocation IS 'JSONB array storing Task tool invocations';
COMMENT ON COLUMN api_requests.account_id IS 'Account identifier from credential file for per-account tracking';
COMMENT ON COLUMN api_requests.parent_request_id IS 'UUID of the parent request in the conversation chain, references the immediate parent';
COMMENT ON COLUMN api_requests.system_hash IS 'SHA-256 hash of the system prompt only, separate from message content hash';

-- Create ENUM type for conversation analysis status
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conversation_analysis_status') THEN
        CREATE TYPE conversation_analysis_status AS ENUM (
            'pending',
            'processing',
            'completed',
            'failed'
        );
    END IF;
END$$;

-- Create function for automatic updated_at timestamp
CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create conversation_analyses table
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

-- Create trigger for automatic updated_at
DROP TRIGGER IF EXISTS set_timestamp_on_conversation_analyses ON conversation_analyses;
CREATE TRIGGER set_timestamp_on_conversation_analyses
BEFORE UPDATE ON conversation_analyses
FOR EACH ROW
EXECUTE FUNCTION trigger_set_timestamp();

-- Create indexes for conversation_analyses
CREATE INDEX IF NOT EXISTS idx_conversation_analyses_status
ON conversation_analyses (status)
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_conversation_analyses_conversation
ON conversation_analyses (conversation_id, branch_id);

CREATE INDEX IF NOT EXISTS idx_conversation_analyses_has_custom_prompt
ON conversation_analyses ((custom_prompt IS NOT NULL))
WHERE custom_prompt IS NOT NULL;

-- Add column comments for conversation_analyses
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

-- Create analysis_audit_log table for tracking AI analysis events
CREATE TABLE IF NOT EXISTS analysis_audit_log (
    id SERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    outcome VARCHAR(50) NOT NULL,
    conversation_id UUID NOT NULL,
    branch_id VARCHAR(255) NOT NULL,
    train_id VARCHAR(255) NOT NULL,
    request_id VARCHAR(255) NOT NULL,
    user_context JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Create indexes for analysis_audit_log
CREATE INDEX IF NOT EXISTS idx_audit_conversation ON analysis_audit_log (conversation_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_audit_train ON analysis_audit_log (train_id);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON analysis_audit_log (timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_event_type ON analysis_audit_log (event_type);

-- Add comment on analysis_audit_log
COMMENT ON TABLE analysis_audit_log IS 'Audit log for AI analysis operations. Consider partitioning by timestamp for high-volume deployments.';

-- Create accounts table for database-backed credential management (ADR-026)
CREATE TABLE IF NOT EXISTS accounts (
  account_id VARCHAR(255) PRIMARY KEY,
  account_name VARCHAR(255) UNIQUE NOT NULL,
  credential_type VARCHAR(20) NOT NULL CHECK (credential_type IN ('api_key', 'oauth')),

  -- Credentials stored in plaintext (ADR-026)
  api_key TEXT,
  oauth_access_token TEXT,
  oauth_refresh_token TEXT,
  oauth_expires_at BIGINT,
  oauth_scopes TEXT[],
  oauth_is_max BOOLEAN DEFAULT false,

  -- API key generation support
  is_generated BOOLEAN NOT NULL DEFAULT FALSE,
  key_hash VARCHAR(64),
  revoked_at TIMESTAMPTZ,

  -- Audit and metadata
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,

  -- Constraint: ensure proper credentials based on type
  CONSTRAINT api_key_required CHECK (
    (credential_type = 'api_key' AND api_key IS NOT NULL) OR
    (credential_type = 'oauth' AND oauth_access_token IS NOT NULL AND oauth_refresh_token IS NOT NULL)
  )
);

-- Create trains table for train configurations
CREATE TABLE IF NOT EXISTS trains (
  train_id VARCHAR(255) PRIMARY KEY,
  description TEXT,

  -- Client API keys (stored as plaintext despite column name)
  client_api_keys_hashed TEXT[],

  -- Slack configuration (per train)
  slack_config JSONB,

  -- Configuration
  default_account_id VARCHAR(255),
  is_active BOOLEAN DEFAULT true,

  -- Audit
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Foreign key to accounts (nullable - can be set later)
  CONSTRAINT fk_default_account FOREIGN KEY (default_account_id)
    REFERENCES accounts(account_id) ON DELETE SET NULL
);

-- Create train_account_mappings table for many-to-many relationship
CREATE TABLE IF NOT EXISTS train_account_mappings (
  train_id VARCHAR(255) NOT NULL,
  account_id VARCHAR(255) NOT NULL,
  priority INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (train_id, account_id),

  CONSTRAINT fk_mapping_train FOREIGN KEY (train_id)
    REFERENCES trains(train_id) ON DELETE CASCADE,
  CONSTRAINT fk_mapping_account FOREIGN KEY (account_id)
    REFERENCES accounts(account_id) ON DELETE CASCADE
);

-- Create indexes for accounts table
CREATE INDEX IF NOT EXISTS idx_accounts_type
ON accounts(credential_type);

CREATE INDEX IF NOT EXISTS idx_accounts_active
ON accounts(is_active)
WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_accounts_last_used
ON accounts(last_used_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_accounts_key_hash
ON accounts(key_hash)
WHERE key_hash IS NOT NULL;

-- Create indexes for trains table
CREATE INDEX IF NOT EXISTS idx_trains_active
ON trains(is_active)
WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_trains_default_account
ON trains(default_account_id)
WHERE default_account_id IS NOT NULL;

-- Create indexes for train_account_mappings table
CREATE INDEX IF NOT EXISTS idx_train_mappings_train
ON train_account_mappings(train_id);

CREATE INDEX IF NOT EXISTS idx_train_mappings_account
ON train_account_mappings(account_id);

CREATE INDEX IF NOT EXISTS idx_train_mappings_priority
ON train_account_mappings(train_id, priority);

-- Add comments for credential management tables
COMMENT ON TABLE accounts IS 'Stores Anthropic account credentials (API keys and OAuth tokens) for making requests to Claude API';
COMMENT ON TABLE trains IS 'Stores train configurations including client authentication tokens and default account settings';
COMMENT ON TABLE train_account_mappings IS 'Many-to-many relationship between trains and accounts with priority ordering';
COMMENT ON COLUMN trains.client_api_keys_hashed IS 'Plaintext client API keys for authenticating TO the proxy service (not Anthropic credentials)';
