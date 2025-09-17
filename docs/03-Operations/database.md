# Database Schema Documentation

## Overview

Agent Prompt Train uses PostgreSQL to store API request/response data, conversation tracking, and token usage metrics. The database schema is designed for efficient querying and real-time analytics.

## Tables

### api_requests

The main table storing all API requests and responses.

| Column                      | Type         | Description                                  |
| --------------------------- | ------------ | -------------------------------------------- |
| request_id                  | UUID         | Primary key, unique request identifier       |
| train_id                    | VARCHAR(255) | Train identifier from `train-id` header     |
| account_id                  | VARCHAR(255) | Account identifier from credential file      |
| timestamp                   | TIMESTAMPTZ  | Request timestamp                            |
| method                      | VARCHAR(10)  | HTTP method (always POST for Claude)         |
| path                        | VARCHAR(255) | API path (e.g., /v1/messages)                |
| headers                     | JSONB        | Request headers (sanitized)                  |
| body                        | JSONB        | Request body                                 |
| api_key_hash                | VARCHAR(50)  | Hashed API key for security                  |
| model                       | VARCHAR(100) | Claude model name                            |
| request_type                | VARCHAR(50)  | Type: inference, query_evaluation, or quota  |
| response_status             | INTEGER      | HTTP response status code                    |
| response_headers            | JSONB        | Response headers                             |
| response_body               | JSONB        | Response body                                |
| response_streaming          | BOOLEAN      | Whether response was streamed                |
| input_tokens                | INTEGER      | Input token count                            |
| output_tokens               | INTEGER      | Output token count                           |
| total_tokens                | INTEGER      | Total tokens (input + output)                |
| cache_creation_input_tokens | INTEGER      | Cache creation tokens                        |
| cache_read_input_tokens     | INTEGER      | Cache read tokens                            |
| usage_data                  | JSONB        | Additional usage metadata                    |
| first_token_ms              | INTEGER      | Time to first token (streaming)              |
| duration_ms                 | INTEGER      | Total request duration                       |
| error                       | TEXT         | Error message if request failed              |
| tool_call_count             | INTEGER      | Number of tool calls in response             |
| current_message_hash        | CHAR(64)     | SHA-256 hash of last message                 |
| parent_message_hash         | CHAR(64)     | SHA-256 hash of previous message             |
| conversation_id             | UUID         | Groups messages into conversations           |
| branch_id                   | VARCHAR(255) | Branch within conversation (default: 'main') |
| message_count               | INTEGER      | Total messages in conversation               |
| parent_task_request_id      | UUID         | Links sub-task requests to parent task       |
| is_subtask                  | BOOLEAN      | Indicates if request is a sub-task           |
| task_tool_invocation        | JSONB        | Task tool invocation details                 |
| created_at                  | TIMESTAMPTZ  | Record creation timestamp                    |

### streaming_chunks

Stores individual chunks from streaming responses.

| Column      | Type        | Description                 |
| ----------- | ----------- | --------------------------- |
| id          | SERIAL      | Primary key                 |
| request_id  | UUID        | Foreign key to api_requests |
| chunk_index | INTEGER     | Chunk sequence number       |
| timestamp   | TIMESTAMPTZ | Chunk timestamp             |
| data        | TEXT        | Chunk data                  |
| token_count | INTEGER     | Tokens in this chunk        |
| created_at  | TIMESTAMPTZ | Record creation timestamp   |

### conversation_analyses

Stores AI-generated analyses of conversations.

| Column                 | Type                         | Description                                             |
| ---------------------- | ---------------------------- | ------------------------------------------------------- |
| id                     | BIGSERIAL                    | Primary key                                             |
| conversation_id        | UUID                         | UUID of the conversation being analyzed                 |
| branch_id              | VARCHAR(255)                 | Branch within conversation (default: 'main')            |
| status                 | conversation_analysis_status | Processing status (pending/processing/completed/failed) |
| model_used             | VARCHAR(255)                 | AI model used (default: 'gemini-2.5-pro')               |
| analysis_content       | TEXT                         | Human-readable analysis text                            |
| analysis_data          | JSONB                        | Structured analysis data in JSON format                 |
| raw_response           | JSONB                        | Complete raw response from the AI model                 |
| error_message          | TEXT                         | Error details if analysis failed                        |
| retry_count            | INTEGER                      | Number of retry attempts (default: 0)                   |
| generated_at           | TIMESTAMPTZ                  | Timestamp when analysis was completed                   |
| processing_duration_ms | INTEGER                      | Time taken to generate analysis in milliseconds         |
| prompt_tokens          | INTEGER                      | Number of tokens used in the prompt                     |
| completion_tokens      | INTEGER                      | Number of tokens in the completion                      |
| created_at             | TIMESTAMPTZ                  | Record creation timestamp                               |
| updated_at             | TIMESTAMPTZ                  | Last update timestamp (auto-updated)                    |

