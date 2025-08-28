# Development Guide

This guide covers setting up and developing Agent Prompt Train.

## Prerequisites

- [Bun](https://bun.sh) v1.0 or later
- PostgreSQL 12+
- Git

## Initial Setup

### 1. Clone and Install

```bash
git clone https://github.com/yourusername/agent-prompttrain.git
cd agent-prompttrain
bun install
```

### 2. Database Setup

```bash
# Create database
createdb claude_nexus_dev

# Set connection string
export DATABASE_URL=postgresql://localhost/claude_nexus_dev

# Run migrations
bun run db:migrate
```

### 3. Environment Configuration

Create `.env` file:

```bash
# Required
DATABASE_URL=postgresql://localhost/claude_nexus_dev
DASHBOARD_API_KEY=dev-dashboard-key

# Optional
DEBUG=true
STORAGE_ENABLED=true
ENABLE_CLIENT_AUTH=false  # Easier for development
```

### 4. Start Development Servers

```bash
# Start both services
bun run dev

# Or start individually
bun run dev:proxy      # Port 3000
bun run dev:dashboard  # Port 3001
```

## Project Structure

```
agent-prompttrain/
├── packages/
│   └── shared/          # Shared types and utilities
├── services/
│   ├── proxy/          # Proxy API service
│   └── dashboard/      # Dashboard web service
├── scripts/            # Utility scripts
│   ├── db/            # Database scripts
│   ├── auth/          # Authentication scripts
│   ├── dev/           # Development helpers
│   └── test/          # Test scripts
└── docker/            # Docker configurations
```

## Development Workflow

### Code Quality and CI

To maintain code consistency and quality, we use several tools that are enforced by our CI pipeline.

#### Code Formatting (Prettier)

We use Prettier for automatic code formatting. Run it locally before committing your changes.

```bash
# Format all files
bun run format

# Check for formatting issues without changing files
bun run format:check
```

Our CI includes an auto-format workflow that will attempt to fix formatting issues in pull requests originating from within the repository (not from forks).

#### Type Safety (TypeScript)

Always run the type checker before committing. The build will fail if there are any type errors.

```bash
bun run typecheck
```

#### CI Workflows

Our GitHub Actions workflows automatically validate code quality on every pull request:

- **Format Check**: Verifies Prettier formatting.
- **Type Check**: Runs `bun run typecheck`.
- **Auto-Format**: Automatically formats code and commits changes back to the PR (for internal PRs only).

### Making Changes

1. **Shared Types** - Edit in `packages/shared/src/`
2. **Proxy Logic** - Edit in `services/proxy/src/`
3. **Dashboard UI** - Edit in `services/dashboard/src/`

After changing shared types:

```bash
bun run build:shared
```

### Testing

Run tests:

```bash
bun test
```

Test specific functionality:

```bash
# Test any model
./scripts/test/test-any-model.sh

# Test dashboard API
./scripts/test/test-dashboard-api.sh
```

## Common Development Tasks

### Adding a New API Endpoint

1. **Define Types** in `packages/shared/src/types/`:

```typescript
export interface MyNewEndpoint {
  request: { ... }
  response: { ... }
}
```

2. **Implement in Proxy** `services/proxy/src/routes/`:

```typescript
app.post('/my-endpoint', async c => {
  // Implementation
})
```

3. **Add to Dashboard** if needed

### Working with Database

```bash
# Analyze conversation structure
bun run db:analyze-conversations

# Rebuild conversation data
bun run db:rebuild-conversations

# Create backup before changes
bun run db:backup
```

### Managing Credentials

```bash
# Generate API key for testing
bun run auth:generate-key

# Check OAuth status
bun run auth:oauth-status
```

## Debugging

### Enable Debug Logging

```bash
DEBUG=true bun run dev:proxy
```

This shows:

- Full request/response bodies (masked)
- Streaming chunks
- Authentication flow
- Database queries

### Common Issues

1. **Port Already in Use**

```bash
lsof -i :3000  # Find process using port
kill -9 <PID>  # Kill process
```

2. **Database Connection Failed**

- Check PostgreSQL is running
- Verify DATABASE_URL
- Check database exists

3. **Type Errors**

```bash
bun run build:shared  # Rebuild shared types
bun run typecheck     # See all errors
```

## Testing with Claude API

### Using Test Credentials

Create test domain credentials:

```bash
cat > credentials/test.local.credentials.json << EOF
{
  "type": "api_key",
  "api_key": "sk-ant-..."
}
EOF
```

### Making Test Requests

```bash
# Non-streaming
curl -X POST http://localhost:3000/v1/messages \
  -H "Host: test.local" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-sonnet-20240229",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 100
  }'

# Streaming
curl -X POST http://localhost:3000/v1/messages \
  -H "Host: test.local" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-sonnet-20240229",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## Performance Optimization

### Database Queries

Monitor slow queries:

```bash
SLOW_QUERY_THRESHOLD_MS=100 bun run dev:dashboard
```

### Caching

Disable dashboard cache during development:

```bash
DASHBOARD_CACHE_TTL=0 bun run dev:dashboard
```

## Contributing

### Before Submitting PR

1. **Type Check**: `bun run typecheck`
2. **Format Code**: `bun run format`
3. **Test Changes**: `bun test`
4. **Update Docs**: If adding features

### Commit Messages

Follow conventional commits:

- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation
- `refactor:` Code refactoring
- `test:` Test additions/changes
- `chore:` Maintenance tasks

## Resources

- [Bun Documentation](https://bun.sh/docs)
- [Hono Framework](https://hono.dev)
- [Claude API Reference](https://docs.anthropic.com/claude/reference)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
