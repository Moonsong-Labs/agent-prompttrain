# ADR-016: MCP Server Implementation

## Status

Superseded

> **Implementation Note**: The actual implementation diverged significantly from this proposal. Instead of using a database-backed system with GitHub synchronization, the MCP server was implemented as a simpler file-based system. See the "Actual Implementation" section below for details.

## Context

Agent Prompt Train needs to implement a Model Context Protocol (MCP) server that serves prompts from a GitHub repository. The MCP server should:

- Be integrated into the existing proxy service (not a separate service)
- Only serve prompts (no tools or resources)
- Fetch prompts from a frequently updated GitHub repository
- Provide a dashboard UI for prompt management
- Use the existing PostgreSQL database and TypeScript/Bun runtime

## Decision

### Architecture Overview

The MCP server will be implemented as a new module within the proxy service, exposing JSON-RPC 2.0 endpoints according to the MCP specification. It will consist of:

1. **MCP Protocol Handler** - JSON-RPC 2.0 endpoint at `/mcp/rpc`
2. **GitHub Sync Service** - Background service for repository synchronization
3. **Prompt Storage** - PostgreSQL tables for caching prompts
4. **Dashboard Integration** - UI components for prompt management
5. **REST API** - Additional endpoints for dashboard functionality

### Component Design

#### 1. MCP Protocol Implementation

```typescript
// services/proxy/src/mcp/McpServer.ts
interface McpServer {
  // Core MCP methods
  handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse>

  // MCP protocol methods
  initialize(params: InitializeParams): Promise<InitializeResult>
  listPrompts(params: ListPromptsParams): Promise<ListPromptsResult>
  getPrompt(params: GetPromptParams): Promise<GetPromptResult>
}
```

**Endpoints:**

- `POST /mcp/rpc` - Main JSON-RPC 2.0 endpoint
- Supports methods: `initialize`, `prompts/list`, `prompts/get`

#### 2. Database Schema

```sql
-- MCP prompts table
CREATE TABLE mcp_prompts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prompt_id VARCHAR(255) UNIQUE NOT NULL,  -- GitHub file path as ID
    name VARCHAR(255) NOT NULL,
    description TEXT,
    content TEXT NOT NULL,
    arguments JSONB,  -- Prompt arguments/parameters
    metadata JSONB,   -- Additional metadata from GitHub
    github_path VARCHAR(500) NOT NULL,
    github_sha VARCHAR(40),  -- Git commit SHA
    github_url TEXT,
    version INTEGER DEFAULT 1,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- MCP sync status
CREATE TABLE mcp_sync_status (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository VARCHAR(255) NOT NULL,
    branch VARCHAR(100) DEFAULT 'main',
    last_sync_at TIMESTAMPTZ,
    last_commit_sha VARCHAR(40),
    last_error TEXT,
    sync_status VARCHAR(50) DEFAULT 'pending', -- pending, syncing, success, error
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- MCP prompt usage tracking
CREATE TABLE mcp_prompt_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prompt_id VARCHAR(255) NOT NULL,
    domain VARCHAR(255),
    account_id VARCHAR(255),
    request_id UUID REFERENCES api_requests(request_id),
    used_at TIMESTAMPTZ DEFAULT NOW(),
    arguments JSONB,
    FOREIGN KEY (prompt_id) REFERENCES mcp_prompts(prompt_id)
);

-- Indexes
CREATE INDEX idx_mcp_prompts_prompt_id ON mcp_prompts(prompt_id);
CREATE INDEX idx_mcp_prompts_active ON mcp_prompts(is_active);
CREATE INDEX idx_mcp_prompt_usage_prompt_id ON mcp_prompt_usage(prompt_id);
CREATE INDEX idx_mcp_prompt_usage_used_at ON mcp_prompt_usage(used_at);
```

#### 3. GitHub Integration

```typescript
// services/proxy/src/mcp/GitHubSyncService.ts
interface GitHubSyncService {
  syncRepository(): Promise<void>
  fetchPrompts(): Promise<Prompt[]>
  parsePromptFile(content: string, path: string): Prompt
  setupWebhook(): Promise<void>
}
```

**Sync Strategy:**

