# AI Analysis Feature Setup Guide

This guide will help you set up the AI-powered conversation analysis feature.

## Prerequisites

- PostgreSQL database
- Bun runtime installed
- A configured project with a linked Anthropic account (for Claude API access)

## Setup Steps

### 1. Database Migrations

You need to run two migrations to create the required database tables:

```bash
# Migration 011: Creates conversation_analyses table
bun run scripts/db/migrations/011-add-conversation-analyses.ts

# Migration 012: Creates analysis_audit_log table
bun run scripts/db/migrations/012-add-analysis-audit-log.ts
```

These migrations will create:

- `conversation_analyses` table - Stores AI analysis results
- `conversation_analysis_status` ENUM type
- `analysis_audit_log` table - Tracks all analysis operations
- Required indexes for performance

### 2. Create a Dedicated Analysis Project

The AI analysis worker routes requests through the local proxy, using a dedicated project's credentials. This means you don't need a separate API key.

1. Create a new project in the dashboard (e.g., "AI Analysis")
2. Link an Anthropic account with Claude API access to this project
3. Note the project ID

### 3. Environment Variables

Add the following to your `.env` file:

```bash
# ===================
# AI Analysis Configuration
# ===================

# Enable the background worker (set to true to activate)
AI_WORKER_ENABLED=true

# Worker polling settings
AI_WORKER_POLL_INTERVAL_MS=5000            # How often to check for new jobs
AI_WORKER_MAX_CONCURRENT_JOBS=3            # Max parallel analysis jobs
AI_WORKER_JOB_TIMEOUT_MINUTES=5            # Timeout for stuck jobs

# Retry configuration
AI_ANALYSIS_MAX_RETRIES=3                  # Max retry attempts for failed analyses
AI_ANALYSIS_REQUEST_TIMEOUT_MS=60000       # API timeout (60 seconds)

# Analysis routing (via local proxy)
AI_ANALYSIS_PROJECT_ID=your-analysis-project-id  # REQUIRED: Project ID from step 2
ANTHROPIC_ANALYSIS_MODEL=claude-opus-4-6          # Claude model to use

# Optional: API key for the analysis project (only needed when ENABLE_CLIENT_AUTH=true)
# AI_ANALYSIS_API_KEY=your-project-api-key

# Token limits for conversation truncation
AI_ANALYSIS_INPUT_TRUNCATION_TARGET_TOKENS=8192
AI_ANALYSIS_TRUNCATE_FIRST_N_TOKENS=1000
AI_ANALYSIS_TRUNCATE_LAST_M_TOKENS=4000
```

### 4. Verify Setup

After setup, restart your services:

```bash
# Restart both services
bun run dev

# Or restart individually
bun run dev:proxy
bun run dev:dashboard
```

Check the logs for:

```
AI Analysis:
  - Enabled: Yes
  - Model: claude-opus-4-6
  - Project: your-analysis-project-id
  - Routing: Via local proxy
✓ AI Analysis Worker started
```

### 5. Using the Feature

#### Via Dashboard UI

The dashboard will show an "AI Analysis" panel for conversations (if UI is implemented).

#### Via API

1. **Create an analysis**:

```bash
curl -X POST http://localhost:3001/api/analyses \
  -H "Content-Type: application/json" \
  -H "X-Dashboard-Key: your-dashboard-api-key" \
  -d '{
    "conversationId": "550e8400-e29b-41d4-a716-446655440000",
    "branchId": "main"
  }'
```

2. **Check analysis status**:

```bash
curl http://localhost:3001/api/analyses/550e8400-e29b-41d4-a716-446655440000/main \
  -H "X-Dashboard-Key: your-dashboard-api-key"
```

3. **Regenerate analysis**:

```bash
curl -X POST http://localhost:3001/api/analyses/550e8400-e29b-41d4-a716-446655440000/main/regenerate \
  -H "X-Dashboard-Key: your-dashboard-api-key"
```

## How It Works

The AI analysis worker runs inside the proxy process and routes analysis requests through the proxy's own `/v1/messages` endpoint:

```
Analysis Worker → Local Proxy (/v1/messages) → Account Pool → Claude API
```

This approach:

- Reuses the proxy's credential management and automatic token refresh
- Benefits from account pool load balancing
- Tracks analysis usage alongside regular traffic
- Requires no separate API key management

## Monitoring

### Check Background Worker Status

Look for these log entries:

- `AI Analysis Worker: Checking for pending jobs...`
- `AI Analysis Worker: Processing job {id}`
- `AI Analysis Worker: Completed job {id}`

### Database Queries

Check pending analyses:

```sql
SELECT * FROM conversation_analyses WHERE status = 'pending';
```

Check audit log:

```sql
SELECT * FROM analysis_audit_log ORDER BY timestamp DESC LIMIT 10;
```

## Troubleshooting

### Worker Not Processing Jobs

1. Check `AI_WORKER_ENABLED=true` in `.env`
2. Verify `AI_ANALYSIS_PROJECT_ID` is set and the project exists
3. Verify the project has a linked Anthropic account
4. Check proxy logs for errors

### Analysis Shows Raw Text Instead of Structured View

If the analysis model returns a response that does not match the expected JSON structure, the dashboard displays the raw text with an amber banner. This can happen when:

1. The model ignores the structured format instructions
2. The conversation is too short or ambiguous for structured analysis
3. A custom prompt overrides the default format

You can click "Regenerate" to retry with the standard prompt. If the issue persists, consider adjusting the model via `ANTHROPIC_ANALYSIS_MODEL`.

### Analysis Failing

1. Check `error_message` in conversation_analyses table
2. Review audit log for failure details
3. Verify conversation has messages to analyze
4. Check that the proxy is running and accessible

### Rate Limiting

The API has built-in rate limits:

- Create analysis: 15 requests/minute per project ID
- Get analysis: 100 requests/minute per project ID

## Cost Considerations

- Claude Opus 4.6 usage is billed through your linked Anthropic account
- Monitor token usage in `conversation_analyses.prompt_tokens` and `completion_tokens`
- Consider using a lower-cost model via `ANTHROPIC_ANALYSIS_MODEL` if cost is a concern

## Security Notes

1. Analysis requests are routed through the proxy, leveraging existing credential security
2. Analysis results are stored in your database
3. Rate limiting prevents abuse
4. Audit logging tracks all operations

## Optional: Disable Feature

To disable AI analysis:

```bash
AI_WORKER_ENABLED=false
```

The API endpoints will still work but no background processing will occur.
