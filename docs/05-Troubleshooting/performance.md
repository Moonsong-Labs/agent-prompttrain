# Performance Troubleshooting

This guide helps identify and resolve performance issues in Agent Prompt Train.

## Common Performance Issues

### High Response Latency

#### Symptoms

- Requests taking longer than 10 seconds
- Dashboard showing high P95/P99 latencies
- User complaints about slow responses

#### Diagnosis

1. **Check Database Performance**

```sql
-- Long running queries
SELECT pid, now() - query_start AS duration, query
FROM pg_stat_activity
WHERE (now() - query_start) > interval '5 seconds'
AND state = 'active';

-- Query execution stats
SELECT query, mean_exec_time, calls
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;
```

2. **Identify Slow Endpoints**

```sql
-- Slowest requests
SELECT
  method,
  path,
  AVG(response_time_ms) as avg_time,
  MAX(response_time_ms) as max_time,
  COUNT(*) as count
FROM api_requests
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY method, path
ORDER BY avg_time DESC;
```

3. **Check Resource Usage**

```bash
# System resources
docker stats

# Database connections
psql -c "SELECT count(*) FROM pg_stat_activity;"
```

#### Solutions

1. **Database Optimization**

```sql
-- Add missing indexes
CREATE INDEX CONCURRENTLY idx_api_requests_created_at ON api_requests(created_at);
CREATE INDEX CONCURRENTLY idx_api_requests_project_id ON api_requests(project_id);
CREATE INDEX CONCURRENTLY idx_api_requests_conversation ON api_requests(conversation_id, created_at);

-- Update statistics
ANALYZE api_requests;
ANALYZE streaming_chunks;
```

2. **Query Optimization**

Fix the N+1 query issue in conversations endpoint:

```typescript
// Before (N+1 problem)
const conversations = await getConversations()
for (const conv of conversations) {
  conv.latestRequest = await getLatestRequest(conv.id)
}

// After (single query)
const conversations = await db.raw(`
  WITH latest_requests AS (
    SELECT DISTINCT ON (conversation_id) 
      conversation_id,
      id as latest_request_id
    FROM api_requests
    ORDER BY conversation_id, created_at DESC
  )
  SELECT c.*, lr.latest_request_id
  FROM conversations c
  LEFT JOIN latest_requests lr ON c.id = lr.conversation_id
`)
```

3. **Connection Pooling**

```typescript
// Optimize pool settings
const pool = new Pool({
  max: 20, // Maximum connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
})
```

### Memory Leaks

#### Symptoms

- Increasing memory usage over time
- Service crashes with OOM errors
- Performance degradation after running for days

#### Diagnosis

```bash
# Monitor memory usage
docker stats proxy --no-stream

# Check for large objects
docker compose exec proxy node --inspect=0.0.0.0:9229
# Use Chrome DevTools to take heap snapshots
```

#### Solutions

1. **Fix RequestIdMap Memory Leak**

```typescript
// services/proxy/src/storage/StorageAdapter.ts
private requestIdMap = new Map<string, string>();

async storeResponse(data: ResponseData) {
  // ... existing code ...

  // Clean up the map entry after storing
  this.requestIdMap.delete(data.request_id);
}
```

2. **Implement Request Cleanup**

```typescript
// Add periodic cleanup
setInterval(() => {
  // Clean up old entries (older than 1 hour)
  const oneHourAgo = Date.now() - 3600000
  for (const [key, value] of this.requestIdMap.entries()) {
    if (value.timestamp < oneHourAgo) {
      this.requestIdMap.delete(key)
    }
  }
}, 300000) // Every 5 minutes
```

### Database Performance

#### Symptoms

- Slow query warnings in logs
- Database CPU at 100%
- Connection pool exhaustion

#### Diagnosis

```sql
-- Table bloat
SELECT
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size,
  pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) AS table_size,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename) - pg_relation_size(schemaname||'.'||tablename)) AS indexes_size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Missing indexes
SELECT
  schemaname,
  tablename,
  attname,
  n_distinct,
  most_common_vals
FROM pg_stats
WHERE schemaname = 'public'
AND n_distinct > 100
AND tablename IN ('api_requests', 'streaming_chunks');
```

#### Solutions

1. **Vacuum and Analyze**

```bash
# Manual vacuum
docker compose exec postgres vacuumdb -U postgres -d claude_nexus -z

# Configure autovacuum
ALTER TABLE api_requests SET (autovacuum_vacuum_scale_factor = 0.1);
ALTER TABLE streaming_chunks SET (autovacuum_vacuum_scale_factor = 0.1);
```

2. **Partition Large Tables**

