# Agent Prompt Train Service

The proxy service handles all API proxying functionality for Claude API with authentication, telemetry, and storage capabilities.

## Overview

- **Port**: 3000 (default)
- **Purpose**: Proxy requests to Claude API with monitoring and multi-subscription support
- **Storage**: Write-only access to PostgreSQL for request/response logging

## Features

- Direct API proxying to Claude
- Multi-subscription support (API keys and OAuth)
- Domain-based credential mapping
- Token usage tracking
- Slack notifications
- Request/response storage
- Telemetry collection

## Development

```bash
# Install dependencies
cd services/proxy
bun install

# Run in development mode
bun run dev

# Build for production
bun run build

# Run tests
bun test
```

## Configuration

See `.env.example` in the root directory for all available environment variables.

### Key Environment Variables

- `CREDENTIALS_DIR` - Directory for domain credentials
- `DATABASE_URL` - PostgreSQL connection
- `STORAGE_ENABLED` - Enable storage (default: false)
- `SLACK_WEBHOOK_URL` - Slack notifications

## API Endpoints

- `POST /v1/messages` - Main Claude API proxy endpoint
- `GET /health` - Health check
- `GET /token-stats` - Token usage statistics
- `GET /client-setup/:filename` - Client configuration files

## Architecture

The service uses dependency injection via a container pattern:

- `MessageController` - Handles API requests
- `ProxyService` - Core proxy logic
- `AuthenticationService` - API key and OAuth handling
- `MetricsService` - Token tracking and telemetry
- `NotificationService` - Slack integration
- `StorageWriter` - Database write operations
