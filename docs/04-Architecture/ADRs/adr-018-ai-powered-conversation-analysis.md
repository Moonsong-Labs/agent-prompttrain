# ADR-016: AI-Powered Conversation Analysis

## Status

Accepted

## Context

As the Agent Prompt Train processes increasing volumes of conversations, users need insights into conversation patterns, quality, and outcomes. Currently, users must manually review conversations to understand:

- Conversation effectiveness and quality
- Common user patterns and pain points
- Task completion rates and efficiency
- Areas for improvement in AI interactions

Manual analysis is time-consuming and doesn't scale. We need an automated system to analyze conversations and provide actionable insights using AI models.

## Decision Drivers

- **Scalability**: Must handle analyzing thousands of conversations efficiently
- **Flexibility**: Support multiple AI models (Gemini, Claude, etc.)
- **Performance**: Background processing to avoid impacting proxy performance
- **Cost Control**: Manage API costs through smart batching and caching
- **Privacy**: Ensure conversation data remains secure during analysis
- **Extensibility**: Easy to add new analysis types and metrics

## Considered Options

1. **Real-time Analysis During Proxy Requests**
   - Description: Analyze conversations as they happen during proxy requests
   - Pros: Immediate insights, no batch processing needed
   - Cons: Adds latency to requests, increases costs, harder to manage failures

2. **Dedicated Analysis Microservice**
   - Description: Separate service that pulls conversations and analyzes them
   - Pros: Complete isolation, independent scaling, technology flexibility
   - Cons: Complex deployment, data synchronization challenges, operational overhead

3. **Background Jobs in Proxy Service**
   - Description: Background workers within the proxy service using database polling
   - Pros: Simple deployment, shared database access, easier maintenance
   - Cons: Competes for proxy resources, requires careful resource management

4. **Event-Driven Lambda/Cloud Functions**
   - Description: Serverless functions triggered by conversation completion
   - Pros: Auto-scaling, pay-per-use, no infrastructure management
   - Cons: Vendor lock-in, cold starts, complex local development

## Decision

We will implement **Background Jobs in Proxy Service** with database polling for the initial implementation, with a clear migration path to a dedicated microservice if needed.

### Implementation Details

1. **Database Schema**:

   ```sql
   CREATE TABLE conversation_analyses (
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
       UNIQUE (conversation_id, branch_id)
   );
   ```

2. **Processing Strategy**:
   - Database polling with row-level locking
   - Configurable batch sizes and processing intervals
   - Exponential backoff for retries
   - Smart truncation for long conversations

3. **API Design**:

   ```typescript
   POST /api/analyses - Create analysis request
   GET /api/analyses/:conversationId/:branchId - Get analysis
   POST /api/analyses/:conversationId/:branchId/regenerate - Force regeneration
   ```

4. **Cost Management**:
   - Token counting before submission
   - Configurable limits per conversation
   - Message truncation strategies
   - Caching of analysis results

## Consequences

### Positive

- **Simple Deployment**: No additional infrastructure required initially
- **Shared Resources**: Reuses existing database connections and monitoring
- **Easy Migration Path**: Can extract to microservice when needed
- **Cost Effective**: Controlled processing with configurable limits
- **Flexible Analysis**: Supports multiple AI providers through configuration

### Negative

- **Resource Competition**: Background jobs compete with proxy traffic
- **Scaling Limitations**: Tied to proxy service scaling
- **Deployment Coupling**: Updates require proxy service restart

### Risks and Mitigations

- **Risk**: Background jobs impacting proxy performance
  - **Mitigation**: Configurable concurrency limits and resource monitoring
  - **Mitigation**: Job throttling based on system load metrics

- **Risk**: Long-running analyses blocking other conversations
  - **Mitigation**: Timeout controls and conversation size limits
  - **Mitigation**: Priority queue implementation for fair processing

- **Risk**: High API costs from analyzing large conversations
  - **Mitigation**: Token counting and limits before API calls
  - **Mitigation**: Smart sampling for very long conversations

## Implementation Phases

1. **Phase 1** (Completed): Database schema and basic API endpoints
2. **Phase 2** (In Progress):
   - API Design (Completed - Task 2)
   - Prompt engineering (Completed - Task 4)
   - Background worker implementation with Gemini integration (Completed - Task 3)
3. **Phase 3**: Dashboard UI for viewing analyses
4. **Phase 4**: Advanced features (custom prompts, comparison views)
5. **Phase 5**: Consider extraction to dedicated microservice

