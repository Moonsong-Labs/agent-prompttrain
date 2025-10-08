# AI Analysis Feature Setup Guide

This guide will help you set up the AI-powered conversation analysis feature introduced in PR #80.

## Prerequisites

- PostgreSQL database
- Gemini API key (for AI analysis)
- Bun runtime installed

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

### 2. Environment Variables

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
AI_ANALYSIS_GEMINI_REQUEST_TIMEOUT_MS=60000 # Gemini API timeout (60 seconds)

# Gemini API Configuration (REQUIRED)
GEMINI_API_KEY=your-actual-gemini-api-key-here
GEMINI_API_URL=https://generativelanguage.googleapis.com/v1beta/models
GEMINI_MODEL_NAME=gemini-2.0-flash-exp

# Token limits for conversation truncation
AI_ANALYSIS_INPUT_TRUNCATION_TARGET_TOKENS=8192
AI_ANALYSIS_TRUNCATE_FIRST_N_TOKENS=1000
AI_ANALYSIS_TRUNCATE_LAST_M_TOKENS=4000

# Optional: Prompt tuning
# NOTE: This is for Gemini 2.0 models with 1M+ context windows
AI_MAX_PROMPT_TOKENS=855000                # Override calculated token limit
AI_HEAD_MESSAGES=10                        # Messages to keep from start
AI_TAIL_MESSAGES=30                        # Messages to keep from end
```

### 3. Get a Gemini API Key

1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Create a new API key
3. Replace `your-actual-gemini-api-key-here` in your `.env` file

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
[INFO] AI Analysis Worker: Started (polling every 5000ms)
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
2. Verify `GEMINI_API_KEY` is valid
3. Check proxy logs for errors

### Analysis Failing

1. Check `error_message` in conversation_analyses table
2. Review audit log for failure details
3. Verify conversation has messages to analyze

### Rate Limiting

The API has built-in rate limits:

- Create analysis: 15 requests/minute per project ID
- Get analysis: 100 requests/minute per project ID

## Cost Considerations

Gemini API pricing (as of 2024):

- Gemini 2.0 Flash: Free tier available
- Monitor token usage in `conversation_analyses.prompt_tokens` and `completion_tokens`

## Security Notes

1. The Gemini API key is sensitive - never commit it to git
2. Analysis results are stored in your database
3. Rate limiting prevents abuse
4. Audit logging tracks all operations

## Optional: Disable Feature

To disable AI analysis:

```bash
AI_WORKER_ENABLED=false
```

The API endpoints will still work but no background processing will occur.