- Poll GitHub API every 5 minutes (configurable)
- Support webhook notifications for instant updates
- Parse YAML/JSON/Markdown files with frontmatter
- Store prompts with versioning

**File Format Support:**

```yaml
# prompts/code-review.yaml
id: code-review
name: Code Review Assistant
description: Helps review code for best practices
arguments:
  - name: language
    type: string
    required: true
    description: Programming language
  - name: context
    type: string
    required: false
    description: Additional context
content: |
  You are a code review assistant for {language} code.
  {context}

  Please review the following code...
```

#### 4. REST API for Dashboard

```typescript
// Additional REST endpoints for dashboard
GET /api/mcp/prompts            // List all prompts with filtering
GET /api/mcp/prompts/:id        // Get specific prompt details
GET /api/mcp/prompts/:id/usage  // Get prompt usage statistics
POST /api/mcp/sync              // Trigger manual sync
GET /api/mcp/sync/status        // Get sync status
```

#### 5. Caching Strategy

**Multi-Level Caching:**

1. **Database Cache** - Primary storage, persistent
2. **In-Memory Cache** - LRU cache for frequently used prompts
3. **TTL Strategy** - 5-minute cache for prompt listings

**Cache Invalidation:**

- GitHub webhook triggers immediate invalidation
- Manual sync endpoint clears cache
- Stale-while-revalidate for better performance

### Security Considerations

1. **Authentication:**
   - MCP endpoint uses existing proxy authentication
   - Dashboard API uses `X-Dashboard-Key` header
   - GitHub API uses personal access token (stored in env)

2. **Authorization:**
   - Domain-based access control for prompts
   - Audit trail for prompt usage
   - Rate limiting on MCP endpoints

3. **Data Validation:**
   - Validate prompt content for injection attacks
   - Sanitize GitHub file paths
   - Validate JSON-RPC requests

### Implementation Plan

1. **Phase 1: Core MCP Server**
   - Implement JSON-RPC handler
   - Create database schema
   - Basic prompt listing/retrieval

2. **Phase 2: GitHub Integration**
   - GitHub API client
   - File parsing (YAML/JSON/Markdown)
   - Sync service with polling

3. **Phase 3: Dashboard UI**
   - Prompt listing page
   - Prompt detail view
   - Usage analytics
   - Sync status indicator

4. **Phase 4: Advanced Features**
   - GitHub webhooks
   - Prompt versioning
   - Usage tracking
   - Performance optimization

### Configuration

```typescript
// Environment variables
MCP_ENABLED=true
MCP_GITHUB_OWNER=organization
MCP_GITHUB_REPO=prompt-library
MCP_GITHUB_BRANCH=main
MCP_GITHUB_TOKEN=ghp_xxxx
MCP_GITHUB_PATH=prompts/  // Path within repo
MCP_SYNC_INTERVAL=300     // 5 minutes
MCP_CACHE_TTL=300         // 5 minutes
```

## Consequences

### Positive

- Seamless integration with existing proxy infrastructure
- Reuses authentication and database systems
- Provides standard MCP interface for AI tools
- Centralized prompt management with version control
- Real-time updates from GitHub

### Negative

- Adds complexity to proxy service
- Requires GitHub API rate limit management
- Additional database tables and queries
- Potential performance impact on proxy

### Neutral

- Follows MCP specification for future compatibility
- Can be extended to support tools/resources later
- Dashboard becomes more feature-rich

## References

