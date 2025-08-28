# AI-Powered Conversation Analysis Feature - Implementation Plan

## Executive Summary

This document outlines the implementation plan for adding an AI-powered conversation analysis feature to the Agent Prompt Train Dashboard. The feature will allow users to generate intelligent summaries and insights for conversations using the Gemini API, with analysis stored per conversation branch.

## Feature Overview

### User Story

As a dashboard user, I want to generate AI-powered analysis of conversations so that I can quickly understand conversation patterns, key topics, sentiment, and actionable insights without reading through entire conversation histories.

### Key Requirements

1. **Per-branch analysis**: Each conversation branch can have independent analysis
2. **Asynchronous processing**: Analysis generation may take up to 1 minute
3. **Persistent storage**: Analysis results are stored and reusable
4. **Regeneration capability**: Users can request fresh analysis
5. **Metadata tracking**: Display when, how, and with which model analysis was generated

## Technical Architecture

### 1. Database Schema

Create a new table `conversation_analyses` to store analysis results:

```sql
-- Table to store AI-generated analysis for conversation branches
CREATE TABLE conversation_analyses (
    -- Primary key
    id BIGSERIAL PRIMARY KEY,

    -- Conversation reference (matching existing schema pattern)
    conversation_id UUID NOT NULL,
    branch_id VARCHAR(255) NOT NULL DEFAULT 'main',

    -- Processing status
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),

    -- Analysis configuration
    model_used VARCHAR(255) DEFAULT 'gemini-2.5-pro',

    -- Analysis results
    analysis_content TEXT,              -- Markdown formatted analysis
    analysis_data JSONB,                -- Structured data (summary, topics, sentiment)
    raw_response JSONB,                 -- Full Gemini API response for debugging

    -- Error tracking
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,

    -- Performance metrics
    generated_at TIMESTAMPTZ,
    processing_duration_ms INTEGER,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Ensure one analysis per conversation branch
    UNIQUE (conversation_id, branch_id)
);

-- Performance indexes
CREATE INDEX idx_conversation_analyses_status
    ON conversation_analyses (status)
    WHERE status = 'pending';

CREATE INDEX idx_conversation_analyses_conversation
    ON conversation_analyses (conversation_id, branch_id);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_timestamp
BEFORE UPDATE ON conversation_analyses
FOR EACH ROW
EXECUTE FUNCTION trigger_set_timestamp();
```

### 2. API Design

The dashboard service (port 3001) will expose the following endpoints:

#### Trigger Analysis

```http
POST /api/analyses
X-Dashboard-Key: <api-key>
Content-Type: application/json

{
  "conversationId": "uuid",
  "branchId": "main"
}
```

**Response (201 Created):**

```json
{
  "id": 123,
  "conversationId": "uuid",
  "branchId": "main",
  "status": "pending",
  "createdAt": "2024-01-15T10:00:00Z"
}
```

**Response (409 Conflict - if already exists):**

```json
{
  "error": "Analysis already exists",
  "analysis": {
    "id": 123,
    "status": "completed",
    "analysisContent": "..."
  }
}
```

#### Get Analysis Status/Result

```http
GET /api/analyses/:conversationId/:branchId
X-Dashboard-Key: <api-key>
```

**Response (200 OK):**

```json
{
  "id": 123,
  "conversationId": "uuid",
  "branchId": "main",
  "status": "completed",
  "analysis": {
    "content": "## Conversation Summary\n\n...",
    "data": {
      "summary": "User requested help with...",
      "keyTopics": ["API integration", "authentication"],
      "sentiment": "positive",
      "actionItems": ["Review API docs", "Update auth flow"]
    },
    "modelUsed": "gemini-2.5-pro",
    "generatedAt": "2024-01-15T10:01:00Z",
    "processingDurationMs": 45000
  }
}
```

#### Regenerate Analysis

```http
POST /api/analyses/:conversationId/:branchId/regenerate
X-Dashboard-Key: <api-key>
```

**Response (200 OK):**

```json
{
  "id": 123,
  "status": "pending",
  "message": "Analysis regeneration queued"
}
```

### 3. Background Processing

#### Worker Implementation

```typescript
// Background worker pseudo-code
class AnalysisWorker {
  async processJob() {
    // 1. Claim a pending job with row locking
    const job = await db.transaction(async trx => {
      const job = await trx
        .selectFrom('conversation_analyses')
        .where('status', '=', 'pending')
        .orderBy('created_at', 'asc')
        .limit(1)
        .forUpdate()
        .skipLocked()
        .selectAll()
        .executeTakeFirst()

      if (!job) return null

      // 2. Mark as processing
      await trx
        .updateTable('conversation_analyses')
        .set({
          status: 'processing',
          updated_at: new Date(),
        })
        .where('id', '=', job.id)
        .execute()

      return job
    })

    if (!job) return

    try {
      // 3. Fetch conversation data
      const messages = await fetchConversationMessages(job.conversation_id, job.branch_id)

      // 4. Prepare prompt with smart truncation
      const prompt = await prepareAnalysisPrompt(messages)

      // 5. Call Gemini API
      const startTime = Date.now()
      const response = await callGeminiAPI(prompt, job.model_used)
      const duration = Date.now() - startTime

      // 6. Update with results
      await updateAnalysisResult(job.id, {
        status: 'completed',
        analysis_content: response.content,
        analysis_data: response.data,
        raw_response: response.raw,
        generated_at: new Date(),
        processing_duration_ms: duration,
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
      })
    } catch (error) {
      await handleError(job.id, error)
    }
  }
}
```