## Indexes

### Performance Indexes

- `idx_requests_train_id` - Filter by train ID
- `idx_requests_timestamp` - Time-based queries
- `idx_requests_model` - Filter by model
- `idx_requests_request_type` - Filter by request type
- `idx_requests_account_id` - Filter by account
- `idx_requests_account_timestamp` - Account queries with time filtering
- `idx_requests_request_id` - Fast request lookups

### Conversation Tracking Indexes

- `idx_requests_conversation_id` - Group by conversation
- `idx_requests_branch_id` - Filter by branch
- `idx_requests_conversation_branch` - Composite index
- `idx_requests_current_hash` - Find by message hash
- `idx_requests_parent_hash` - Find parent messages
- `idx_requests_conversation_timestamp_id` - Window function optimization
- `idx_requests_conversation_subtask` - Sub-task filtering and ordering

### Sub-task Tracking Indexes

- `idx_requests_parent_task_request_id` - Find sub-tasks by parent
- `idx_requests_is_subtask` - Filter sub-task conversations
- `idx_requests_task_tool_invocation_gin` - GIN index for Task tool queries

### Streaming Indexes

- `idx_chunks_request_id` - Chunks by request

### Conversation Analysis Indexes

- `idx_conversation_analyses_status` - Partial index on pending status for queue processing
- `idx_conversation_analyses_conversation` - Composite index on (conversation_id, branch_id)

## Key Features

### Account-Based Token Tracking

The `account_id` column enables tracking token usage per account rather than just per train ID. This allows:

- Multiple trains to share the same Claude account
- Accurate tracking against Claude's 140,000 token per 5-hour window limit
- Per-account usage dashboards and alerts

### Conversation Tracking

Messages are automatically linked into conversations using:

- `current_message_hash` - SHA-256 hash of the last message in the request
- `parent_message_hash` - Hash of the previous message (null for first message)
- `conversation_id` - UUID grouping all related messages
- `branch_id` - Supports conversation branching when resuming from earlier points

### Sub-task Tracking

Sub-tasks spawned via Claude's Task tool are automatically detected and linked:

- `parent_task_request_id` - Links sub-tasks to their parent request
- `is_subtask` - Boolean flag for quick sub-task filtering
- `task_tool_invocation` - Stores Task tool details (prompt, description, linked conversation)
- Automatic linking based on prompt matching within 30-second window
- GIN index enables efficient queries on JSONB task data

### Request Types

The `request_type` column categorizes requests:

- `inference` - Normal Claude API calls (2+ system messages)
- `query_evaluation` - Special evaluation requests (0-1 system messages)
- `quota` - Quota check requests (user message = "quota")

### AI-Powered Conversation Analysis

The `conversation_analyses` table enables automated analysis of conversations using AI models:

- **Status Tracking**: ENUM type ensures only valid status values (pending, processing, completed, failed)
- **Automatic Timestamps**: `updated_at` field automatically updates via trigger
- **Unique Analyses**: UNIQUE constraint on (conversation_id, branch_id) prevents duplicates
- **Token Tracking**: Monitors API usage for cost management
- **Error Handling**: Tracks retry attempts and error messages for failed analyses
- **Model Flexibility**: Supports different AI models through the `model_used` field

## Common Queries

### Token Usage by Account (5-hour window)

```sql
SELECT
  account_id,
  SUM(output_tokens) as total_output_tokens,
  COUNT(*) as request_count
FROM api_requests
WHERE account_id = 'acc_12345'
  AND timestamp > NOW() - INTERVAL '5 hours'
  AND request_type = 'inference'
GROUP BY account_id;
```

### Conversations with Branches

```sql
SELECT
  conversation_id,
  branch_id,
  COUNT(*) as message_count,
  MIN(timestamp) as started_at,
  MAX(timestamp) as last_message_at
FROM api_requests
WHERE conversation_id IS NOT NULL
GROUP BY conversation_id, branch_id
ORDER BY last_message_at DESC;
```

### Daily Usage Statistics

