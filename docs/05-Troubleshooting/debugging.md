# Debugging Guide

This guide provides techniques and tools for debugging issues in Agent Prompt Train.

## Debug Mode

### Enable Debug Logging

```bash
# Environment variable
DEBUG=true

# Or in .env file
DEBUG=true
```

Debug mode enables:

- Full request/response logging
- Detailed error stack traces
- Performance timing information
- Database query logging

### Debug Output Format

```javascript
// Debug log example
{
  timestamp: "2024-01-15T10:30:45.123Z",
  level: "debug",
  service: "proxy",
  event: "api_request",
  projectId: "train-alpha",
  method: "POST",
  path: "/v1/messages",
  headers: {
    "authorization": "Bearer ****" // Masked
  },
  body: { /* request body */ },
  duration: 1234,
  error: null
}
```

## Common Debugging Scenarios

### Authentication Issues

#### Debug Client Authentication

```bash
# Enable auth debugging
DEBUG=true AUTH_DEBUG=true bun run dev:proxy

# Check logs for auth flow
docker compose logs proxy | grep -i auth
```

Common auth debug patterns:

```javascript
// Successful auth
DEBUG: Checking client auth for train: train-alpha
DEBUG: Client API key found in credentials
DEBUG: Client auth successful

// Failed auth
DEBUG: Checking client auth for train: train-alpha
DEBUG: Client API key mismatch
DEBUG: Expected: cnp_live_abc123...
DEBUG: Received: cnp_live_xyz789...
```

#### Debug OAuth Flow

```bash
# Test OAuth refresh
DEBUG=true bun run scripts/test-oauth-refresh.ts <refresh_token>

# Monitor OAuth token refresh
docker compose logs -f proxy | grep -i oauth
```

### Request/Response Issues

#### Capture Full Request

```typescript
// Add request interceptor for debugging
app.use(async (c, next) => {
  if (process.env.DEBUG === 'true') {
    console.log('Request:', {
      method: c.req.method,
      url: c.req.url,
      headers: Object.fromEntries(c.req.headers),
      body: await c.req.json(),
    })
  }
  await next()
})
```

#### Debug Streaming Responses

```bash
# Monitor streaming chunks
docker compose exec postgres psql -U postgres claude_nexus -c "
  SELECT
    request_id,
    chunk_index,
    LENGTH(content) as size,
    created_at
  FROM streaming_chunks
  WHERE request_id = 'your-request-id'
  ORDER BY chunk_index;
"
```

### Database Issues

#### Enable Query Logging

```bash
# Log all SQL queries
docker compose exec postgres psql -U postgres -c "
  ALTER SYSTEM SET log_statement = 'all';
  SELECT pg_reload_conf();
"

# View query logs
docker compose logs postgres | grep -i statement
```

#### Debug Slow Queries

```sql
-- Enable query timing
SET log_min_duration_statement = 100; -- Log queries over 100ms

-- Check current slow queries
SELECT
  pid,
  now() - query_start AS duration,
  state,
  query
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY duration DESC;
```

#### Connection Pool Debugging

```typescript
// Log pool events
pool.on('connect', client => {
  console.log('Pool: client connected')
})

pool.on('error', (err, client) => {
  console.error('Pool error:', err)
})

pool.on('remove', client => {
  console.log('Pool: client removed')
})

// Check pool status
console.log({
  total: pool.totalCount,
  idle: pool.idleCount,
  waiting: pool.waitingCount,
})
```

### Memory Debugging

#### Heap Profiling

```bash
# Start with heap profiling
NODE_OPTIONS="--inspect=0.0.0.0:9229" bun run dev:proxy

# Connect Chrome DevTools
# Navigate to chrome://inspect
# Take heap snapshots and compare
```

#### Memory Usage Analysis

