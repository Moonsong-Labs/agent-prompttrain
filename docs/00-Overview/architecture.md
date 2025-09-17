# Agent Prompt Train Architecture

## Overview

Agent Prompt Train has been refactored into a microservices architecture with two separate services:

1. **Proxy Service** - Handles API proxying, authentication, and data collection
2. **Dashboard Service** - Provides web UI for monitoring and analytics

## Directory Structure

```
agent-prompttrain/
├── packages/
│   └── shared/           # Shared types and configurations
├── services/
│   ├── proxy/           # Proxy API service
│   └── dashboard/       # Dashboard web service
├── scripts/             # Database initialization scripts
├── credentials/         # Domain credential files
├── client-setup/        # Client configuration files
└── docker-compose.yml   # Container orchestration
```

## Services

### Proxy Service (Port 3000)

**Responsibilities:**

- Proxy requests to Claude API
- Handle authentication (API keys, OAuth)
- Track token usage and metrics
- Send Slack notifications
- Write request/response data to database

**Endpoints:**

- `POST /v1/messages` - Main proxy endpoint
- `GET /token-stats` - Token usage statistics
- `GET /health` - Health check
- `GET /client-setup/*` - Client configuration files

### Dashboard Service (Port 3001)

**Responsibilities:**

- Web dashboard UI
- Real-time monitoring via SSE
- Historical data viewing
- Analytics and reporting
- Dashboard authentication

**Endpoints:**

- `GET /` - Dashboard UI
- `GET /api/requests` - Request history
- `GET /api/requests/:id` - Request details
- `GET /api/storage-stats` - Aggregated statistics
- `GET /sse` - Server-sent events for real-time updates
- `GET /health` - Health check

## Deployment

### Docker Compose (Recommended)

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop all services
docker-compose down
```

### Individual Services

```bash
# Build shared package
cd packages/shared && bun install && bun run build

# Start proxy service
cd services/proxy
bun install
bun run dev  # Development
bun run start  # Production

# Start dashboard service
cd services/dashboard
bun install
bun run dev  # Development
bun run start  # Production
```

## Configuration

### Environment Variables

**Proxy Service:**

```env
# Server
PORT=3000
HOST=0.0.0.0

# Claude API
CREDENTIALS_DIR=credentials

# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/claude_proxy
STORAGE_ENABLED=true

# Telemetry
TELEMETRY_ENDPOINT=https://your-telemetry-endpoint

# Slack (optional)
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
SLACK_CHANNEL=#notifications
```

**Dashboard Service:**

```env
# Server
PORT=3001
HOST=0.0.0.0

# Authentication
DASHBOARD_API_KEY=your-secret-key

# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/claude_proxy

# Optional
PROXY_API_URL=http://localhost:3000
```

## Database

Both services share a PostgreSQL database:

- **Proxy Service**: Write-only access
- **Dashboard Service**: Read-only access

The database is automatically initialized with required tables and indexes.

Key features:

- Account-based token tracking via `account_id` column
- Automatic conversation grouping with branch support
- Efficient indexes for time-series queries

See [DATABASE.md](./DATABASE.md) for complete schema documentation.

## Security

- Dashboard requires API key authentication
- Proxy resolves credentials via the `train-id` header and selects Anthropic accounts using `X-Train-Account`
- Database credentials are isolated per service
- Sensitive headers are removed before storage

## Monitoring

- Health checks available on both services
- Real-time metrics via dashboard SSE
- Historical data analysis through dashboard UI
- Optional pgAdmin included in docker-compose

## Development

```bash
# Install dependencies
bun install

# Run both services in development
bun run dev

# Build all services
bun run build

# Run tests
bun test
```

## Production Deployment

### Using Docker

```bash
# Build images
docker-compose build

# Deploy with environment file
docker-compose --env-file .env.production up -d
```

### Using PM2

```bash
# Build services
bun run build

# Start with PM2
pm2 start services/proxy/dist/main.js --name claude-proxy
pm2 start services/dashboard/dist/main.js --name claude-dashboard
```

## Scaling Considerations

- Services can be scaled independently
- Database connections are pooled
- Proxy service handles batch operations for efficiency
- Dashboard uses caching for read operations
- Both services are stateless and can run multiple instances
