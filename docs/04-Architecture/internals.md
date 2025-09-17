# Internals

Deep dive into the Agent Prompt Train implementation details, architecture patterns, and design decisions.

## System Architecture

### Component Overview

```
┌─────────────────┐     ┌─────────────────┐
│   Client App    │     │    Dashboard    │
└────────┬────────┘     └────────┬────────┘
         │                       │
         │ HTTP                  │ HTTP/SSE
         ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│  Proxy Service  │     │ Dashboard Svc   │
│   (Port 3000)   │     │  (Port 3001)    │
└────────┬────────┘     └────────┬────────┘
         │                       │
         │ PostgreSQL            │ PostgreSQL
         │ (Write)               │ (Read)
         ▼                       ▼
┌─────────────────────────────────────────┐
│           PostgreSQL Database           │
│  - api_requests (partitioned)          │
│  - streaming_chunks                    │
│  - token_usage (partitioned)           │
└─────────────────────────────────────────┘
         │
         │ API Calls
         ▼
┌─────────────────┐
│   Claude API    │
└─────────────────┘
```

### Request Flow

1. **Client Request** → Proxy Service
2. **Authentication** → Validate client API key
3. **Train Resolution** → Load credentials for train
4. **Request Enhancement** → Add auth headers, tracking
5. **Claude API Call** → Forward to Anthropic
6. **Response Processing** → Stream or JSON response
7. **Storage** → Async write to PostgreSQL
8. **Response** → Return to client

## Core Components

### 1. Proxy Service

#### Request Pipeline

```typescript
// Simplified request flow
async function handleRequest(c: Context) {
  // 1. Extract train ID from header
  const trainId = c.get('trainId') ?? c.req.header('train-id')

  // 2. Load credentials
  const credentials = await loadCredentials(trainId)

  // 3. Validate client auth
  if (!validateClientAuth(c, credentials)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  // 4. Generate request ID
  const requestId = nanoid()

  // 5. Forward to Claude
  const response = await forwardToClaude(c.req, credentials)

  // 6. Process response
  if (isStreaming(response)) {
    return handleStreaming(c, response, requestId)
  } else {
    return handleJson(c, response, requestId)
  }
}
```

#### Streaming Handler

```typescript
class StreamingHandler {
  private chunks: string[] = []
  private tokenCounts = { input: 0, output: 0 }

  async process(reader: ReadableStreamReader) {
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      this.chunks.push(chunk)

      // Parse SSE events
      const events = this.parseSSE(chunk)
      for (const event of events) {
        await this.processEvent(event)
      }

      // Forward chunk to client
      yield chunk
    }
  }

  private parseSSE(chunk: string): SSEEvent[] {
    // Parse Server-Sent Events format
    // Extract event type and data
  }

  private async processEvent(event: SSEEvent) {
    switch (event.type) {
      case 'message_start':
        this.tokenCounts.input = event.usage?.input_tokens || 0
        break
      case 'message_delta':
        this.tokenCounts.output += event.usage?.output_tokens || 0
        break
      case 'message_stop':
        await this.storeChunks()
        break
    }
  }
}
```

### 2. Conversation Tracking

#### Message Hashing Algorithm

```typescript
export function generateMessageHash(message: Message): string {
  // 1. Normalize content
  const normalizedContent = normalizeContent(message.content)

  // 2. Create hash input
  const hashInput = `${message.role}:${normalizedContent}`

  // 3. Generate SHA-256 hash
  return crypto.createHash('sha256').update(hashInput).digest('hex')
}

function normalizeContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content
  }

  // Filter system reminders and normalize
  return content
    .filter(block => {
      if (block.type === 'text') {
        return !block.text.startsWith('<system-reminder>')
      }
      return true
    })
    .map(block => {
      if (block.type === 'text') return block.text
      if (block.type === 'image') return `[image:${block.source.type}]`
      return '[unknown]'
    })
    .join('\n')
}
```

#### Conversation Linking