#### Watchdog Process

```typescript
// Cleanup stuck jobs older than 5 minutes
async function cleanupStuckJobs() {
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000)

  await db
    .updateTable('conversation_analyses')
    .set({
      status: 'pending',
      retry_count: sql`retry_count + 1`,
      updated_at: new Date(),
    })
    .where('status', '=', 'processing')
    .where('updated_at', '<', staleThreshold)
    .where('retry_count', '<', 3)
    .execute()

  // Mark as permanently failed after 3 retries
  await db
    .updateTable('conversation_analyses')
    .set({
      status: 'failed',
      error_message: 'Max retries exceeded',
      updated_at: new Date(),
    })
    .where('status', '=', 'processing')
    .where('updated_at', '<', staleThreshold)
    .where('retry_count', '>=', 3)
    .execute()
}
```

### 4. Prompt Engineering

#### Analysis Prompt Template

```typescript
const ANALYSIS_PROMPT = `You are an expert conversation analyst. Analyze the following conversation and provide insights.

Your response MUST be a valid JSON object with this exact structure:
{
  "summary": "A 2-3 sentence executive summary of the conversation",
  "keyTopics": ["array", "of", "main", "topics", "discussed"],
  "sentiment": "positive|neutral|negative|mixed",
  "userIntent": "What the user was trying to accomplish",
  "outcomes": ["What was achieved", "What remains unresolved"],
  "actionItems": ["Specific follow-up actions if any"],
  "technicalDetails": {
    "frameworks": ["Technologies or frameworks discussed"],
    "issues": ["Technical problems mentioned"],
    "solutions": ["Solutions provided or suggested"]
  },
  "conversationQuality": {
    "clarity": "high|medium|low",
    "completeness": "complete|partial|incomplete",
    "effectiveness": "highly effective|effective|needs improvement"
  }
}

Conversation to analyze:
<conversation>
{{MESSAGES}}
</conversation>

Remember: Respond ONLY with the JSON object, no additional text.`
```

#### Smart Truncation Strategy

```typescript
async function prepareAnalysisPrompt(messages: Message[]): Promise<string> {
  const MAX_TOKENS = 900000 // Safe limit for Gemini's 1M context window
  const tokenizer = new GeminiTokenizer()

  // Start with full conversation
  let conversationText = formatMessages(messages)
  let tokenCount = await tokenizer.count(ANALYSIS_PROMPT + conversationText)

  if (tokenCount <= MAX_TOKENS) {
    return ANALYSIS_PROMPT.replace('{{MESSAGES}}', conversationText)
  }

  // Apply middle-out truncation
  const firstN = 5 // Keep first 5 messages
  const lastM = 20 // Keep last 20 messages

  const truncated = [
    ...messages.slice(0, firstN),
    { role: 'system', content: '[... middle messages truncated for length ...]' },
    ...messages.slice(-lastM),
  ]

  conversationText = formatMessages(truncated)
  return ANALYSIS_PROMPT.replace('{{MESSAGES}}', conversationText)
}
```

### 5. UI/UX Implementation

#### React Component Structure

