# MCP Server Implementation Plan

## Overview

This document provides a detailed implementation plan for integrating a Model Context Protocol (MCP) server into the Agent Prompt Train. The MCP server will serve prompts from a GitHub repository and provide a dashboard UI for prompt management.

## Architecture Summary

The MCP server will be implemented as an integrated module within the existing proxy service, featuring:

- **JSON-RPC 2.0 Protocol Handler** at `/mcp/rpc`
- **GitHub Sync Service** for repository synchronization
- **PostgreSQL Storage** for prompt caching
- **Dashboard UI** for prompt management
- **REST API** for dashboard functionality

## Implementation Phases

### Phase 1: Core MCP Server Implementation

#### 1.1 Create MCP Module Structure

```
services/proxy/src/mcp/
├── McpServer.ts           # Main MCP server implementation
├── JsonRpcHandler.ts      # JSON-RPC 2.0 protocol handler
├── types/
│   ├── protocol.ts        # MCP protocol types
│   └── prompts.ts         # Prompt-specific types
└── handlers/
    ├── initialize.ts      # Initialize method handler
    ├── listPrompts.ts     # List prompts handler
    └── getPrompt.ts       # Get prompt handler
```

#### 1.2 Implement JSON-RPC Handler

```typescript
// services/proxy/src/mcp/JsonRpcHandler.ts
import { Hono } from 'hono'
import { McpServer } from './McpServer.js'

export class JsonRpcHandler {
  constructor(private mcpServer: McpServer) {}

  async handle(c: Context): Promise<Response> {
    const request = await c.req.json()

    // Validate JSON-RPC request
    if (!this.isValidJsonRpcRequest(request)) {
      return this.errorResponse(-32600, 'Invalid Request')
    }

    try {
      const result = await this.mcpServer.handleRequest(request)
      return c.json(result)
    } catch (error) {
      return this.errorResponse(-32603, 'Internal error')
    }
  }
}
```

#### 1.3 Add MCP Routes to Proxy

Update `services/proxy/src/app.ts` to include MCP routes:

```typescript
// MCP server endpoints
if (config.mcp.enabled) {
  const mcpHandler = container.getMcpHandler()
  app.post('/mcp/rpc', c => mcpHandler.handle(c))

  // MCP discovery endpoint
  app.get('/mcp', c => {
    return c.json({
      name: 'agent-prompttrain-mcp-server',
      version: '1.0.0',
      capabilities: {
        prompts: {
          listPrompts: true,
          getPrompt: true,
        },
      },
    })
  })
}
```

### Phase 2: GitHub Integration

#### 2.1 Create GitHub Sync Service

```typescript
// services/proxy/src/mcp/GitHubSyncService.ts
export class GitHubSyncService {
  private octokit: Octokit
  private config: GitHubConfig

  async syncRepository(): Promise<void> {
    // 1. Fetch repository contents
    // 2. Parse prompt files
    // 3. Update database
    // 4. Invalidate cache
  }

  async parsePromptFile(content: string, path: string): Prompt {
    // Support YAML, JSON, and Markdown with frontmatter
  }
}
```

#### 2.2 Implement Prompt File Parsers

Support multiple file formats:

**YAML Format:**

```yaml
id: code-review
name: Code Review Assistant
description: Helps review code for best practices
arguments:
  - name: language
    type: string
    required: true
content: |
  You are a code review assistant...
```

**JSON Format:**

```json
{
  "id": "code-review",
  "name": "Code Review Assistant",
  "arguments": [...],
  "content": "..."
}
```

**Markdown with Frontmatter:**

```markdown
---
id: code-review
name: Code Review Assistant
arguments:
  - name: language
    type: string
---

You are a code review assistant...
```

#### 2.3 Add Sync Scheduling

```typescript
// services/proxy/src/mcp/SyncScheduler.ts
export class SyncScheduler {
  private intervalId?: NodeJS.Timer

  start(): void {
    const interval = config.mcp.syncInterval * 1000
    this.intervalId = setInterval(() => {
      this.syncService.syncRepository().catch(logger.error)
    }, interval)
  }
}
```

### Phase 3: Database Integration

#### 3.1 Create Prompt Repository

```typescript
// packages/shared/src/repositories/McpPromptRepository.ts
export class McpPromptRepository {
  constructor(private pool: Pool) {}

  async upsertPrompt(prompt: Prompt): Promise<void>
  async getPrompt(promptId: string): Promise<Prompt | null>
  async listPrompts(filter?: PromptFilter): Promise<Prompt[]>
  async recordUsage(usage: PromptUsage): Promise<void>
}
```

#### 3.2 Implement Caching Layer

```typescript
// services/proxy/src/mcp/PromptCache.ts
export class PromptCache {
  private lru: LRUCache<string, Prompt>

  constructor(maxSize: number = 1000) {
    this.lru = new LRUCache({ max: maxSize })
  }

  async get(promptId: string): Promise<Prompt | null> {
    // Check cache first, then database
  }
}
```

### Phase 4: Dashboard UI Components

#### 4.1 Create Prompt List Page

```tsx
// services/dashboard/src/pages/prompts/index.tsx
export function PromptsPage() {
  return (
    <div>
      <h1>MCP Prompts</h1>
      <PromptList />
      <SyncStatus />
    </div>
  )
}
```

#### 4.2 Implement Prompt Detail View

