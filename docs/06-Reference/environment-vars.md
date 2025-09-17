# Environment Variables Reference

Complete reference for all environment variables used in Agent Prompt Train.

## Essential Configuration

### Database

| Variable       | Description                  | Default | Required |
| -------------- | ---------------------------- | ------- | -------- |
| `DATABASE_URL` | PostgreSQL connection string | -       | ✅       |

Example:

```bash
DATABASE_URL=postgresql://user:password@localhost:5432/claude_nexus
```

### Authentication

| Variable             | Description                          | Default | Required |
| -------------------- | ------------------------------------ | ------- | -------- |
| `DASHBOARD_API_KEY`  | API key for dashboard authentication | -       | ✅       |
| `ENABLE_CLIENT_AUTH` | Enable client API key authentication | `true`  | ❌       |


### Train Identification

| Variable | Description | Default | Required |
| -------- | ----------- | ------- | -------- |
| `ANTHROPIC_CUSTOM_HEADERS` | Custom headers forwarded to the Anthropic API. Set to `\"X-Train-Id:<your_train>\"` so the proxy tags outgoing requests with the correct train identifier. | - | ❌ |

## Feature Flags

| Variable               | Description                         | Default |
| ---------------------- | ----------------------------------- | ------- |
| `STORAGE_ENABLED`      | Enable request/response storage     | `false` |
| `DEBUG`                | Enable debug logging                | `false` |
| `COLLECT_TEST_SAMPLES` | Collect request samples for testing | `false` |

## Performance Configuration

### Timeouts

| Variable                  | Description                          | Default           |
| ------------------------- | ------------------------------------ | ----------------- |
| `CLAUDE_API_TIMEOUT`      | Timeout for Claude API requests (ms) | `600000` (10 min) |
| `PROXY_SERVER_TIMEOUT`    | Server-level timeout (ms)            | `660000` (11 min) |
| `SLOW_QUERY_THRESHOLD_MS` | Log queries slower than this (ms)    | `5000`            |

### Caching

| Variable              | Description                   | Default |
| --------------------- | ----------------------------- | ------- |
| `DASHBOARD_CACHE_TTL` | Dashboard cache TTL (seconds) | `30`    |

## Service Configuration

### Proxy Service

| Variable     | Description            | Default       |
| ------------ | ---------------------- | ------------- |
| `PROXY_PORT` | Port for proxy service | `3000`        |
| `NODE_ENV`   | Node environment       | `development` |
| `LOG_LEVEL`  | Logging level          | `info`        |

### Dashboard Service

| Variable                | Description                | Default |
| ----------------------- | -------------------------- | ------- |
| `DASHBOARD_PORT`        | Port for dashboard service | `3001`  |
| `DASHBOARD_TIMEZONE`    | Display timezone           | `UTC`   |
| `DASHBOARD_DATE_FORMAT` | Date format                | `ISO`   |

## Integration Configuration

### Slack Integration

| Variable            | Description                     | Default |
| ------------------- | ------------------------------- | ------- |
| `SLACK_WEBHOOK_URL` | Slack webhook for notifications | -       |

Example:

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

### OAuth Configuration