```sql
-- Partition api_requests by month
CREATE TABLE api_requests_2024_01 PARTITION OF api_requests
FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

CREATE TABLE api_requests_2024_02 PARTITION OF api_requests
FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
```

3. **Optimize PostgreSQL Configuration**

```ini
# postgresql.conf
shared_buffers = 1GB
effective_cache_size = 3GB
maintenance_work_mem = 256MB
checkpoint_completion_target = 0.9
wal_buffers = 16MB
default_statistics_target = 100
random_page_cost = 1.1
effective_io_concurrency = 200
work_mem = 10MB
min_wal_size = 1GB
max_wal_size = 4GB
```

### High Token Usage

#### Symptoms

- Unexpectedly high token consumption
- Hitting rate limits frequently
- High costs

#### Diagnosis

```sql
-- Find high token usage requests
SELECT
  project_id,
  model,
  request_type,
  AVG(input_tokens + output_tokens) as avg_tokens,
  MAX(input_tokens + output_tokens) as max_tokens,
  COUNT(*) as count
FROM api_requests
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY project_id, model, request_type
ORDER BY avg_tokens DESC;

-- Identify token usage patterns
SELECT
  date_trunc('hour', created_at) as hour,
  SUM(input_tokens) as input,
  SUM(output_tokens) as output,
  COUNT(*) as requests
FROM api_requests
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY hour
ORDER BY hour;
```

#### Solutions

1. **Implement Token Limits**

```typescript
// Add request validation
if (requestBody.max_tokens > 4000) {
  return res.status(400).json({
    error: 'max_tokens too high',
    message: 'Maximum allowed tokens is 4000',
  })
}
```

2. **Cache Common Responses**

```typescript
// Implement response caching for repeated queries
const cacheKey = generateCacheKey(request)
const cached = await cache.get(cacheKey)
if (cached) {
  return cached
}
```

## Performance Optimization Strategies

### 1. Request Optimization

- **Batch Processing**: Group multiple small requests
- **Request Deduplication**: Cache identical requests
- **Smart Routing**: Route to appropriate model based on complexity

### 2. Database Optimization

- **Index Strategy**: Create indexes for common query patterns
- **Data Retention**: Archive old data to keep tables manageable
- **Read Replicas**: Offload dashboard queries to replica

### 3. Caching Strategy

```typescript
// Multi-level caching
const cache = {
  memory: new LRU({ max: 1000 }),
  redis: new Redis(),

  async get(key: string) {
    // Try memory first
    let value = this.memory.get(key)
    if (value) return value

    // Try Redis
    value = await this.redis.get(key)
    if (value) {
      this.memory.set(key, value)
      return value
    }

    return null
  },
}
```

### 4. Load Balancing

```nginx
# nginx.conf for load balancing
upstream claude_proxy {
    least_conn;
    server proxy1:3000 weight=3;
    server proxy2:3000 weight=2;
    server proxy3:3000 weight=1;
}
```

## Monitoring Performance

### Key Metrics to Track

1. **Response Time Percentiles**
   - P50, P95, P99 latencies
   - By endpoint and project_id

2. **Throughput**
   - Requests per second
   - Tokens per minute

3. **Error Rates**
   - By error type
   - By project_id

4. **Resource Usage**
   - CPU and memory usage
   - Database connections
   - Network I/O

### Performance Dashboard

Create Grafana dashboard with:

```json
{
  "panels": [
    {
      "title": "Request Latency",
      "targets": [
        {
          "expr": "histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))"
        }
      ]
    },
    {
      "title": "Database Query Time",
      "targets": [
        {
          "expr": "rate(pg_stat_statements_total_time[5m])"
        }
      ]
    },
    {
      "title": "Token Usage Rate",
      "targets": [
        {
          "expr": "rate(claude_tokens_total[5m])"
        }
      ]
    }
  ]
}
```

## Load Testing

### Prepare Load Tests

```javascript
// k6 load test script
import http from 'k6/http'
import { check } from 'k6'

export let options = {
  stages: [
    { duration: '5m', target: 100 },
    { duration: '10m', target: 100 },
    { duration: '5m', target: 0 },
  ],
}

export default function () {
  let response = http.post(
    'http://localhost:3000/v1/messages',
    JSON.stringify({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'claude-3-haiku-20240307',
      max_tokens: 100,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-key',
        Host: 'test.example.com',
      },
    }
  )

  check(response, {
    'status is 200': r => r.status === 200,
    'response time < 500ms': r => r.timings.duration < 500,
  })
}
```

## Next Steps

- [Review common issues](./common-issues.md)
- [Set up monitoring](../03-Operations/monitoring.md)
- [Configure alerts](../03-Operations/monitoring.md#alerting)
- [Optimize database](../03-Operations/database.md)