- [Model Context Protocol Specification](https://modelcontextprotocol.io/specification)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
- [GitHub REST API Documentation](https://docs.github.com/en/rest)

## Actual Implementation

The MCP server was implemented with a hybrid architecture that combines file-based storage with optional GitHub synchronization:

### Key Differences from Original Proposal

1. **File-Based Storage**: Instead of PostgreSQL tables, prompts are stored as YAML files in a local `prompts/` directory
2. **GitHub Sync to Filesystem**: GitHub sync writes to local files instead of database, preserving local-only prompts
3. **Handlebars Templating**: Uses industry-standard Handlebars `{{variable}}` templating with full feature support
4. **Simplified Features**: No prompt usage tracking or argument validation for simplicity
5. **MCP Protocol Compliance**: Follows MCP specification with protocol version `2024-11-05`

### Implemented Architecture

#### 1. Core Components

**PromptRegistryService** (`services/proxy/src/mcp/PromptRegistryService.ts`):

- Loads YAML files from the `prompts/` directory
- Maintains in-memory cache of compiled Handlebars templates
- Supports hot-reloading via file system watcher
- Exposes methods for listing and rendering prompts

**GitHubSyncService** (`services/proxy/src/mcp/GitHubSyncService.ts`):

- Optional service that syncs from GitHub repository to local filesystem
- Preserves local-only prompts (only replaces files that exist in GitHub)
- Includes security measures against path traversal attacks
- Updates sync status with success/error states

**McpServer** (`services/proxy/src/mcp/McpServer.ts`):

- Implements JSON-RPC 2.0 protocol handler
- Supports `initialize`, `prompts/list`, and `prompts/get` methods
- Returns protocol version `2024-11-05` for Claude Desktop compatibility

#### 2. File Format

```yaml
# prompts/code-review.yaml
name: Code Review Assistant
description: Helps review code for best practices
template: |
  You are an expert code reviewer for {{language}} code.
  {{#if focus}}
  Focus area: {{focus}}
  {{else}}
  General code review
  {{/if}}
```

#### 3. Configuration

**Basic Configuration** (file-based only):

```bash
MCP_ENABLED=true
MCP_PROMPTS_DIR=./prompts     # Local directory for YAML files
MCP_WATCH_FILES=true           # Enable hot-reloading
```

**With GitHub Sync**:

```bash
MCP_ENABLED=true
MCP_PROMPTS_DIR=./prompts
MCP_WATCH_FILES=true
MCP_GITHUB_OWNER=your-org
MCP_GITHUB_REPO=prompt-library
MCP_GITHUB_BRANCH=main
MCP_GITHUB_TOKEN=ghp_xxxx
MCP_GITHUB_PATH=prompts/
MCP_SYNC_INTERVAL=300         # Sync every 5 minutes
```

#### 4. Security Measures

- **Path Traversal Protection**: Uses `path.basename()` to sanitize filenames from GitHub
- **File Type Validation**: Only accepts `.yaml` and `.yml` files
- **Bearer Token Authentication**: MCP endpoint protected by client API key
- **Non-Destructive Sync**: Only replaces files that exist in GitHub repository

#### 5. Claude Desktop Integration

To use the MCP server with Claude Desktop:

```bash
claude mcp add nexus-prompts --scope user -- bunx -y mcp-remote@latest \
  http://localhost:3000/mcp --header "Authorization: Bearer YOUR_CLIENT_API_KEY"
```

This command:

- Registers the MCP server with Claude Desktop
- Uses `mcp-remote` to connect over HTTP
- Includes authentication header for security
- Makes prompts available as slash commands in Claude

#### 6. Dashboard Integration

The dashboard provides a UI for:

- Viewing all synced prompts
- Displaying sync status and errors
- Triggering manual sync operations
- CSRF-protected sync endpoint

#### 7. Benefits of Actual Implementation

- **Simplicity**: Much simpler than database-backed approach
- **Flexibility**: Supports both local files and GitHub sync
- **Developer Experience**: Hot-reloading for rapid development
- **Security**: Built-in protections against common vulnerabilities
- **Compatibility**: Works with Claude Desktop out of the box

#### 8. Trade-offs

- **No Usage Analytics**: Simplified design omits tracking
- **Manual Distribution**: Prompts must be manually synced across deployments
- **Limited Versioning**: Relies on Git for version control
- **No Argument Validation**: Templates accept any variables

### Implementation Status

✅ **Completed**:

- File-based prompt storage with YAML format
- Handlebars template engine integration
- GitHub sync service with security measures
- MCP protocol handler (JSON-RPC 2.0)
- Claude Desktop compatibility
- Dashboard UI for prompt management
- Hot-reloading for development
- CSRF protection for dashboard routes

❌ **Not Implemented** (from original proposal):

- Database storage (uses filesystem instead)
- Prompt usage tracking
- Argument validation
- Webhook support for instant updates
- Prompt versioning within the system