| Variable                 | Description                | Default                                |
| ------------------------ | -------------------------- | -------------------------------------- |
| `CLAUDE_OAUTH_CLIENT_ID` | OAuth client ID for Claude | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` |

## Directory Configuration

| Variable           | Description                    | Default          |
| ------------------ | ------------------------------ | ---------------- |
| `CREDENTIALS_DIR`  | Directory for train credential files | `./credentials`  |
| `TEST_SAMPLES_DIR` | Directory for test samples     | `./test-samples` |

## AI Analysis Configuration

### Background Worker

| Variable                                | Description                             | Default |
| --------------------------------------- | --------------------------------------- | ------- |
| `AI_WORKER_ENABLED`                     | Enable AI Analysis background worker    | `false` |
| `AI_WORKER_POLL_INTERVAL_MS`            | Polling interval for new jobs (ms)      | `5000`  |
| `AI_WORKER_MAX_CONCURRENT_JOBS`         | Max concurrent jobs per worker instance | `3`     |
| `AI_WORKER_JOB_TIMEOUT_MINUTES`         | Timeout for stuck jobs (minutes)        | `5`     |
| `AI_ANALYSIS_MAX_RETRIES`               | Maximum retry attempts for failed jobs  | `3`     |
| `AI_ANALYSIS_GEMINI_REQUEST_TIMEOUT_MS` | Timeout for Gemini API requests (ms)    | `60000` |

### Analysis Configuration

| Variable                                     | Description                                         | Default               |
| -------------------------------------------- | --------------------------------------------------- | --------------------- |
| `AI_ANALYSIS_PROMPT_VERSION`                 | Version of analysis prompt to use                   | `v1`                  |
| `AI_MAX_CONTEXT_TOKENS`                      | Maximum context window size for AI model            | `1000000`             |
| `AI_MAX_PROMPT_TOKENS`                       | Maximum tokens for analysis prompt (overrides calc) | `855000` (calculated) |
| `AI_MAX_PROMPT_TOKENS_BASE`                  | Base tokens before safety margin                    | `900000`              |
| `AI_TOKENIZER_SAFETY_MARGIN`                 | Safety margin for tokenizer discrepancies           | `0.95`                |
| `AI_HEAD_MESSAGES`                           | Messages to keep from conversation start            | `5`                   |
| `AI_TAIL_MESSAGES`                           | Messages to keep from conversation end              | `20`                  |
| `AI_TRUNCATION_STRATEGY`                     | JSON object for truncation config                   | See below             |
| `AI_ESTIMATED_CHARS_PER_TOKEN`               | Estimated characters per token ratio                | `12`                  |
| `AI_ANALYSIS_INPUT_TRUNCATION_TARGET_TOKENS` | Target token count for input message truncation     | `8192`                |
| `AI_ANALYSIS_TRUNCATE_FIRST_N_TOKENS`        | Tokens to keep from conversation start              | `1000`                |
| `AI_ANALYSIS_TRUNCATE_LAST_M_TOKENS`         | Tokens to keep from conversation end                | `4000`                |

### Gemini API Configuration

| Variable            | Description                      | Default                                                   |
| ------------------- | -------------------------------- | --------------------------------------------------------- |
| `GEMINI_API_KEY`    | API key for Gemini AI            | -                                                         |
| `GEMINI_API_URL`    | Base URL for Gemini API          | `https://generativelanguage.googleapis.com/v1beta/models` |
| `GEMINI_MODEL_NAME` | Gemini model to use for analysis | `gemini-2.0-flash-exp`                                    |

### AI Analysis Security

| Variable                                         | Description                                      | Default |
| ------------------------------------------------ | ------------------------------------------------ | ------- |
| `AI_ANALYSIS_MAX_RETRIES`                        | Maximum retry attempts for failed analyses       | `2`     |
| `AI_ANALYSIS_REQUEST_TIMEOUT_MS`                 | Timeout for Gemini API requests (ms)             | `60000` |
| `AI_ANALYSIS_RATE_LIMIT_CREATION`                | Rate limit for analysis creation (per minute)    | `15`    |
| `AI_ANALYSIS_RATE_LIMIT_RETRIEVAL`               | Rate limit for analysis retrieval (per minute)   | `100`   |
| `AI_ANALYSIS_ENABLE_PII_REDACTION`               | Enable PII redaction in conversation content     | `true`  |
| `AI_ANALYSIS_ENABLE_PROMPT_INJECTION_PROTECTION` | Enable prompt injection protection               | `true`  |
| `AI_ANALYSIS_ENABLE_OUTPUT_VALIDATION`           | Enable output validation for analysis results    | `true`  |
| `AI_ANALYSIS_ENABLE_AUDIT_LOGGING`               | Enable audit logging for all analysis operations | `true`  |

Example truncation strategy JSON:

```bash
AI_TRUNCATION_STRATEGY='{"HEAD_MESSAGES": 10, "TAIL_MESSAGES": 30}'
```

## Development Configuration

### Debug Options

| Variable       | Description                    | Default |
| -------------- | ------------------------------ | ------- |
| `AUTH_DEBUG`   | Extra authentication debugging | `false` |
| `SQL_DEBUG`    | Log all SQL queries            | `false` |
| `STREAM_DEBUG` | Debug streaming responses      | `false` |

### Test Configuration

| Variable       | Description         | Default |
| -------------- | ------------------- | ------- |
| `TEST_MODE`    | Enable test mode    | `false` |
| `TEST_API_KEY` | API key for testing | -       |

## Docker Configuration

When running in Docker, additional variables may be needed:

| Variable            | Description       | Default        |
| ------------------- | ----------------- | -------------- |
| `DATABASE_HOST`     | Database hostname | `postgres`     |
| `DATABASE_PORT`     | Database port     | `5432`         |
| `DATABASE_NAME`     | Database name     | `claude_nexus` |
| `DATABASE_USER`     | Database username | `postgres`     |
| `DATABASE_PASSWORD` | Database password | -              |

## Production Configuration

### Security

