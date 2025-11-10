# API Schemas Reference

Complete reference for request and response schemas used in Agent Prompt Train.

## Claude API Schemas

### Messages API Request

```typescript
interface MessagesRequest {
  model: string // e.g., "claude-3-opus-20240229"
  messages: Message[] // Conversation history
  max_tokens: number // Maximum tokens to generate
  temperature?: number // 0.0 to 1.0 (default: 1.0)
  top_p?: number // Nucleus sampling (default: 1.0)
  top_k?: number // Top-k sampling
  metadata?: MessageMetadata // User tracking
  stop_sequences?: string[] // Stop generation at these sequences
  stream?: boolean // Enable streaming (default: false)
  system?: string // System prompt
}

interface Message {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

interface ContentBlock {
  type: 'text' | 'image'
  text?: string // For text blocks
  source?: ImageSource // For image blocks
}

interface ImageSource {
  type: 'base64'
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  data: string // Base64 encoded image data
}

interface MessageMetadata {
  user_id?: string
}
```

### Messages API Response (Non-Streaming)

```typescript
interface MessagesResponse {
  id: string // Response ID
  type: 'message'
  role: 'assistant'
  content: ContentBlock[]
  model: string
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence'
  stop_sequence?: string
  usage: TokenUsage
}

interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}
```

### Messages API Response (Streaming)

```typescript
// Server-Sent Events format
interface StreamEvent {
  event: EventType
  data: string // JSON stringified event data
}

type EventType =
  | 'message_start'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_delta'
  | 'message_stop'
  | 'error'

// Event data types
interface MessageStartEvent {
  type: 'message_start'
  message: {
    id: string
    type: 'message'
    role: 'assistant'
    content: []
    model: string
    usage: TokenUsage
  }
}

interface ContentBlockDeltaEvent {
  type: 'content_block_delta'
  index: number
  delta: {
    type: 'text_delta'
    text: string
  }
}

interface MessageStopEvent {
  type: 'message_stop'
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence'
  stop_sequence?: string
  usage?: TokenUsage // Final token counts
}
```

## Proxy API Schemas

### Token Stats Response

```typescript
interface TokenStatsResponse {
  total_requests: number
  total_tokens: {
    input: number
    output: number
    total: number
  }
  by_train: {
    [projectId: string]: {
      requests: number
      tokens: {
        input: number
        output: number
        total: number
      }
      by_type: {
        inference: number
        query_evaluation: number
      }
    }
  }
  by_model: {
    [model: string]: {
      requests: number
      tokens: {
        input: number
        output: number
        total: number
      }
    }
  }
}
```

### Health Check Response

```typescript
interface HealthResponse {
  status: 'ok' | 'error'
  timestamp?: string
  version?: string
  database?: 'connected' | 'disconnected'
}
```

## Dashboard API Schemas

### Stats Response

```typescript
interface StatsResponse {
  total_requests: number
  total_tokens: number
  active_trains: number
  total_subtasks: number
  success_rate: number // Percentage (0-100)
  average_latency: number // Milliseconds
  period: {
    start: string // ISO 8601
    end: string // ISO 8601
  }
}
```

### Token Usage Current Window

```typescript
interface CurrentUsageResponse {
  account_id: string
  window_minutes: number // Usually 300 (5 hours)
  usage: {
    tokens_used: number
    limit: number // Inferred from usage patterns
    percentage: number // Usage percentage
    reset_at: string // ISO 8601
  }
  requests: {
    count: number
    by_type: {
      inference: number
      query_evaluation: number
      quota: number
    }
  }
}
```

### Token Usage Daily

```typescript
interface DailyUsageResponse {
  account_id: string
  period: {
    start: string // ISO 8601
    end: string // ISO 8601
  }
  days: DailyUsageData[]
  totals: {
    requests: number
    input_tokens: number
    output_tokens: number
    total_tokens: number
    estimated_cost: number // USD
  }
}

interface DailyUsageData {
  date: string // YYYY-MM-DD
  requests: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  by_model: {
    [model: string]: {
      requests: number
      tokens: number
    }
  }
}
```

### Conversations Response

```typescript
interface ConversationsResponse {
  conversations: Conversation[]
  pagination: {
    total: number
    page: number
    per_page: number
    total_pages: number
  }
}

interface Conversation {
  conversation_id: string
  account_id: string
  projectId: string
  first_message_at: string // ISO 8601
  last_message_at: string // ISO 8601
  message_count: number
  total_tokens: number
  branches: Branch[]
  latest_request: RequestSummary
  has_subtasks: boolean
  subtask_count: number
}

interface Branch {
  branch_id: string
  parent_hash: string
  created_at: string
  message_count: number
}

interface RequestSummary {
  id: string
  status_code: number
  model: string
  created_at: string
}
```

