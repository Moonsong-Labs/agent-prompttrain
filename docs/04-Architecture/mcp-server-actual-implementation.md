# MCP Server Actual Implementation

## Overview

This document describes the actual implementation of the Model Context Protocol (MCP) server in Agent Prompt Train, which differs significantly from the [original plan](./mcp-server-original-plan.md).

**Note**: As of PR #83, the implementation supports a hybrid approach: prompts can be loaded from local YAML files (default) OR synced from a GitHub repository. When GitHub sync is enabled, it fetches prompts from the repository and writes them to the local filesystem.

## Key Design Decisions

### File-Based Instead of Database-Based

The implementation uses a simple file-based approach:

- Prompts are stored as YAML files in the `prompts/` directory
- No database tables or migrations required
- Hot-reloading supported via file system watcher

### Handlebars Templating

Instead of custom templating:

- Uses industry-standard Handlebars templating engine
- Supports full Handlebars features (conditionals, loops, helpers)
- Variables use `{{variable}}` syntax instead of `{variable}`

### Optional GitHub Synchronization

Flexible deployment model:

- Prompts can be managed directly in the file system (default)
- Optional GitHub sync feature for centralized prompt management
- GitHub sync writes files to the local filesystem (not database)
- When enabled, syncs prompts from a GitHub repository at regular intervals

## Implementation Components

### 1. PromptRegistryService

Located at `services/proxy/src/mcp/PromptRegistryService.ts`

Key features:

- Loads YAML files from configurable directory
- Compiles templates with Handlebars
- Maintains in-memory cache
- Watches for file changes and reloads automatically

### 2. File Format

Prompts use a simple YAML format:

```yaml
# prompts/example.yaml
name: Example Prompt
description: Description of what this prompt does
template: |
  You are an AI assistant helping with {{task}}.
  {{#if context}}
  Additional context: {{context}}
  {{/if}}
```

### 3. GitHubSyncService (Optional)

When GitHub credentials are configured:

- Fetches prompts from a GitHub repository at regular intervals
- Writes YAML files to the local `prompts/` directory
- **Sync behavior**: Only replaces files that exist in the GitHub repository
- **Preserves local-only files**: YAML files not in the GitHub repo are kept
- **Security**: Validates filenames to prevent path traversal attacks
- Automatically triggers prompt registry reload after sync
- Tracks sync status in a `sync-info.json` file
- Skips sync if no prompts are found to prevent accidental data loss

### 4. MCP Protocol Handler

The `McpServer` class implements the MCP protocol:

- `initialize` - Returns server capabilities
- `prompts/list` - Lists all available prompts
- `prompts/get` - Returns a specific prompt with rendered template

### 5. Dashboard Integration

The dashboard provides:

- List of all prompts at `/dashboard/prompts`
- Individual prompt details at `/dashboard/prompts/:id`
- Display of Handlebars template syntax

## Configuration

Environment variables:

```bash
# Core MCP Configuration
MCP_ENABLED=true              # Enable MCP server
MCP_PROMPTS_DIR=./prompts     # Directory containing YAML files
MCP_WATCH_FILES=true          # Enable hot-reloading

# Optional GitHub Sync Configuration
MCP_GITHUB_OWNER=your-org     # GitHub organization/user
MCP_GITHUB_REPO=prompt-library # Repository name
MCP_GITHUB_BRANCH=main        # Branch to sync from
MCP_GITHUB_TOKEN=ghp_xxxx     # GitHub personal access token
MCP_GITHUB_PATH=prompts/      # Path within the repository
MCP_SYNC_INTERVAL=300         # Sync interval in seconds (default: 5 minutes)
```

## Benefits of This Approach

1. **Flexibility**: Can work with local files or sync from GitHub
2. **Simplicity**: No database complexity or migrations
3. **Developer Experience**: Direct file editing with hot-reload
4. **Standard Tooling**: Handlebars is well-known and documented
5. **Deployment**: Prompts can deploy with the application or from central repository
6. **Performance**: In-memory caching with minimal overhead

## Trade-offs

- No built-in usage analytics
- No UI for editing prompts (must edit files directly or use GitHub)
- GitHub sync requires API token and is subject to rate limits
- Sync conflicts must be resolved manually (GitHub sync overwrites local files)

## Future Enhancements

If needed, the system could be extended to support:

- Git-based synchronization (simpler than GitHub API)
- Optional database storage for analytics
- Web-based prompt editor
- Prompt versioning and rollback