| Variable         | Description             | Default |
| ---------------- | ----------------------- | ------- |
| `FORCE_HTTPS`    | Force HTTPS connections | `false` |
| `CORS_ORIGIN`    | Allowed CORS origins    | `*`     |
| `SECURE_COOKIES` | Use secure cookies      | `false` |

### Monitoring

| Variable                      | Description             | Default |
| ----------------------------- | ----------------------- | ------- |
| `METRICS_ENABLED`             | Enable metrics endpoint | `false` |
| `METRICS_PORT`                | Port for metrics        | `9090`  |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry endpoint  | -       |

## Example .env File

```bash
# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/claude_nexus

# Authentication
DASHBOARD_API_KEY=your-secure-dashboard-key
ENABLE_CLIENT_AUTH=true

# Features
STORAGE_ENABLED=true
DEBUG=false

# Performance
CLAUDE_API_TIMEOUT=600000
PROXY_SERVER_TIMEOUT=660000
SLOW_QUERY_THRESHOLD_MS=5000
DASHBOARD_CACHE_TTL=30

# Services
PROXY_PORT=3000
DASHBOARD_PORT=3001

# Integrations
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL

# AI Analysis Worker
AI_WORKER_ENABLED=false
AI_WORKER_POLL_INTERVAL_MS=5000
AI_WORKER_MAX_CONCURRENT_JOBS=3
AI_WORKER_JOB_TIMEOUT_MINUTES=5
AI_WORKER_MAX_RETRIES=3
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL_NAME=gemini-2.0-flash-exp

# Directories
CREDENTIALS_DIR=./credentials
TEST_SAMPLES_DIR=./test-samples

# Wildcard Credentials (optional)
# CNP_WILDCARD_CREDENTIALS=true
# CNP_RESOLUTION_CACHE_TTL=300000
# CNP_DEBUG_RESOLUTION=false

# Production (uncomment for production)
# NODE_ENV=production
# LOG_LEVEL=warn
# FORCE_HTTPS=true
# SECURE_COOKIES=true
```

## Environment-Specific Configurations

### Development

```bash
NODE_ENV=development
DEBUG=true
LOG_LEVEL=debug
STORAGE_ENABLED=true
```

### Staging

```bash
NODE_ENV=staging
DEBUG=false
LOG_LEVEL=info
STORAGE_ENABLED=true
METRICS_ENABLED=true
```

### Production

```bash
NODE_ENV=production
DEBUG=false
LOG_LEVEL=warn
STORAGE_ENABLED=true
METRICS_ENABLED=true
FORCE_HTTPS=true
SECURE_COOKIES=true
```

## Loading Environment Variables

### From .env File

The project automatically loads `.env` files using dotenv:

```typescript
import { config } from 'dotenv'
config()
```

### From Docker

Pass environment variables to Docker:

```bash
docker run -e DATABASE_URL=postgresql://... moonsonglabs/agent-prompttrain-proxy
```

Or use env file:

```bash
docker run --env-file .env moonsonglabs/agent-prompttrain-proxy
```

### From Docker Compose

```yaml
services:
  proxy:
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - STORAGE_ENABLED=true
    env_file:
      - .env
```

## Validation

The proxy validates required environment variables on startup:

```typescript
const requiredVars = ['DATABASE_URL', 'DASHBOARD_API_KEY']

for (const varName of requiredVars) {
  if (!process.env[varName]) {
    throw new Error(`Missing required environment variable: ${varName}`)
  }
}
```

## Best Practices

1. **Never commit .env files** - Add to .gitignore
2. **Use strong values** - Generate secure keys and passwords
3. **Document changes** - Update this reference when adding variables
4. **Validate early** - Check required variables on startup
5. **Use defaults wisely** - Provide sensible defaults for optional vars
6. **Separate by environment** - Use .env.development, .env.production
7. **Secure production** - Use secret management tools in production

## Troubleshooting

### Variable Not Loading

1. Check file location: `.env` should be in project root
2. Verify format: `KEY=value` without spaces around `=`
3. Check for typos in variable names
4. Ensure no quotes unless value contains spaces

### Docker Variables

1. Use `docker compose config` to verify resolution
2. Check precedence: CLI > docker-compose.yml > .env
3. Use `printenv` inside container to debug

### Production Issues

1. Verify secrets are properly injected
2. Check for environment-specific overrides
3. Ensure no hardcoded values in code
4. Review logs for validation errors

## Next Steps

- [Configuration Guide](../01-Getting-Started/configuration.md)
- [Deployment Guide](../03-Operations/deployment/docker.md)
- [Security Best Practices](../03-Operations/security.md)
