# Claude CLI Integration

This document describes how to use Claude CLI with the Agent Prompt Train.

## Overview

The Agent Prompt Train includes a Docker service that runs Claude CLI connected to your local proxy. This allows you to:

- Use Claude CLI with your proxy configuration
- Track usage through the proxy's monitoring
- Apply any proxy-level features (rate limiting, logging, etc.)

## Setup

### Prerequisites

- Docker and Docker Compose
- Claude API key configured in your environment

### Running Claude CLI

1. Start the proxy and Claude CLI services:

```bash
docker compose --profile dev --profile claude up -d
```

2. Access Claude CLI interactively:

```bash
docker compose exec claude-cli claude
```

3. Or run a single command:

```bash
docker compose exec claude-cli claude "Write a hello world in Python"
```

## Configuration

The Claude CLI service is configured to:

- Connect to the proxy at `http://proxy:3000/v1`
- Use Bearer token authentication with your API key
- Mount the project directory as `/workspace` for file access

### Environment Variables

- API key is provided through train credential files in the `credentials/` directory

## How It Works

1. The Claude CLI Docker container starts with the official `@anthropic-ai/claude-cli` package
2. A setup script configures Claude to use the proxy endpoint
3. Authentication is handled via Bearer token using your API key
4. All requests go through the proxy, enabling monitoring and tracking

## File Access

The entire project directory is mounted at `/workspace` in the container, allowing Claude to:

- Read and analyze your code
- Generate files
- Access project documentation

## Examples

### Interactive Session

```bash
docker compose exec claude-cli claude
```

### Single Command

```bash
docker compose exec claude-cli claude "Explain the proxy architecture"
```

### With File Context

```bash
docker compose exec claude-cli claude "Review the code in /workspace/services/proxy/src/app.ts"
```

### Query with Automatic Log Display

```bash
# Use the helper script to run a query and see logs
./scripts/claude-with-logs.sh "What is the purpose of this project?"
```

## Helper Scripts

### view-claude-logs.sh

View and filter proxy logs:

```bash
# Show help
./scripts/view-claude-logs.sh --help

# Follow logs in real-time
./scripts/view-claude-logs.sh -f

# Show only errors
./scripts/view-claude-logs.sh -e

# Show API requests
./scripts/view-claude-logs.sh -r

# Show authentication logs
./scripts/view-claude-logs.sh -a
```

### claude-with-logs.sh

Run Claude queries and automatically display relevant logs:

```bash
./scripts/claude-with-logs.sh "Your query here"
```

## Troubleshooting

### Viewing Proxy Logs

To debug issues with Claude queries, you can view the proxy logs:

```bash
# View all proxy logs
docker compose logs proxy

# Follow logs in real-time
docker compose logs -f proxy

# View last 50 lines
docker compose logs --tail=50 proxy

# View logs with timestamps
docker compose logs -t proxy

# Filter logs for specific patterns
docker compose logs proxy | grep -i error
docker compose logs proxy | grep -i "claude request"
```

### Debug Mode

Enable debug mode to see detailed request/response information:

```bash
# Set DEBUG=true in your .env file or:
DEBUG=true docker compose --profile dev --profile claude up -d

# Then run your Claude query
docker compose exec claude-cli claude "test query"

# View the detailed logs
docker compose logs -f proxy | grep -A 10 -B 10 "test query"
```

### Common Log Patterns

1. **Successful Request:**

   ```
   [PROXY] Received request: POST /v1/messages
   [PROXY] Authentication successful
   [PROXY] Forwarding to Claude API
   [PROXY] Response received: 200 OK
   ```

2. **Authentication Error:**

   ```
   [PROXY] Authentication failed: Invalid API key
   [PROXY] Response: 401 Unauthorized
   ```

3. **API Error:**
   ```
   [PROXY] Claude API error: rate_limit_exceeded
   [PROXY] Response: 429 Too Many Requests
   ```

### Claude CLI not connecting

- Ensure the proxy service is running: `docker compose ps`
- Check Claude CLI logs: `docker compose logs claude-cli`
- Verify your API key is configured correctly in the credential files

### Authentication errors

- Ensure your API key is valid
- Check proxy logs for authentication issues: `docker compose logs proxy | grep -i auth`
- Verify the proxy is configured correctly: `docker compose exec proxy env | grep CLAUDE`

## Usage Monitoring Integration

The Claude CLI Docker image comes with integrated tools for monitoring token usage in real-time.

### Running the Usage Monitor

You can run the monitor or the `ccusage` analysis tool directly within the running `claude-cli` container.

```bash
# Start the services if they aren't running
docker compose --profile dev --profile claude up -d

# Run the real-time usage monitor
docker compose exec claude-cli monitor

# Get daily usage statistics
docker compose exec claude-cli ccusage daily

# See live usage blocks
docker compose exec claude-cli ccusage blocks --live
```

<details>
<summary><b>Implementation Details</b></summary>

- **Integrated Tools**: The Docker image includes the main `@anthropic-ai/claude-cli` CLI, `ccusage` for usage analysis, and the Python-based `Claude Usage Monitor`.
- **Security**: The container runs as a non-root user (`claude`) on a minimal Alpine base image.
- **Data Persistence**: The `/home/claude/.claude` directory is mounted as a volume to persist configuration, credentials, and usage data across container restarts.
- **Configuration**: The monitor is configured via environment variables (`ANTHROPIC_BASE_URL`, `CLAUDE_HOME`) set within the Docker Compose service definition.

</details>
