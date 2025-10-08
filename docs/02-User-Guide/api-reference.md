# API Reference

Agent Prompt Train provides a transparent proxy to Claude's API with additional features.

## Base URL

```
http://localhost:3000  # Development
https://api.yourdomain.com  # Production
```

## Authentication

### Client to Proxy

Include your client API key in the Authorization header:

```bash
Authorization: Bearer cnp_live_YOUR_KEY
```

### Train & Account Headers

Use the `MSL-Project-Id` header to associate requests with a project/train, and optionally
`MSL-Account` to select a specific Anthropic account credential:

```bash
MSL-Project-Id: train-alpha
MSL-Account: account-primary  # optional
```

## Endpoints

### Messages API

#### Create Message

```http
POST /v1/messages
```

Creates a new message with Claude.

**Request:**

```json
{
  "model": "claude-3-opus-20240229",
  "messages": [
    {
      "role": "user",
      "content": "Hello, Claude!"
    }
  ],
  "max_tokens": 1000,
  "stream": false
}
```

**Response (Non-streaming):**

```json
{
  "id": "msg_123",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "Hello! How can I help you today?"
    }
  ],
  "model": "claude-3-opus-20240229",
  "usage": {
    "input_tokens": 10,
    "output_tokens": 15
  }
}
```

**Response (Streaming):**

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_123",...}}

event: content_block_start
data: {"type":"content_block_start","index":0,...}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"text":"Hello"},...}