```javascript
// Add memory monitoring
setInterval(() => {
  const usage = process.memoryUsage()
  console.log({
    rss: `${Math.round(usage.rss / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(usage.heapTotal / 1024 / 1024)}MB`,
    heapUsed: `${Math.round(usage.heapUsed / 1024 / 1024)}MB`,
    external: `${Math.round(usage.external / 1024 / 1024)}MB`,
  })
}, 60000) // Every minute
```

### Network Debugging

#### Request Tracing

```bash
# Use curl with verbose output
curl -v -X POST http://localhost:3000/v1/messages \
  -H "Host: example.com" \
  -H "Authorization: Bearer your-key" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "test"}]}'

# Trace network calls
tcpdump -i any -w trace.pcap host api.anthropic.com
```

#### Proxy Request Debugging

```typescript
// Log outgoing requests to Claude
const originalFetch = fetch
global.fetch = async (...args) => {
  if (process.env.DEBUG === 'true') {
    console.log('Outgoing request:', args)
  }
  const response = await originalFetch(...args)
  if (process.env.DEBUG === 'true') {
    console.log('Response status:', response.status)
  }
  return response
}
```

## Debugging Tools

### Log Analysis

```bash
# Extract specific request
REQUEST_ID="req_123"
docker compose logs proxy | grep $REQUEST_ID > request_debug.log

# Parse JSON logs
docker compose logs proxy | jq 'select(.level == "error")'

# Count errors by type
docker compose logs proxy | jq -r 'select(.level == "error") | .error' | sort | uniq -c
```

### Database Inspection

```sql
-- Check request details
SELECT
  id,
  projectId,
  method,
  path,
  status_code,
  error_type,
  error_message,
  response_time_ms,
  created_at
FROM api_requests
WHERE id = 'your-request-id';

-- View request/response bodies
SELECT
  request_body,
  response_body
FROM api_requests
WHERE id = 'your-request-id'\gx
```

### Performance Profiling

```javascript
// Add performance marks
performance.mark('request-start')

// ... process request ...

performance.mark('request-end')
performance.measure('request-duration', 'request-start', 'request-end')

const measure = performance.getEntriesByName('request-duration')[0]
console.log(`Request took ${measure.duration}ms`)
```

## Debug Utilities

### Test Request Script

```typescript
// scripts/test-request.ts
import { config } from '../services/proxy/src/config'

async function testRequest() {
  const response = await fetch('http://localhost:3000/v1/messages', {
    method: 'POST',
    headers: {
      Host: 'test.example.com',
      Authorization: `Bearer ${config.testApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Test message' }],
      model: 'claude-3-haiku-20240307',
      max_tokens: 100,
    }),
  })

  console.log('Status:', response.status)
  console.log('Headers:', Object.fromEntries(response.headers))

  if (response.ok) {
    const data = await response.text()
    console.log('Response:', data)
  } else {
    console.error('Error:', await response.text())
  }
}

testRequest().catch(console.error)
```

### Health Check Script

```bash
#!/bin/bash
# scripts/health-check-debug.sh

echo "=== Proxy Health Check ==="
curl -s http://localhost:3000/health | jq .

echo -e "\n=== Dashboard Health Check ==="
curl -s http://localhost:3001/health | jq .

echo -e "\n=== Database Status ==="
docker compose exec postgres pg_isready

echo -e "\n=== Service Logs (last 10 lines) ==="
docker compose logs --tail=10 proxy

echo -e "\n=== Resource Usage ==="
docker stats --no-stream
```

### Request Replay

```typescript
// Replay a failed request
async function replayRequest(requestId: string) {
  const original = await db.query('SELECT * FROM api_requests WHERE id = $1', [requestId])

  if (!original.rows[0]) {
    throw new Error('Request not found')
  }

  const { projectId, request_body, headers } = original.rows[0]

  // Replay with debug enabled
  const response = await fetch(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: {
      ...JSON.parse(headers),
      'X-Debug': 'true',
      'X-Replay-Id': requestId,
    },
    body: request_body,
  })

  console.log('Replay response:', {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  })
}
```

## Production Debugging

### Safe Debug Mode

```typescript
// Enable debug for specific trains only
const debugTrains = process.env.DEBUG_TRAINS?.split(',') || []

if (debugTrains.includes(projectId)) {
  console.log('Debug enabled for train:', projectId)
  // Add debug headers, logging, etc.
}
```

### Debug Headers

```typescript
// Add debug information to response headers
if (c.req.header('X-Debug') === 'true') {
  c.header('X-Request-Id', requestId)
  c.header('X-Processing-Time', `${processingTime}ms`)
  c.header('X-Token-Count', `${tokenCount}`)
}
```

### Correlation IDs

```typescript
// Generate correlation ID for request tracing
const correlationId = c.req.header('X-Correlation-Id') || nanoid()
c.set('correlationId', correlationId)

// Include in all log entries
logger.info({
  correlationId,
  event: 'request_received',
  // ... other fields
})
```

## Debug Checklist

When debugging an issue:

- [ ] Enable debug mode (`DEBUG=true`)
- [ ] Check proxy logs for errors
- [ ] Verify database connectivity
- [ ] Test authentication separately
- [ ] Capture full request/response
- [ ] Check for memory leaks
- [ ] Monitor resource usage
- [ ] Test with minimal example
- [ ] Check for race conditions
- [ ] Review recent changes

## Common Debug Commands

```bash
# View all errors in last hour
docker compose logs --since 1h proxy | grep ERROR

# Check database size
docker compose exec postgres psql -U postgres claude_nexus -c "\l+"

# Monitor real-time logs
docker compose logs -f --tail=50 proxy dashboard

# Export logs for analysis
docker compose logs > debug-$(date +%Y%m%d-%H%M%S).log

# Check service health
for service in proxy dashboard postgres; do
  echo "=== $service ==="
  docker compose ps $service
done
```

## Next Steps

- [Review common issues](./common-issues.md)
- [Optimize performance](./performance.md)
- [Set up monitoring](../03-Operations/monitoring.md)
- [Check security](../03-Operations/security.md)
