# ADR-017: MCP Prompt Sharing Implementation

## Status

Accepted

## Context

Agent PromptTrain needed a way to share and manage prompts across different Claude instances and teams. The Model Context Protocol (MCP) provides a standardized way to serve prompts that can be consumed by Claude Desktop and other MCP-compatible clients.

## Decision

We implemented an MCP server within the existing proxy service that:

1. **Serves prompts via JSON-RPC 2.0 protocol** following the MCP specification
2. **Uses a hybrid storage approach**: local YAML files with optional GitHub synchronization
3. **Integrates with Claude Desktop** via `mcp-remote` HTTP transport
4. **Provides dashboard UI** for prompt management and sync status

### Architecture

The implementation consists of three main components:

```
┌─────────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Claude Desktop    │────▶│   Proxy Service  │◀────│     GitHub      │
│  (MCP Client)       │     │   (MCP Server)   │     │  (Optional)     │
└─────────────────────┘     └──────────────────┘     └─────────────────┘
                                      │
                                      ▼
                            ┌──────────────────┐
                            │  Local YAML      │
                            │  Files           │
                            └──────────────────┘
```

### Key Design Decisions

1. **File-Based Storage**: Prompts are stored as YAML files in the `prompts/` directory
   - Simple format: `name`, `description`, `template`
   - Handlebars templating for variable substitution
   - Hot-reloading for development

2. **Optional GitHub Sync**: When configured, syncs prompts from a GitHub repository
   - Non-destructive sync (preserves local-only files)
   - Security measures against path traversal
   - Periodic sync with configurable interval

3. **Authentication**: Uses existing proxy authentication
   - Bearer token required for MCP endpoint access
   - Same client API key used for proxy requests

4. **Protocol Compliance**: Implements MCP protocol version `2024-11-05`
   - Required for Claude Desktop compatibility
   - Supports `initialize`, `prompts/list`, and `prompts/get` methods

### Configuration

```bash
# Basic setup (local files only)
MCP_ENABLED=true
MCP_PROMPTS_DIR=./prompts
MCP_WATCH_FILES=true

# With GitHub sync
MCP_GITHUB_OWNER=your-org
MCP_GITHUB_REPO=prompt-library
MCP_GITHUB_BRANCH=main
MCP_GITHUB_TOKEN=ghp_xxxx
MCP_GITHUB_PATH=prompts/
MCP_SYNC_INTERVAL=300
```

### Claude Desktop Integration

Users can add the MCP server to Claude Desktop with:

```bash
claude mcp add nexus-prompts --scope user -- bunx -y mcp-remote@latest \
  http://localhost:3000/mcp --header "Authorization: Bearer YOUR_CLIENT_API_KEY"
```

## Consequences

### Positive

- **Standardized prompt sharing** across teams using MCP protocol
- **Simple deployment** - no database changes required
- **Developer friendly** - hot-reloading and YAML format
- **Secure by default** - authentication required, path traversal protection
- **Flexible storage** - works with local files or GitHub repository

### Negative

- **No usage analytics** - simplified design omits tracking
- **Manual distribution** - prompts must be synced manually across instances
- **Limited features** - no argument validation or versioning

### Neutral

- **Protocol-first approach** ensures compatibility with future MCP clients
- **Hybrid architecture** allows gradual adoption (start local, add GitHub later)

## References

- [Model Context Protocol Specification](https://modelcontextprotocol.io)
- [PR #83: Initial MCP Implementation](https://github.com/Moonsong-Labs/agent-prompttrain/pull/83)
- [PR #87: MCP Server Fixes](https://github.com/Moonsong-Labs/agent-prompttrain/pull/87)
