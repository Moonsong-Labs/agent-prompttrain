# Configuration Guide

This guide covers all configuration options for Agent PromptTrain.

## Environment Variables

### Core Configuration

| Variable            | Required | Default | Description                             |
| ------------------- | -------- | ------- | --------------------------------------- |
| `DATABASE_URL`      | Yes      | -       | PostgreSQL connection string            |
| `DASHBOARD_API_KEY` | Yes      | -       | Authentication key for dashboard access |

### Proxy Service

| Variable               | Required | Default       | Description                                 |
| ---------------------- | -------- | ------------- | ------------------------------------------- |
| `PORT`                 | No       | 3000          | Proxy service port                          |
| `STORAGE_ENABLED`      | No       | false         | Enable request/response storage             |
| `DEBUG`                | No       | false         | Enable debug logging (masks sensitive data) |
| `ENABLE_CLIENT_AUTH`   | No       | true          | Require client API key authentication       |
| `CREDENTIALS_DIR`      | No       | ./credentials | Directory for domain credential files       |
| `SLACK_WEBHOOK_URL`    | No       | -             | Slack webhook for notifications             |
| `COLLECT_TEST_SAMPLES` | No       | false         | Collect request samples for testing         |
| `TEST_SAMPLES_DIR`     | No       | test-samples  | Directory for test samples                  |

### Dashboard Service

| Variable                  | Required | Default | Description                         |
| ------------------------- | -------- | ------- | ----------------------------------- |
| `DASHBOARD_PORT`          | No       | 3001    | Dashboard service port              |
| `DASHBOARD_CACHE_TTL`     | No       | 30      | Cache TTL in seconds (0 to disable) |
| `SLOW_QUERY_THRESHOLD_MS` | No       | 5000    | Threshold for logging slow queries  |

## Domain Credentials

Domain-specific credentials are stored in JSON files in the credentials directory.

### API Key Authentication

```json
{
  "type": "api_key",
  "accountId": "acc_unique_identifier",
  "api_key": "sk-ant-...",
  "client_api_key": "cnp_live_..."
}
```

### OAuth Authentication

```json
{
  "type": "oauth",
  "accountId": "acc_unique_identifier",
  "oauth": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": 1735689599000,
    "scopes": ["org:create_api_key", "user:profile", "user:inference"],
    "isMax": true
  }
}
```

### File Naming Convention

- Pattern: `<domain>.credentials.json`
- Example: `example.com.credentials.json`
- The domain must match the Host header in requests

## Database Configuration

### Connection Options

The `DATABASE_URL` supports standard PostgreSQL connection strings:

```bash
# Standard format
postgresql://username:password@host:port/database

# With SSL
postgresql://username:password@host:port/database?sslmode=require

# With connection pooling
postgresql://username:password@host:port/database?pool_max=20
```

### Schema Migration

Run migrations to set up the database schema:

```bash
# Run token usage migration (required for account-based tracking)
bun run db:migrate:token-usage

# Other available migrations
bun run db:migrate:init
bun run db:migrate:conversations
bun run db:migrate:optimize
```

## Security Configuration

### Client Authentication

When `ENABLE_CLIENT_AUTH=true` (default):

- Clients must provide a Bearer token matching the domain's `client_api_key`
- Generate secure keys: `bun run auth:generate-key`

To disable client authentication (not recommended for production):

```bash
ENABLE_CLIENT_AUTH=false
```

### OAuth Token Management

OAuth tokens are automatically refreshed 1 minute before expiry. Manual management:

```bash
# Check OAuth status
bun run auth:oauth-status

# Refresh all tokens
bun run auth:oauth-refresh

# Refresh specific domain
bun run scripts/auth/oauth-refresh.ts example.com
```

## Performance Tuning

### Database Performance

```bash
# Optimize conversation queries
SLOW_QUERY_THRESHOLD_MS=1000  # Log queries slower than 1s

# Dashboard caching
DASHBOARD_CACHE_TTL=60  # Cache for 60 seconds
DASHBOARD_CACHE_TTL=0   # Disable caching
```

### Storage Performance

```bash
# Batch processing for storage
STORAGE_BATCH_SIZE=100      # Process 100 records at a time
STORAGE_BATCH_INTERVAL=5000 # Process every 5 seconds
```

## Debug Configuration

### Debug Logging

When `DEBUG=true`:

- Logs full request/response bodies (with masking)
- Shows streaming chunks
- Displays authentication flow
- Masks sensitive patterns: `sk-ant-****`, `Bearer ****`

### Test Sample Collection

For development and testing:

```bash
COLLECT_TEST_SAMPLES=true
TEST_SAMPLES_DIR=./test-samples
```

Samples are organized by request type:

- `inference_streaming_opus.json`
- `quota_evaluation_non_streaming.json`
- etc.

## Docker Configuration

### Environment File

Create `.env` file for Docker deployment:

```env
# Database
DATABASE_URL=postgresql://postgres:password@db:5432/claude_nexus

# Authentication
DASHBOARD_API_KEY=your-secure-key

# Features
STORAGE_ENABLED=true
DEBUG=false

# Networking
PROXY_PORT=3000
DASHBOARD_PORT=3001
```

### Docker Compose Override

For custom configuration, create `docker-compose.override.yml`:

```yaml
version: '3.8'
services:
  proxy:
    environment:
      - DEBUG=true
      - STORAGE_ENABLED=true
  dashboard:
    environment:
      - DASHBOARD_CACHE_TTL=0
```

## Monitoring Configuration

### Slack Notifications

Configure Slack webhook for error notifications:

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

Notifications are sent for:

- Proxy startup/shutdown
- Critical errors
- OAuth token refresh failures

### Metrics Collection

Token usage metrics are automatically collected and available at:

- `/token-stats` - Raw statistics endpoint
- Dashboard analytics view

## Example Configurations

### Development Setup

```bash
# .env.development
DATABASE_URL=postgresql://localhost:5432/claude_nexus_dev
DASHBOARD_API_KEY=dev-key
DEBUG=true
STORAGE_ENABLED=true
ENABLE_CLIENT_AUTH=false
COLLECT_TEST_SAMPLES=true
```

### Production Setup

```bash
# .env.production
DATABASE_URL=postgresql://prod-db:5432/claude_nexus
DASHBOARD_API_KEY=secure-random-key
STORAGE_ENABLED=true
ENABLE_CLIENT_AUTH=true
SLACK_WEBHOOK_URL=https://hooks.slack.com/...
DASHBOARD_CACHE_TTL=300
SLOW_QUERY_THRESHOLD_MS=2000
```

### High-Performance Setup

```bash
# .env.performance
DATABASE_URL=postgresql://db:5432/claude_nexus?pool_max=50
STORAGE_ENABLED=false  # Disable storage for lower latency
DASHBOARD_CACHE_TTL=600  # 10-minute cache
DEBUG=false
```
