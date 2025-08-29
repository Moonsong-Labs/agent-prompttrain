# Monitoring Guide

Comprehensive monitoring ensures your Agent Prompt Train operates reliably and efficiently.

## Overview

The proxy provides multiple monitoring capabilities:

- Real-time metrics and statistics
- Token usage tracking
- Performance monitoring
- Error tracking and alerts
- Database health checks

## Built-in Monitoring

### Health Endpoints

Basic health checks:

```bash
# Proxy health
curl http://localhost:3000/health
# Returns: {"status":"ok"}

# Dashboard health
curl http://localhost:3001/health
# Returns: {"status":"ok","database":"connected"}
```

### Token Statistics API

Real-time token usage:

```bash
curl http://localhost:3000/token-stats
```

Response:

```json
{
  "total_requests": 1234,
  "total_tokens": {
    "input": 50000,
    "output": 45000,
    "total": 95000
  },
  "by_domain": {
    "example.com": {
      "requests": 500,
      "tokens": {...}
    }
  }
}
```

### Dashboard Metrics

Access via dashboard API:

```bash
# Current statistics
curl http://localhost:3001/api/stats \
  -H "X-Dashboard-Key: $DASHBOARD_API_KEY"

# Token usage by account
curl "http://localhost:3001/api/token-usage/current?window=300" \
  -H "X-Dashboard-Key: $DASHBOARD_API_KEY"
```

## Performance Monitoring

### Request Latency

Track response times:

```sql
-- Average latency by hour
SELECT
  date_trunc('hour', created_at) as hour,
  AVG(response_time_ms) as avg_latency,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms) as p95_latency
FROM api_requests
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY hour
ORDER BY hour DESC;
```

### Slow Query Detection

Configure threshold:

```bash
SLOW_QUERY_THRESHOLD_MS=5000
```

Monitor slow queries:

```bash
# View recent slow queries
docker compose logs proxy | grep "Slow SQL query"
```

### Database Performance

Key metrics to monitor:

```sql
-- Connection count
SELECT count(*) FROM pg_stat_activity;

-- Long-running queries
SELECT pid, now() - pg_stat_activity.query_start AS duration, query
FROM pg_stat_activity
WHERE (now() - pg_stat_activity.query_start) > interval '5 minutes';

-- Table sizes
SELECT
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

## Token Usage Monitoring

### 5-Hour Window Tracking

Monitor Claude API limits:

```bash
# Check current window usage
curl "http://localhost:3001/api/token-usage/current?accountId=acc_12345&window=300" \
  -H "X-Dashboard-Key: $DASHBOARD_API_KEY"
```

### Daily Usage Reports

Historical analysis:

```bash
# Last 30 days aggregated
curl "http://localhost:3001/api/token-usage/daily?accountId=acc_12345&aggregate=true" \
  -H "X-Dashboard-Key: $DASHBOARD_API_KEY"
```

### Usage Alerts

Set up alerts for high usage:

```javascript
// Example alert check
async function checkTokenUsage() {
  const usage = await getTokenUsage(accountId)
  const percentage = (usage.tokens_used / usage.limit) * 100

  if (percentage > 80) {
    sendAlert(`Token usage at ${percentage}% for account ${accountId}`)
  }
}
```

## Error Monitoring

### Error Rates

Track error frequency:

```sql
-- Error rate by hour
SELECT
  date_trunc('hour', created_at) as hour,
  COUNT(*) FILTER (WHERE status_code >= 400) as errors,
  COUNT(*) as total,
  ROUND(COUNT(*) FILTER (WHERE status_code >= 400)::numeric / COUNT(*) * 100, 2) as error_rate
FROM api_requests
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY hour
ORDER BY hour DESC;
```

### Error Categories

Analyze error types:

```sql
-- Error breakdown
SELECT
  status_code,
  error_type,
  COUNT(*) as count,
  ARRAY_AGG(DISTINCT domain) as affected_domains
FROM api_requests
WHERE status_code >= 400
  AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY status_code, error_type
ORDER BY count DESC;
```

### Error Alerts

Configure Slack notifications:

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

## External Monitoring

### Prometheus Integration

Export metrics for Prometheus:

```javascript
// Example metrics endpoint
app.get('/metrics', (req, res) => {
  const metrics = `
# HELP claude_proxy_requests_total Total number of requests
# TYPE claude_proxy_requests_total counter
claude_proxy_requests_total{domain="${domain}"} ${requestCount}

# HELP claude_proxy_tokens_total Total tokens used
# TYPE claude_proxy_tokens_total counter
claude_proxy_tokens_total{type="input"} ${inputTokens}
claude_proxy_tokens_total{type="output"} ${outputTokens}

# HELP claude_proxy_response_time Response time in milliseconds
# TYPE claude_proxy_response_time histogram
claude_proxy_response_time_bucket{le="100"} ${bucket100}
claude_proxy_response_time_bucket{le="500"} ${bucket500}
claude_proxy_response_time_bucket{le="1000"} ${bucket1000}
`
  res.type('text/plain').send(metrics)
})
```

### Grafana Dashboards

Create dashboards for:

- Request rate and latency
- Token usage trends
- Error rates and types
- Database performance
- Cost projections

Example dashboard config:

```json
{
  "dashboard": {
    "title": "Agent Prompt Train",
    "panels": [
      {
        "title": "Request Rate",
        "targets": [
          {
            "expr": "rate(claude_proxy_requests_total[5m])"
          }
        ]
      },
      {
        "title": "Token Usage",
        "targets": [
          {
            "expr": "sum(claude_proxy_tokens_total) by (type)"
          }
        ]
      }
    ]
  }
}
```

### Uptime Monitoring

External monitoring services:

```yaml
# UptimeRobot configuration
monitors:
  - name: 'Claude Proxy API'
    url: 'https://proxy.example.com/health'
    interval: 300

  - name: 'Claude Dashboard'
    url: 'https://dashboard.example.com/health'
    interval: 300