### Phase 1 Details (Completed)

- Database schema implemented (Migration 011)
- Conversation analyses table with proper indexing
- Support for status tracking, token usage, and retry logic

### Phase 2 - Task 2: API Design (Completed)

- **Dashboard API Routes**: Implemented in `services/dashboard/src/routes/analysis-api.ts`
- **Type Definitions**: Added to `packages/shared/src/types/ai-analysis.ts`
- **Request Validation**: Using Zod schemas for type-safe validation
- **Error Handling**: Consistent with existing dashboard patterns
- **Authentication**: Integrated with global `dashboardAuth` middleware

Key endpoints implemented:

- `POST /api/analyses` - Create analysis request with 409 conflict handling
- `GET /api/analyses/:conversationId/:branchId` - Get analysis status/result
- `POST /api/analyses/:conversationId/:branchId/regenerate` - Force regeneration

### Phase 2 - Task 4: Prompt Engineering (Completed)

- **Tokenizer**: Using @lenml/tokenizer-gemini for local token counting
- **Smart Truncation**: Tail-first priority with 855k token limit (5% safety margin)
- **Prompt Structure**: Multi-turn format using Gemini's native content structure
- **Response Validation**: Zod schema for runtime validation
- **Configuration**: Comprehensive environment variable support for all ANALYSIS_PROMPT_CONFIG parameters

Key files:

- `packages/shared/src/types/ai-analysis.ts` - Analysis schema
- `packages/shared/src/prompts/truncation.ts` - Smart truncation logic
- `packages/shared/src/prompts/analysis/` - Versioned prompt templates

### Phase 2 - Task 3: Background Worker (Completed)

- **Worker Architecture**: In-process background worker with database polling
- **Job Management**: PostgreSQL row-level locking with `FOR UPDATE SKIP LOCKED`
- **Gemini Integration**: Direct API integration with security improvements
- **Error Handling**:
  - Exponential backoff with jitter for retries
  - Automatic failure of jobs exceeding MAX_RETRIES
  - Graceful handling of unparseable JSON responses
  - Non-retryable error detection for schema validation failures
- **Graceful Shutdown**: Proper lifecycle management with timeout controls
- **Configuration**: Environment-based configuration for all worker parameters

Key files:

- `services/proxy/src/workers/ai-analysis/AnalysisWorker.ts` - Main worker class
- `services/proxy/src/workers/ai-analysis/db.ts` - Database operations with `failJobsExceedingMaxRetries`
- `services/proxy/src/workers/ai-analysis/GeminiService.ts` - Gemini API client with JSON fallback
- `services/proxy/src/workers/ai-analysis/index.ts` - Worker lifecycle management

### Phase 2 - Error Handling Improvements (Completed)

- **JSON Parse Failures**: When the AI model returns unparseable JSON, the system now:
  - Catches parse errors gracefully
  - Stores the raw text response as `analysis_content`
  - Sets `analysis_data` to null
  - Displays the raw text in the UI instead of failing

- **Maximum Retry Handling**: Jobs that exceed `AI_ANALYSIS_MAX_RETRIES`:
  - Are automatically marked as failed during the worker's stuck job handling cycle
  - Display error status in the UI with clear messaging
  - No longer remain stuck in pending status indefinitely

- **Schema Validation**: Updated retry prompts to match current data structure:
  - Fixed `actionItems` schema from array of strings to array of objects
  - Each action item now has `type`, `description`, and `priority` fields

- **Utility Scripts**: Added management scripts for troubleshooting:
  - `bun run ai:check-jobs` - Check analysis job statuses
  - `bun run ai:check-content` - Inspect analysis content
  - `bun run ai:reset-stuck` - Reset jobs with high retry counts
  - `bun run ai:fail-exceeded` - Manually fail jobs exceeding retries
  - `bun run ai:test-max-retry` - Create test jobs for max retry handling

## Links

- [Feature Plan](../feature-plan-ai-analysis.md)
- [Database Schema Evolution ADR](./adr-012-database-schema-evolution.md)
- [PR #75: Database Schema Implementation](https://github.com/Moonsong-Labs/agent-prompttrain/pull/75)

## Notes

- Initial implementation focuses on Gemini 2.5 Pro for cost-effectiveness
- Analysis prompts should be configurable via environment variables
- Consider implementing webhook notifications for completed analyses
- Future enhancement: Real-time analysis triggers based on conversation events

---

Date: 2025-01-08
Authors: AI Development Team