event: message_stop
data: {"type":"message_stop"}
```

### Token Statistics

#### Get Token Usage

```http
GET /token-stats
```

Returns token usage statistics per project ID.

**Response:**

```json
{
  "train-alpha": {
    "total_requests": 150,
    "total_input_tokens": 45000,
    "total_output_tokens": 62000,
    "total_cache_creation_tokens": 1000,
    "total_cache_read_tokens": 500,
    "request_types": {
      "inference": 145,
      "query_evaluation": 5
    },
    "models": {
      "claude-3-opus-20240229": 100,
      "claude-3-sonnet-20240229": 50
    }
  }
}
```

### Health Check

#### Proxy Health

```http
GET /health
```

**Response:**

```json
{
  "status": "healthy",
  "version": "2.0.0",
  "uptime": 3600
}
```

## Dashboard API

### Base URL

```
http://localhost:3001  # Development
https://dashboard.yourdomain.com  # Production
```

### Authentication

Include the dashboard API key in the Authorization header:

```bash
Authorization: Bearer YOUR_DASHBOARD_KEY
```

### Endpoints

#### List Requests

```http
GET /api/requests?limit=50&offset=0&projectId=train-alpha
```

**Query Parameters:**

- `limit` - Number of results (default: 50, max: 100)
- `offset` - Pagination offset
- `projectId` - Filter by train
- `model` - Filter by model
- `from` - Start date (ISO 8601)
- `to` - End date (ISO 8601)

**Response:**

```json
{
  "requests": [
    {
      "request_id": "uuid",
      "timestamp": "2024-01-15T10:00:00Z",
      "projectId": "train-alpha",
      "model": "claude-3-opus-20240229",
      "input_tokens": 100,
      "output_tokens": 200,
      "duration_ms": 1500,
      "conversation_id": "uuid",
      "branch_id": "main"
    }
  ],
  "total": 1000,
  "limit": 50,
  "offset": 0
}
```

#### Get Request Details

```http
GET /api/requests/:id
```

**Response:**

```json
{
  "request_id": "uuid",
  "timestamp": "2024-01-15T10:00:00Z",
  "projectId": "train-alpha",
  "request": {
    "messages": [...],
    "model": "claude-3-opus-20240229"
  },
  "response": {
    "content": [...],
    "usage": {...}
  },
  "metadata": {
    "conversation_id": "uuid",
    "branch_id": "main",
    "message_count": 5
  }
}
```

#### List Conversations

```http
GET /api/conversations?projectId=train-alpha&accountId=acc_123&limit=50&offset=0&dateFrom=2024-01-01T00:00:00Z&dateTo=2024-01-31T23:59:59Z
```

**Query Parameters:**

- `projectId` - Filter by train (optional)
- `accountId` - Filter by account (optional)
- `limit` - Number of conversations per page (default: 50)
- `offset` - Number of conversations to skip for pagination (default: 0)
- `dateFrom` - Filter conversations after this date (ISO 8601 format, optional)
- `dateTo` - Filter conversations before this date (ISO 8601 format, optional)

**Response:**

```json
{
  "conversations": [
    {
      "conversationId": "uuid",
      "projectId": "train-alpha",
      "accountId": "acc_123",
      "firstMessageTime": "2024-01-15T09:00:00Z",
      "lastMessageTime": "2024-01-15T10:00:00Z",
      "messageCount": 20,
      "totalTokens": 5000,
      "branchCount": 2,
      "subtaskBranchCount": 0,
      "compactBranchCount": 0,
      "userBranchCount": 1,
      "modelsUsed": ["claude-3-opus-20240229"],
      "latestRequestId": "req_abc123",
      "latestModel": "claude-3-opus-20240229",
      "latestContextTokens": 2500,
      "isSubtask": false,
      "subtaskMessageCount": 0
    }
  ],
  "pagination": {
    "total": 1250,
    "limit": 50,
    "offset": 0,
    "hasMore": true,
    "page": 1,
    "totalPages": 25
  }
}
```

#### Get Dashboard Statistics

```http
GET /api/dashboard/stats?projectId=train-alpha&accountId=acc_123
```

Optimized endpoint for dashboard overview page that returns aggregated statistics in a single query.

**Query Parameters:**

- `projectId` - Filter by train (optional)
- `accountId` - Filter by account (optional)

**Response:**

```json
{
  "totalConversations": 1250,
  "activeUsers": 42,
  "totalRequests": 15000,
  "totalTokens": 3500000,
  "totalBranches": 180,
  "subtaskBranches": 25,
  "compactBranches": 10,
  "modelsUsed": ["claude-3-opus-20240229", "claude-3-sonnet-20240229"],
  "modelsUsedCount": 2,
  "last24Hours": {
    "requests": 500,
    "conversations": 85,
    "activeUsers": 12
  },
  "hourlyActivity": [
    {
      "hour": "2024-01-15T10:00:00Z",
      "requestCount": 25,
      "tokenCount": 15000
    }
  ]
}
```

#### Get Conversation Details

```http
GET /api/conversations/:id
```

**Response:**

```json
{
  "conversation_id": "uuid",
  "requests": [
    {
      "request_id": "uuid",
      "timestamp": "2024-01-15T09:00:00Z",
      "branch_id": "main",
      "message_count": 2,
      "parent_message_hash": null,
      "current_message_hash": "abc123..."
    }
  ],
  "branches": {
    "main": {
      "request_count": 8,
      "created_at": "2024-01-15T09:00:00Z"
    },
    "branch-2024-01-15-09-30-00": {
      "request_count": 2,
      "created_at": "2024-01-15T09:30:00Z",
      "branched_from": "def456..."
    }
  }
}
```

#### Conversation Analysis

AI-powered analysis of conversations using Gemini models to provide insights, summaries, and actionable feedback.

##### Create Analysis Request

```http
POST /api/analyses
```

Creates a new analysis request for a conversation.

**Request:**

```json
{
  "conversation_id": "uuid",
  "branch_id": "main", // optional, defaults to "main"
  "customPrompt": "Focus on security implications" // optional
}
```

**Response:**

```json
{
  "id": "123456",
  "conversation_id": "uuid",
  "branch_id": "main",
  "status": "pending",
  "created_at": "2024-01-15T10:00:00Z"
}
```

##### Get Analysis

```http
GET /api/analyses/:conversationId/:branchId
```

Retrieves the analysis for a specific conversation and branch.

**Response:**

```json
{
  "id": "123456",
  "conversation_id": "uuid",
  "branch_id": "main",
  "status": "completed",
  "model_used": "gemini-2.5-pro",
  "analysis_content": "This conversation shows...",
  "analysis_data": {
    "summary": "...",
    "insights": ["..."],
    "metrics": {...}
  },
  "generated_at": "2024-01-15T10:05:00Z",
  "processing_duration_ms": 2500,
  "prompt_tokens": 1000,
  "completion_tokens": 500
}
```

##### Regenerate Analysis

```http
POST /api/analyses/:conversationId/:branchId/regenerate
```

Forces regeneration of an existing analysis.

**Request:**

```json
{
  "customPrompt": "Analyze performance implications" // optional
}
```

**Response:** Same as Get Analysis endpoint.

#### Token Analytics

```http
GET /api/analytics/tokens?period=day&days=7
```

**Query Parameters:**

- `period` - Aggregation period: `hour`, `day`, `week`
- `days` - Number of days to include

**Response:**

```json
{
  "periods": [
    {
      "period": "2024-01-15",
      "trains": {
        "train-alpha": {
          "input_tokens": 10000,
          "output_tokens": 15000,
          "cache_tokens": 500,
          "requests": 50
        }
      }
    }
  ]
}
```

#### Token Usage - Current Window

```http
GET /api/token-usage/current?accountId=acc_123&window=300
```

Get token usage for the current sliding window (default 5 hours).

**Query Parameters:**

- `accountId` - Account identifier (required)
- `window` - Window size in minutes (default: 300)
- `projectId` - Filter by train (optional)
- `model` - Filter by model (optional)

**Response:**

```json
{
  "accountId": "acc_123",
  "projectId": "train-alpha",
  "model": "claude-3-opus-20240229",
  "windowStart": "2024-01-15T05:00:00Z",
  "windowEnd": "2024-01-15T10:00:00Z",
  "totalInputTokens": 45000,
  "totalOutputTokens": 62000,
  "totalTokens": 107000,
  "totalRequests": 150,
  "cacheCreationInputTokens": 1000,
  "cacheReadInputTokens": 500
}
```

#### Token Usage - Daily

```http
GET /api/token-usage/daily?accountId=acc_123&days=30&aggregate=true
```

Get daily token usage statistics.

**Query Parameters:**

- `accountId` - Account identifier (required)
- `days` - Number of days to retrieve (default: 30)
- `projectId` - Filter by train (optional)
- `aggregate` - Aggregate across models (default: false)

**Response:**

```json
{
  "usage": [
    {
      "date": "2024-01-15",
      "accountId": "acc_123",
      "projectId": "train-alpha",
      "totalInputTokens": 100000,
      "totalOutputTokens": 150000,
      "totalTokens": 250000,
      "totalRequests": 500
    }
  ]
}
```

#### Rate Limits Configuration

```http
GET /api/rate-limits?accountId=acc_123
```

Get rate limit configurations.

**Query Parameters:**

- `accountId` - Filter by account
- `projectId` - Filter by train
- `model` - Filter by model

**Response:**

```json
{
  "configs": [
    {
      "id": 1,
      "accountId": "acc_123",
      "projectId": null,
      "model": "claude-3-opus-20240229",
      "windowMinutes": 300,
      "tokenLimit": 140000,
      "requestLimit": null,
      "fallbackModel": "claude-3-haiku-20240307",
      "enabled": true
    }
  ]
}
```

#### Update Rate Limit

```http
POST /api/rate-limits/:id
```

Update a rate limit configuration.

**Request:**

```json
{
  "tokenLimit": 200000,
  "fallbackModel": "claude-3-haiku-20240307",
  "enabled": true
}
```

**Response:**

```json
{
  "config": {
    "id": 1,
    "tokenLimit": 200000,
    "fallbackModel": "claude-3-haiku-20240307",
    "enabled": true
  }
}
```

#### Server-Sent Events

```http
GET /sse
```

Streams real-time updates for requests.

**Event Format:**

```
event: request
data: {"request_id":"uuid","projectId":"train-alpha","timestamp":"2024-01-15T10:00:00Z"}