```sql
SELECT
  DATE(timestamp) as date,
  account_id,
  SUM(input_tokens) as input_tokens,
  SUM(output_tokens) as output_tokens,
  COUNT(*) as requests
FROM api_requests
WHERE timestamp > NOW() - INTERVAL '30 days'
GROUP BY DATE(timestamp), account_id
ORDER BY date DESC;
```

### Sub-task Analysis

```sql
-- Find all sub-tasks for a parent conversation
SELECT
  ar.conversation_id,
  ar.request_id,
  ar.timestamp,
  ar.model,
  ar.total_tokens,
  ti.task->>'prompt' as task_prompt
FROM api_requests ar
CROSS JOIN LATERAL jsonb_array_elements(ar.task_tool_invocation) AS ti(task)
WHERE ar.conversation_id = 'parent-conversation-uuid'
  AND ar.task_tool_invocation IS NOT NULL
ORDER BY ar.timestamp;

-- Count sub-tasks by parent
SELECT
  parent_task_request_id,
  COUNT(*) as subtask_count,
  SUM(total_tokens) as subtask_tokens
FROM api_requests
WHERE is_subtask = true
GROUP BY parent_task_request_id;
```

### Conversation Analysis Queries

```sql
-- Get pending analyses for processing
SELECT
  conversation_id,
  branch_id,
  created_at
FROM conversation_analyses
WHERE status = 'pending'
ORDER BY created_at
LIMIT 10;

-- Get analysis for a specific conversation
SELECT
  analysis_content,
  analysis_data,
  model_used,
  generated_at,
  prompt_tokens + completion_tokens as total_tokens
FROM conversation_analyses
WHERE conversation_id = 'uuid-here'
  AND branch_id = 'main'
  AND status = 'completed';

-- Analysis statistics by model
SELECT
  model_used,
  COUNT(*) as total_analyses,
  AVG(processing_duration_ms) as avg_duration_ms,
  SUM(prompt_tokens + completion_tokens) as total_tokens_used
FROM conversation_analyses
WHERE status = 'completed'
GROUP BY model_used;
```

## Schema Evolution

### Migration System

The database schema is managed through versioned migration scripts located in `scripts/db/migrations/`. Each migration is a TypeScript file that can be run independently with Bun.

#### Running Migrations

```bash
# Run all migrations in order
for file in scripts/db/migrations/*.ts; do
  bun run "$file"
done

# Run a specific migration
bun run scripts/db/migrations/003-add-subtask-tracking.ts
```

#### Available Migrations

1. **000-init-database.ts** - Initial schema setup
2. **001-add-conversation-tracking.ts** - Adds conversation tracking columns
3. **002-optimize-conversation-indexes.ts** - Performance optimizations
4. **003-add-subtask-tracking.ts** - Adds sub-task detection support
5. **004-optimize-conversation-window-functions.ts** - Window function indexes
6. **005-populate-account-ids.ts** - Populates account IDs from train mappings
7. **006-split-conversation-hashes.ts** - Separates system prompt hashing
8. **007-add-parent-request-id.ts** - Adds direct parent request linking
9. **008-subtask-updates-and-task-indexes.ts** - Optimizes Task tool queries
10. **009-add-response-body-gin-index.ts** - Creates GIN index for JSONB queries
11. **010-add-temporal-awareness-indexes.ts** - Adds temporal query indexes
12. **011-add-conversation-analyses.ts** - Creates AI analysis infrastructure

See [ADR-012: Database Schema Evolution](../04-Architecture/ADRs/adr-012-database-schema-evolution.md) for details on the migration strategy.

### Fresh Installation vs Upgrade

- **Fresh Installation**: Run `scripts/init-database.sql` to create all tables with the latest schema
- **Existing Installation**: Run migrations sequentially to upgrade the schema

### Migration Safety

All migrations are designed to be idempotent - they can be run multiple times safely without causing errors or data corruption.

## Migration Notes

When upgrading from earlier versions:

1. The `domain_telemetry` table has been removed - all token tracking now happens in `api_requests`
2. The `account_id` column must be populated for existing records (see migration 005)
3. No separate `token_usage` table is created - despite what older docs might suggest
4. Sub-task tracking columns were added in migration 003
5. Performance indexes were added in migrations 002 and 004

## Database Maintenance

- Indexes are automatically created during initialization and migrations
- Consider partitioning `api_requests` by month for very high volume deployments
- Regular VACUUM and ANALYZE recommended for optimal performance
- Migrations run ANALYZE after bulk updates to maintain query performance