### Request Details Response

```typescript
interface RequestDetailsResponse {
  id: string
  projectId: string
  account_id: string
  method: string
  path: string
  status_code: number
  error_type?: string
  error_message?: string
  model?: string
  request_type: 'inference' | 'query_evaluation' | 'quota' | 'internal_operation'
  input_tokens: number
  output_tokens: number
  total_tokens: number
  response_time_ms: number
  created_at: string
  updated_at: string
  conversation_id?: string
  branch_id?: string
  current_message_hash?: string
  parent_message_hash?: string
  is_subtask: boolean
  parent_task_request_id?: string
  request_body: any // Original request
  response_body: any // Original response
  streaming_chunks?: StreamingChunk[]
}

interface StreamingChunk {
  chunk_index: number
  content: string
  created_at: string
}
```

## Error Response Schemas

### Standard Error Response

```typescript
interface ErrorResponse {
  error: {
    type: string // Error type/code
    message: string // Human-readable message
    details?: any // Additional error details
  }
  request_id?: string
  timestamp: string
}
```

### Claude API Error Response

```typescript
interface ClaudeErrorResponse {
  type: 'error'
  error: {
    type: string // e.g., "invalid_request_error"
    message: string
  }
}
```

### OAuth Error Response

```typescript
interface OAuthErrorResponse {
  error: string // e.g., "invalid_grant"
  error_description: string // Detailed error message
}
```

## Webhook Schemas

### Slack Notification

```typescript
interface SlackWebhookPayload {
  text: string // Main message
  blocks?: SlackBlock[] // Rich formatting
  attachments?: SlackAttachment[]
}

interface SlackBlock {
  type: 'section' | 'header' | 'divider'
  text?: {
    type: 'mrkdwn' | 'plain_text'
    text: string
  }
  fields?: Array<{
    type: 'mrkdwn' | 'plain_text'
    text: string
  }>
}

interface SlackAttachment {
  color: 'good' | 'warning' | 'danger' | string
  title: string
  text: string
  fields?: Array<{
    title: string
    value: string
    short: boolean
  }>
  footer?: string
  ts?: number // Unix timestamp
}
```

## Database Schemas

### api_requests Table

```sql
CREATE TABLE api_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id VARCHAR(255) NOT NULL,
  account_id VARCHAR(255),
  method VARCHAR(10) NOT NULL,
  path VARCHAR(255) NOT NULL,
  status_code INTEGER,
  error_type VARCHAR(255),
  error_message TEXT,
  model VARCHAR(100),
  request_type VARCHAR(50),
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER GENERATED ALWAYS AS (input_tokens + output_tokens) STORED,
  response_time_ms INTEGER,
  request_body JSONB,
  response_body JSONB,
  headers JSONB,
  conversation_id UUID,
  branch_id VARCHAR(50) DEFAULT 'main',
  current_message_hash VARCHAR(64),
  parent_message_hash VARCHAR(64),
  is_subtask BOOLEAN DEFAULT FALSE,
  parent_task_request_id UUID,
  task_tool_invocation JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### streaming_chunks Table

```sql
CREATE TABLE streaming_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES api_requests(id),
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

## Type Utilities

### Common Types

```typescript
// UUID v4 format
type UUID = string

// ISO 8601 datetime
type ISODateTime = string

// Domain name
type Domain = string

// Model identifier
type ModelId = string

// Account identifier
type AccountId = string

// Request types
type RequestType = 'inference' | 'query_evaluation' | 'quota' | 'internal_operation'

// HTTP methods
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

// Status codes
type StatusCode = number
```

### Validation Helpers

```typescript
// Validate UUID
function isValidUUID(id: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  return uuidRegex.test(id)
}

// Validate project identifier
function isValidProjectId(projectId: string): boolean {
  const trainIdRegex = /^[a-zA-Z0-9._:-]+$/
  return trainIdRegex.test(projectId)
}

// Validate model
function isValidModel(model: string): boolean {
  const validModels = [
    'claude-3-opus-20240229',
    'claude-3-sonnet-20240229',
    'claude-3-haiku-20240307',
    'claude-2.1',
    'claude-2.0',
    'claude-instant-1.2',
  ]
  return validModels.includes(model)
}
```

## Next Steps

- [API Reference](../02-User-Guide/api-reference.md)
- [Authentication Guide](../02-User-Guide/authentication.md)
- [Database Schema](../03-Operations/database.md)