```tsx
// services/dashboard/src/components/PromptDetail.tsx
export function PromptDetail({ promptId }: Props) {
  // Show prompt content, arguments, usage stats
  return (
    <div>
      <h2>{prompt.name}</h2>
      <PromptContent content={prompt.content} />
      <PromptArguments arguments={prompt.arguments} />
      <UsageChart promptId={promptId} />
    </div>
  )
}
```

#### 4.3 Add Sync Control Panel

```tsx
// services/dashboard/src/components/SyncControl.tsx
export function SyncControl() {
  // Manual sync button
  // Sync status indicator
  // Last sync time
  // Error messages
}
```

### Phase 5: REST API Endpoints

#### 5.1 Add Dashboard API Routes

```typescript
// services/proxy/src/routes/mcp-api.ts
export const mcpApiRoutes = new Hono()

// List prompts with filtering and pagination
mcpApiRoutes.get('/mcp/prompts', async c => {
  const { page, limit, search, active } = c.req.query()
  // Return paginated prompt list
})

// Get prompt details
mcpApiRoutes.get('/mcp/prompts/:id', async c => {
  const promptId = c.req.param('id')
  // Return prompt with usage stats
})

// Trigger manual sync
mcpApiRoutes.post('/mcp/sync', async c => {
  // Trigger GitHub sync
})

// Get sync status
mcpApiRoutes.get('/mcp/sync/status', async c => {
  // Return current sync status
})
```

## Configuration

### Environment Variables

```bash
# MCP Configuration
MCP_ENABLED=true
MCP_GITHUB_OWNER=your-org
MCP_GITHUB_REPO=prompt-library
MCP_GITHUB_BRANCH=main
MCP_GITHUB_TOKEN=ghp_xxxxxxxxxxxx
MCP_GITHUB_PATH=prompts/
MCP_SYNC_INTERVAL=300  # 5 minutes
MCP_CACHE_TTL=300      # 5 minutes
MCP_CACHE_SIZE=1000    # Max prompts in memory
```

### TypeScript Types

```typescript
// packages/shared/src/types/mcp.ts
export interface McpConfig {
  enabled: boolean
  github: {
    owner: string
    repo: string
    branch: string
    token: string
    path: string
  }
  sync: {
    interval: number
    webhookSecret?: string
  }
  cache: {
    ttl: number
    maxSize: number
  }
}
```

## Security Implementation

### 1. Authentication

- MCP endpoint inherits proxy authentication
- Dashboard API uses `X-Dashboard-Key`
- GitHub token stored securely in environment

### 2. Input Validation

```typescript
// Validate prompt IDs to prevent injection
function validatePromptId(id: string): boolean {
  return /^[a-zA-Z0-9-_\/]+$/.test(id)
}

// Sanitize prompt content
function sanitizePromptContent(content: string): string {
  // Remove potential script injections
  // Validate template variables
}
```

### 3. Rate Limiting

```typescript
// Add MCP-specific rate limits
app.use(
  '/mcp/*',
  createRateLimiter({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
  })
)
```

## Testing Strategy

### 1. Unit Tests

```typescript
// services/proxy/tests/mcp/McpServer.test.ts
describe('McpServer', () => {
  it('handles initialize request', async () => {})
  it('lists prompts with filtering', async () => {})
  it('retrieves specific prompt', async () => {})
  it('handles invalid requests', async () => {})
})
```

### 2. Integration Tests

```typescript
// services/proxy/tests/mcp/GitHubSync.test.ts
describe('GitHubSyncService', () => {
  it('syncs repository successfully', async () => {})
  it('parses different file formats', async () => {})
  it('handles sync failures gracefully', async () => {})
})
```

### 3. E2E Tests

```typescript
// test/e2e/mcp-flow.test.ts
describe('MCP Flow', () => {
  it('completes full prompt retrieval flow', async () => {})
  it('updates prompts after GitHub changes', async () => {})
})
```

## Monitoring and Observability

### 1. Metrics

- Prompt usage by domain/account
- Sync success/failure rates
- Cache hit/miss ratios
- Response times

### 2. Logging

```typescript
logger.info('MCP sync completed', {
  repository: config.github.repo,
  promptsUpdated: count,
  duration: elapsed,
})
```

### 3. Alerts

- Sync failures
- GitHub API rate limit warnings
- High error rates

## Rollout Plan

### Week 1: Core Implementation

- Implement MCP server and JSON-RPC handler
- Create database schema
- Basic prompt storage and retrieval

### Week 2: GitHub Integration

- GitHub sync service
- File parsers
- Scheduled synchronization

### Week 3: Dashboard UI

- Prompt list page
- Detail views
- Usage analytics

### Week 4: Production Readiness

- Performance optimization
- Security hardening
- Documentation
- Testing

## Success Criteria

1. **Functional Requirements**
   - MCP server responds to standard protocol requests
   - Prompts sync from GitHub repository
   - Dashboard displays prompt information
   - Usage tracking works correctly

2. **Performance Requirements**
   - Prompt retrieval < 100ms (cached)
   - GitHub sync completes < 30 seconds
   - Dashboard loads < 2 seconds

3. **Reliability Requirements**
   - 99.9% uptime for MCP endpoints
   - Graceful handling of GitHub API failures
   - No impact on proxy performance

## Future Enhancements

1. **Version Control**
   - Track prompt version history
   - Rollback capabilities
   - Diff visualization

2. **Advanced Features**
   - Prompt templates with variables
   - A/B testing support
   - Prompt chaining

3. **Extended MCP Support**
   - Add tool serving capabilities
   - Resource management
   - Multi-repository support