```typescript
// AnalysisPanel.tsx
interface AnalysisPanelProps {
  conversationId: string;
  branchId: string;
}

export function AnalysisPanel({ conversationId, branchId }: AnalysisPanelProps) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [status, setStatus] = useState<AnalysisStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // Check for existing analysis on mount
  useEffect(() => {
    checkAnalysis();
  }, [conversationId, branchId]);

  // Poll for updates when processing
  useEffect(() => {
    if (status === 'pending' || status === 'processing') {
      const interval = setInterval(checkAnalysis, 5000);
      return () => clearInterval(interval);
    }
  }, [status]);

  const generateAnalysis = async () => {
    try {
      setStatus('pending');
      setError(null);

      const response = await fetch('/api/analyses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dashboard-Key': getDashboardKey()
        },
        body: JSON.stringify({ conversationId, branchId })
      });

      if (response.status === 409) {
        // Analysis already exists
        const data = await response.json();
        setAnalysis(data.analysis);
        setStatus(data.analysis.status);
      } else if (response.ok) {
        setStatus('pending');
      }
    } catch (err) {
      setError('Failed to generate analysis');
      setStatus('idle');
    }
  };

  // Render based on status
  if (status === 'idle' && !analysis) {
    return (
      <Card>
        <Button onClick={generateAnalysis}>
          Generate AI Analysis
        </Button>
      </Card>
    );
  }

  if (status === 'pending' || status === 'processing') {
    return (
      <Card>
        <Spinner />
        <p>Analyzing conversation... This may take up to a minute.</p>
      </Card>
    );
  }

  if (status === 'completed' && analysis) {
    return (
      <Card>
        <AnalysisDisplay analysis={analysis} />
        <AnalysisMetadata
          model={analysis.modelUsed}
          generatedAt={analysis.generatedAt}
          duration={analysis.processingDurationMs}
        />
        <Button variant="secondary" onClick={regenerateAnalysis}>
          Regenerate Analysis
        </Button>
      </Card>
    );
  }

  if (status === 'failed') {
    return (
      <Card>
        <Alert variant="error">{error || 'Analysis failed'}</Alert>
        <Button onClick={generateAnalysis}>Try Again</Button>
      </Card>
    );
  }
}
```

### 6. Configuration & Environment Variables

Add to dashboard service `.env`:

```bash
# Gemini API Configuration
GEMINI_API_KEY=AIza...
GEMINI_API_URL=https://generativelanguage.googleapis.com/v1beta
GEMINI_DEFAULT_MODEL=gemini-2.5-pro

# Analysis Feature
ANALYSIS_ENABLED=true
ANALYSIS_MAX_RETRIES=3
ANALYSIS_TIMEOUT_MS=300000  # 5 minutes
ANALYSIS_WORKER_POLL_INTERVAL=5000  # 5 seconds
ANALYSIS_WATCHDOG_INTERVAL=60000  # 1 minute

# Token Limits
ANALYSIS_MAX_PROMPT_TOKENS=900000
ANALYSIS_TRUNCATE_FIRST_N=5
ANALYSIS_TRUNCATE_LAST_M=20
```

### 7. Security Considerations

1. **Database Access**
   - Worker process uses least-privilege role (SELECT/UPDATE only)
   - No DELETE or DDL permissions
   - Row-level security if multi-tenant

2. **Input Validation**
   - Validate UUIDs before database queries
   - Sanitize conversation content before API calls
   - Rate limiting on analysis endpoints

3. **Audit Trail**
   - Log all analysis requests with user context
   - Track regeneration requests
   - Monitor for abuse patterns

### 8. Monitoring & Observability

#### Metrics to Track

```typescript
// Prometheus metrics
analysis_requests_total{status="success|failure"}
analysis_processing_duration_seconds
analysis_queue_depth
analysis_worker_errors_total{error_type}
analysis_token_usage{type="prompt|completion"}
```

#### Logging

```typescript
// Structured logging
logger.info('Analysis requested', {
  conversationId,
  branchId,
  userId,
  correlationId,
})

logger.error('Analysis failed', {
  jobId,
  error: error.message,
  retryCount,
  duration,
})
```

### 9. Migration Plan

1. **Database Migration**

   ```bash
   # Create new migration file
   scripts/db/migrations/007-add-conversation-analysis.ts
   ```

2. **Deployment Steps**
   - Deploy database migration
   - Deploy dashboard service with worker disabled
   - Verify API endpoints
   - Enable worker process
   - Monitor for issues

### 10. Testing Strategy

1. **Unit Tests**
   - Prompt generation with truncation
   - API endpoint handlers
   - Worker job processing

2. **Integration Tests**
   - End-to-end analysis generation
   - Concurrent worker handling
   - Error recovery scenarios

3. **Load Tests**
   - Multiple simultaneous analysis requests
   - Worker scalability
   - Database connection pooling

## Future Enhancements

1. **Real-time Updates**: Implement SSE for live progress updates
2. **Batch Analysis**: Analyze multiple conversations at once
3. **Custom Prompts**: Allow users to specify analysis focus
4. **Export Options**: PDF/CSV export of analysis results
5. **Comparative Analysis**: Compare branches or conversations
6. **Scheduled Analysis**: Auto-analyze new conversations
7. **Redis Queue**: Migrate from DB polling to Redis/BullMQ for scale

## Success Criteria

1. Users can generate analysis with one click
2. Analysis completes within 60 seconds for 95% of requests
3. Results are accurate and actionable
4. System handles concurrent requests gracefully
5. Failed analyses can be retried successfully
6. No impact on existing dashboard performance

## Risk Mitigation

1. **API Rate Limits**: Implement request queuing and backoff
2. **Large Conversations**: Smart truncation prevents token overflow
3. **Worker Failures**: Watchdog ensures no jobs get stuck
4. **Database Load**: Partial indexes keep queries fast
5. **Cost Control**: Token tracking and limits prevent runaway costs