```typescript
async function linkConversation(messages: Message[], requestId: string): Promise<ConversationInfo> {
  // 1. Generate hashes
  const currentHash = generateMessageHash(messages[messages.length - 1])
  const parentHash = messages.length > 1 ? generateMessageHash(messages[messages.length - 2]) : null

  // 2. Find existing conversation
  if (parentHash) {
    const existing = await findConversationByHash(parentHash)
    if (existing) {
      // Check for branching
      const siblings = await countSiblingsWithParent(parentHash)
      if (siblings > 0) {
        // This creates a new branch
        return {
          conversationId: existing.conversationId,
          branchId: generateBranchId(),
          isBranchPoint: true,
        }
      }
      return existing
    }
  }

  // 3. Create new conversation
  return {
    conversationId: generateUUID(),
    branchId: 'main',
    isBranchPoint: false,
  }
}
```

### 3. Token Tracking

#### Token Extraction

```typescript
interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

function extractTokenUsage(response: any): TokenUsage {
  // From streaming response
  if (response.type === 'message_start') {
    return response.message.usage
  }

  // From JSON response
  if (response.usage) {
    return response.usage
  }

  // From query evaluation
  if (response.query_result?.usage) {
    return response.query_result.usage
  }

  throw new Error('No token usage found in response')
}
```

#### 5-Hour Window Tracking

```sql
-- Get usage for current 5-hour window
WITH window_usage AS (
  SELECT
    account_id,
    SUM(input_tokens + output_tokens) as tokens_used,
    MIN(created_at) as window_start
  FROM api_requests
  WHERE created_at > NOW() - INTERVAL '5 hours'
    AND account_id = $1
  GROUP BY account_id
)
SELECT
  tokens_used,
  EXTRACT(EPOCH FROM (NOW() - window_start)) as seconds_elapsed,
  300 * 60 - EXTRACT(EPOCH FROM (NOW() - window_start)) as seconds_remaining
FROM window_usage;
```

### 4. Storage Layer

#### Batch Processing

```typescript
class StorageAdapter {
  private batchQueue: RequestData[] = []
  private batchTimer: NodeJS.Timeout | null = null

  async queueRequest(data: RequestData) {
    this.batchQueue.push(data)

    if (this.batchQueue.length >= 100) {
      await this.flush()
    } else if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this.flush(), 1000)
    }
  }

  private async flush() {
    if (this.batchQueue.length === 0) return

    const batch = this.batchQueue.splice(0)
    this.batchTimer = null

    // Bulk insert
    await this.db.transaction(async trx => {
      await trx('api_requests').insert(batch)
    })
  }
}
```

#### Partitioning Strategy

```sql
-- Partition by month for efficient data management
CREATE TABLE api_requests (
  id UUID PRIMARY KEY,
  created_at TIMESTAMP NOT NULL,
  -- other columns
) PARTITION BY RANGE (created_at);

-- Auto-create monthly partitions
CREATE OR REPLACE FUNCTION create_monthly_partition()
RETURNS void AS $$
DECLARE
  start_date date;
  end_date date;
  partition_name text;
BEGIN
  start_date := date_trunc('month', CURRENT_DATE);
  end_date := start_date + interval '1 month';
  partition_name := 'api_requests_' || to_char(start_date, 'YYYY_MM');

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF api_requests
     FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
END;
$$ LANGUAGE plpgsql;
```

### 5. Authentication System

#### Multi-Layer Auth

```typescript
class AuthManager {
  constructor(
    private readonly clientKeyStore: ClientKeyStore,
    private readonly accountStore: AccountCredentialStore
  ) {}

  // Layer 1: Client authentication
  async validateClient(request: Request, trainId: string): Promise<boolean> {
    const allowedKeys = await this.clientKeyStore.getKeys(trainId)
    if (!allowedKeys.length) {
      return true // No client auth required
    }

    const providedKey = extractBearerToken(request)
    return allowedKeys.some(key => timingSafeEqual(hash(key), hash(providedKey)))
  }

  // Layer 2: Claude API authentication
  async enhanceRequest(request: Request, context: RequestContext): Promise<Request> {
    const account = await this.accountStore.pickAccount(context.account)

    switch (account.type) {
      case 'api_key':
        request.headers.set('x-api-key', account.api_key)
        break

      case 'oauth':
        const token = await this.getValidToken(account)
        request.headers.set('Authorization', `Bearer ${token}`)
        request.headers.set('anthropic-beta', 'oauth-2025-04-20')
        break
    }

    return request
  }

  // OAuth token management
  private async getValidToken(account: OAuthAccountCredential): Promise<string> {
    const expiresIn = account.oauth.expiresAt - Date.now()

    if (expiresIn < 60000) {
      // Less than 1 minute
      return await this.refreshToken(credentials)
    }

    return credentials.oauth.accessToken
  }
}
```