```

## Log Aggregation

### Structured Logging

Enable JSON logging:

```javascript
// Structured log format
logger.info({
  event: 'api_request',
  domain: req.hostname,
  method: req.method,
  path: req.path,
  status: res.statusCode,
  duration: responseTime,
  tokens: {
    input: inputTokens,
    output: outputTokens,
  },
})
```

### Log Shipping

Send logs to centralized system:

```yaml
# Filebeat configuration
filebeat.inputs:
  - type: container
    paths:
      - '/var/lib/docker/containers/*/*.log'
    processors:
      - add_docker_metadata: ~
      - decode_json_fields:
          fields: ['message']
          target: ''

output.elasticsearch:
  hosts: ['elasticsearch:9200']
```

### Log Analysis

Useful log queries:

```bash
# High token usage requests
docker compose logs proxy | jq 'select(.tokens.total > 10000)'

# Slow requests
docker compose logs proxy | jq 'select(.duration > 5000)'

# Error patterns
docker compose logs proxy | grep ERROR | awk '{print $5}' | sort | uniq -c
```

## Alerting

### Alert Configuration

Set up alerts for:

1. **High Error Rate**

   ```
   IF error_rate > 5% FOR 5 minutes
   THEN alert "High error rate detected"
   ```

2. **Token Limit Approaching**

   ```
   IF token_usage_percentage > 80%
   THEN alert "Token limit approaching for account X"
   ```

3. **Database Issues**

   ```
   IF database_connections > 90% of max
   THEN alert "Database connection pool exhausted"
   ```

4. **Response Time Degradation**
   ```
   IF p95_latency > 10s FOR 10 minutes
   THEN alert "Performance degradation detected"
   ```

### Alert Channels

Configure multiple channels:

```javascript
// Alert manager configuration
const alertChannels = {
  slack: {
    webhook: process.env.SLACK_WEBHOOK_URL,
    channel: '#alerts',
  },
  email: {
    smtp: process.env.SMTP_SERVER,
    recipients: ['ops@example.com'],
  },
  pagerduty: {
    serviceKey: process.env.PAGERDUTY_KEY,
  },
}
```

## Dashboard Monitoring

### Real-time Updates

Monitor SSE connections:

```javascript
// Track active dashboard connections
let activeConnections = 0

app.get('/api/sse', (req, res) => {
  activeConnections++
  console.log(`Active dashboard connections: ${activeConnections}`)

  req.on('close', () => {
    activeConnections--
  })
})
```

### Dashboard Performance

Monitor dashboard queries:

```sql
-- Dashboard query performance
SELECT
  query,
  calls,
  mean_exec_time,
  total_exec_time
FROM pg_stat_statements
WHERE query LIKE '%api_requests%'
ORDER BY mean_exec_time DESC
LIMIT 10;
```

## Cost Monitoring

### Token Cost Calculation

Track costs by model:

```javascript
const tokenCosts = {
  'claude-3-opus-20240229': { input: 15, output: 75 }, // per million tokens
  'claude-3-sonnet-20240229': { input: 3, output: 15 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
}

function calculateCost(model, inputTokens, outputTokens) {
  const costs = tokenCosts[model]
  return {
    input: (inputTokens / 1_000_000) * costs.input,
    output: (outputTokens / 1_000_000) * costs.output,
    total: (inputTokens / 1_000_000) * costs.input + (outputTokens / 1_000_000) * costs.output,
  }
}
```

### Budget Alerts

Set up cost alerts:

```sql
-- Daily cost tracking
WITH daily_costs AS (
  SELECT
    date_trunc('day', created_at) as day,
    SUM(input_tokens * 0.000015 + output_tokens * 0.000075) as cost
  FROM api_requests
  WHERE model = 'claude-3-opus-20240229'
  GROUP BY day
)
SELECT
  day,
  cost,
  SUM(cost) OVER (ORDER BY day) as cumulative_cost
FROM daily_costs
ORDER BY day DESC;
```

## Best Practices

1. **Set Appropriate Thresholds**
   - Start with conservative limits
   - Adjust based on baseline metrics
   - Document threshold reasoning

2. **Regular Review**
   - Weekly performance reviews
   - Monthly cost analysis
   - Quarterly capacity planning

3. **Automate Responses**
   - Auto-scaling for high load
   - Automatic backup triggers
   - Self-healing mechanisms

4. **Monitor Monitoring**
   - Alert on monitoring failures
   - Test alert channels regularly
   - Backup monitoring systems

## Next Steps

- [Set up backups](./backup-recovery.md)
- [Configure security](./security.md)
- [Optimize performance](../05-Troubleshooting/performance.md)
- [Review architecture](../04-Architecture/internals.md)