event: stats
data: {"total_requests":1000,"active_trains":5}
```

## Error Responses

### Error Format

```json
{
  "error": {
    "type": "invalid_request_error",
    "message": "Invalid API key provided"
  }
}
```

### Common Error Codes

| Status Code | Type                    | Description                            |
| ----------- | ----------------------- | -------------------------------------- |
| 400         | `invalid_request_error` | Invalid request parameters             |
| 401         | `authentication_error`  | Invalid or missing API key             |
| 403         | `permission_error`      | Valid key but insufficient permissions |
| 404         | `not_found_error`       | Resource not found                     |
| 429         | `rate_limit_error`      | Rate limit exceeded                    |
| 500         | `internal_server_error` | Server error                           |
| 502         | `api_error`             | Claude API error                       |

## Rate Limiting

The proxy forwards Claude's rate limiting headers:

```
x-ratelimit-limit: 100
x-ratelimit-remaining: 99
x-ratelimit-reset: 1705315200
```

## Conversation Tracking

The proxy automatically tracks conversations using message content hashing:

1. Each message is hashed using SHA-256
2. Parent-child relationships are established
3. Branches are created when conversations diverge
4. Message counts are tracked

### Branch Naming

Branches are named using timestamps:

- Main branch: `main`
- Other branches: `branch-YYYY-MM-DD-HH-MM-SS`

## Best Practices

### Streaming Responses

For long responses, use streaming:

```javascript
const response = await fetch('/v1/messages', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_KEY',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    messages: [...],
    stream: true
  })
})

const reader = response.body.getReader()
// Process stream...
```

### Error Handling

Always check for errors:

```javascript
if (!response.ok) {
  const error = await response.json()
  console.error('API Error:', error.error.message)
}
```

### Conversation Context

Maintain conversation context by including message history:

```json
{
  "messages": [
    { "role": "user", "content": "Hello" },
    { "role": "assistant", "content": "Hi there!" },
    { "role": "user", "content": "How are you?" }
  ]
}
```