## Performance Optimizations

### 1. Connection Pooling

```typescript
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  statement_timeout: 30000,
})

// Reuse connections
pool.on('acquire', client => {
  console.log('Client acquired from pool')
})

pool.on('remove', client => {
  console.log('Client removed from pool')
})
```

### 2. Query Optimization

```sql
-- Use CTEs instead of correlated subqueries
WITH latest_messages AS (
  SELECT DISTINCT ON (conversation_id)
    conversation_id,
    id,
    created_at,
    input_tokens,
    output_tokens
  FROM api_requests
  ORDER BY conversation_id, created_at DESC
),
conversation_stats AS (
  SELECT
    conversation_id,
    COUNT(*) as message_count,
    SUM(input_tokens + output_tokens) as total_tokens
  FROM api_requests
  GROUP BY conversation_id
)
SELECT
  c.*,
  lm.id as latest_message_id,
  cs.message_count,
  cs.total_tokens
FROM conversations c
JOIN latest_messages lm ON c.id = lm.conversation_id
JOIN conversation_stats cs ON c.id = cs.conversation_id;
```

### 3. Caching Strategy

```typescript
class CacheManager {
  private memoryCache = new LRU<string, any>({
    max: 1000,
    ttl: 1000 * 60 * 5, // 5 minutes
  })

  async get(key: string): Promise<any> {
    // Try memory cache first
    const cached = this.memoryCache.get(key)
    if (cached) return cached

    // Fall back to database
    const result = await this.fetchFromDB(key)
    if (result) {
      this.memoryCache.set(key, result)
    }

    return result
  }
}
```

## Security Considerations

### 1. Credential Isolation

```typescript
// Each train has isolated credentials
const credentialPath = path.join(CREDENTIALS_DIR, `${trainId}.credentials.json`)

// Validate train ID format to prevent path traversal
if (!isValidTrainId(trainId)) {
  throw new Error('Invalid train ID')
}

// Read with restricted permissions
const stats = await fs.stat(credentialPath)
if (stats.mode & 0o077) {
  console.warn('Credential file has overly permissive permissions')
}
```

### 2. Request Sanitization

```typescript
function sanitizeRequest(request: any): any {
  // Remove sensitive headers
  const sanitized = { ...request }
  delete sanitized.headers['x-api-key']
  delete sanitized.headers['authorization']

  // Mask tokens in logs
  if (sanitized.headers['authorization']) {
    sanitized.headers['authorization'] = 'Bearer ****'
  }

  return sanitized
}
```

### 3. Rate Limiting

```typescript
// Per-train rate limiting (future implementation)
class RateLimiter {
  private limits = new Map<string, RateLimit>()

  async checkLimit(trainId: string): Promise<boolean> {
    const limit = this.limits.get(trainId) || this.createLimit(trainId)

    if (limit.tokens <= 0) {
      return false
    }

    limit.tokens--
    return true
  }

  private createLimit(trainId: string): RateLimit {
    const limit = {
      tokens: 100,
      resetAt: Date.now() + 60000,
    }

    this.limits.set(trainId, limit)

    // Reset tokens periodically
    setTimeout(() => {
      limit.tokens = 100
      limit.resetAt = Date.now() + 60000
    }, 60000)

    return limit
  }
}
```

## Future Architecture Considerations

### 1. Event-Driven Architecture

```typescript
// Future: Event sourcing for better audit trail
interface DomainEvent {
  id: string
  type: string
  aggregateId: string
  timestamp: Date
  data: any
}

class EventStore {
  async append(event: DomainEvent): Promise<void> {
    // Store event
    await this.db('events').insert(event)

    // Publish to subscribers
    await this.publisher.publish(event.type, event)
  }
}
```

### 2. Microservices Split

Potential service boundaries:

- **Auth Service**: Handle all authentication/authorization
- **Analytics Service**: Process usage statistics
- **Storage Service**: Manage data persistence
- **Streaming Service**: Handle SSE connections

### 3. Horizontal Scaling

```yaml
# Kubernetes deployment example
apiVersion: apps/v1
kind: Deployment
metadata:
  name: claude-proxy
spec:
  replicas: 3
  selector:
    matchLabels:
      app: claude-proxy
  template:
    spec:
      containers:
        - name: proxy
          image: moonsonglabs/agent-prompttrain-proxy:latest
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: db-secret
                  key: url
```

## Dashboard Service

### Message Parsing and Display

The dashboard service includes sophisticated message parsing to handle complex Claude API responses, particularly those with multiple tool invocations.

#### Conversation Message Parser

````typescript
// services/dashboard/src/utils/conversation.ts
async function parseMessage(msg: any, timestamp?: Date): Promise<ParsedMessage> {
  // Handles multiple content formats:
  // 1. Simple string content
  // 2. Array content with multiple blocks (text, tool_use, tool_result)

  if (Array.isArray(msg.content)) {
    // Filter out system-reminder content items and deduplicate tool_use/tool_result by ID
    const seenToolUseIds = new Set<string>()
    const seenToolResultIds = new Set<string>()

    const filteredContent = msg.content.filter((item: any) => {
      // Skip text items that start with <system-reminder>
      if (item.type === 'text' && typeof item.text === 'string') {
        if (item.text.trim().startsWith('<system-reminder>')) {
          return false
        }
      }

      // Deduplicate tool_use items by ID
      if (item.type === 'tool_use' && item.id) {
        if (seenToolUseIds.has(item.id)) {
          return false // Skip duplicate
        }
        seenToolUseIds.add(item.id)
      }

      // Deduplicate tool_result items by tool_use_id
      if (item.type === 'tool_result' && item.tool_use_id) {
        if (seenToolResultIds.has(item.tool_use_id)) {
          return false // Skip duplicate
        }
        seenToolResultIds.add(item.tool_use_id)
      }

      return true
    })

    // Process each filtered content block in order
    const contentParts: string[] = []

    filteredContent.forEach((block: any) => {
      switch (block.type) {
        case 'text':
          contentParts.push(block.text)
          break

        case 'tool_use': {
          // Format each tool invocation with name and ID
          let toolContent = `**Tool Use: ${block.name}** (ID: ${block.id})`
          if (block.input) {
            toolContent += '\n\n```json\n' + JSON.stringify(block.input, null, 2) + '\n```'
          }
          contentParts.push(toolContent)
          break
        }

        case 'tool_result': {
          // Format tool results with proper code blocks
          let resultContent = `**Tool Result** (ID: ${block.tool_use_id})`
          // Handle both string and array content formats
          contentParts.push(resultContent)
          break
        }
      }
    })

    // Join with visual separators for clarity
    content = contentParts.join('\n\n---\n\n')
  }
}
````

#### Key Features

1. **Multiple Tool Display**: Messages containing multiple `tool_use` or `tool_result` blocks are fully rendered
2. **Duplicate Filtering**: Duplicate tool_use and tool_result blocks with the same ID are automatically filtered out
3. **System Reminder Filtering**: Text blocks starting with `<system-reminder>` are hidden from display
4. **Visual Separation**: Horizontal rules (`---`) separate different content blocks for readability
5. **Order Preservation**: Content blocks are processed and displayed in their original order
6. **Backward Compatibility**: Single tool messages continue to work without changes
7. **Rich Formatting**: Tool inputs/outputs are displayed as formatted JSON code blocks

#### Message Metadata

The parser maintains metadata for backward compatibility:

- `isToolUse`: True if message contains any tool_use blocks
- `isToolResult`: True if message contains any tool_result blocks
- `toolName`: Name of the first tool (for compatibility)
- `toolId`: ID of the first tool or result

This ensures existing UI components that expect single tool metadata continue to function while the full content is properly displayed.

## References

- [Architecture Decision Records](./ADRs/)
- [Technical Debt](./technical-debt.md)
- [Performance Guide](../05-Troubleshooting/performance.md)
- [Database Schema](../03-Operations/database.md)
