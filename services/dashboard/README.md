# Agent PromptTrain Dashboard Service

The dashboard service provides a web UI for monitoring and analyzing Claude API usage.

## Overview

- **Port**: 3001 (default)
- **Purpose**: Web dashboard for monitoring API usage and analytics
- **Storage**: Read-only access to PostgreSQL for data visualization

## Features

- Real-time monitoring with SSE
- Request history browser
- Token usage analytics
- Model distribution charts
- Domain-based filtering
- Export capabilities
- Responsive web UI
- MCP (Model Context Protocol) prompts browser
- Prompt template viewer with Handlebars syntax support

## Development

```bash
# Install dependencies
cd services/dashboard
bun install

# Run in development mode
bun run dev

# Build for production
bun run build

# Run tests
bun test
```

## Configuration

### Required Environment Variables

- `DASHBOARD_API_KEY` - Authentication key for dashboard access
- `DATABASE_URL` - PostgreSQL connection string

### Optional Environment Variables

- `PORT` - Server port (default: 3001)
- `HOST` - Server hostname (default: 0.0.0.0)
- `PROXY_API_URL` - URL of proxy service for real-time updates

## API Endpoints

- `GET /` - Dashboard web UI (requires authentication)
- `GET /health` - Health check
- `GET /api/requests` - Query stored requests
- `GET /api/requests/:id` - Get request details
- `GET /api/storage-stats` - Aggregated statistics
- `GET /sse` - Server-sent events for real-time updates
- `GET /dashboard/prompts` - MCP prompts listing
- `GET /dashboard/prompts/:id` - Prompt details view

## Authentication

The dashboard requires authentication via `DASHBOARD_API_KEY`. Users must login with this key to access the dashboard.

## Architecture

The service provides read-only access to the database:

- `StorageReader` - Efficient queries with caching
- Dashboard routes with HTMX for dynamic updates
- SSE for real-time monitoring
- Chart.js for data visualization
