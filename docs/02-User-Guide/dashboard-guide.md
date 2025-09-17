# Dashboard Guide

The Agent Prompt Train Dashboard provides real-time monitoring and analytics for your Claude API usage.

## Accessing the Dashboard

### Default Access

The dashboard runs on port 3001 by default:

```
http://localhost:3001
```

### Authentication

Enter your dashboard API key on the login page. This key is configured in your `.env` file:

```bash
DASHBOARD_API_KEY=your-secure-dashboard-key
```

The authentication is stored as a cookie for the session.

## Dashboard Features

### Overview Page

The main dashboard displays:

- **Total Requests**: Cumulative request count
- **Total Tokens**: Combined input/output token usage
- **Active Trains**: Number of trains using the proxy
- **Total Sub-tasks**: Count of Task tool invocations
- **Success Rate**: Percentage of successful requests
- **Average Latency**: Mean response time

### Real-time Metrics

Live updates via Server-Sent Events (SSE) show:

- Current request activity
- Token usage trends
- Error rates
- Response time distribution

### Token Usage Analytics

#### Current Window (5-hour)

Monitor Claude API rate limits:

- Token consumption by account
- Usage percentage of 5-hour limit
- Time until window reset
- Projected usage trends

#### Historical Usage

View daily token usage:

- Daily breakdown by account/train
- Cost estimation
- Usage patterns and trends
- Export data for analysis

### Conversation Tracking

#### Conversation List

- Grouped by conversation ID
- Shows message count per conversation
- Branch visualization
- Sub-task indicators

#### Conversation Timeline

Interactive visualization showing:

- Message flow with timestamps
- Branch points (blue nodes)
- Sub-tasks (gray boxes)
- Token usage per message

#### Sub-task Visualization

- Spawned tasks appear as separate nodes
- Click to navigate to sub-task conversation
- Hover for task prompt preview
- Shows task completion status

### Request History

Browse individual requests with:

- Request/response details
- Token counts
- Latency metrics
- Error messages
- Full JSON payloads
- Image display for tool_result content (PNG, JPEG, GIF, WebP)

Filter by:

- Domain
- Time range
- Request type
- Status (success/error)

### Account Management

View per-account statistics:

- Token usage by account ID
- Domain associations
- Authentication methods
- Usage limits and quotas

## Navigation

### URL Parameters

Many dashboard views support URL parameters:

```
# Filter by train ID
/requests?trainId=train-alpha

# Filter by account
/token-usage?accountId=acc_12345

# View specific conversation
/conversations?id=conv_uuid

# Time range selection
/token-usage/daily?days=7
```

### Keyboard Shortcuts

- `r` - Refresh current view
- `f` - Toggle filters
- `esc` - Close modals
- `/` - Focus search

## Charts and Visualizations

### Token Usage Chart

- Line chart showing usage over time
- Stacked by train ID or account
- Zoom and pan capabilities
- Export as PNG/SVG

### Latency Distribution

- Histogram of response times
- P50, P95, P99 percentiles
- Identify performance outliers

### Error Rate Trends

- Error frequency over time
- Error type breakdown
- Correlation with usage spikes

## Advanced Features

### Caching

Dashboard responses are cached for performance:

- Default TTL: 30 seconds
- Disable: `DASHBOARD_CACHE_TTL=0`
- Force refresh: Add `?refresh=true`

### Export Data

Export functionality for:

- Token usage reports (CSV)
- Conversation histories (JSON)
- Request logs (JSON)
- Analytics summaries (PDF)

### Real-time Notifications

Configure alerts for:

- High error rates
- Token limit approaching
- Slow response times
- Failed authentications

### Image Display in Tool Results

The dashboard supports displaying images from tool_result content:

- **Supported formats**: PNG, JPEG, GIF, WebP
- **Maximum size**: 10MB per image
- **Display constraints**: Images are automatically resized to fit within the conversation view
- **Security**: Base64 data URIs are validated and sanitized
- **Performance**: Images use lazy loading for better page performance

## Performance Monitoring

### Slow Query Detection

Queries exceeding threshold are logged:

```bash
SLOW_QUERY_THRESHOLD_MS=5000
```

View slow queries in:

- Dashboard logs
- Performance tab
- Database metrics

### Database Statistics

Monitor PostgreSQL performance:

- Active connections
- Query execution time
- Index usage
- Table sizes

## Troubleshooting Dashboard Issues

### Dashboard Won't Load

1. Check service is running:

   ```bash
   curl http://localhost:3001/health
   ```

2. Verify database connection:

   ```bash
   psql $DATABASE_URL -c "SELECT 1"
   ```

3. Check logs:
   ```bash
   docker compose logs dashboard
   ```

### Authentication Issues

1. Verify API key in .env:

   ```bash
   echo $DASHBOARD_API_KEY
   ```

2. Clear browser cookies

3. Try incognito/private mode

### Missing Data

1. Ensure storage is enabled:

   ```bash
   STORAGE_ENABLED=true
   ```

2. Check request processing:

   ```bash
   SELECT COUNT(*) FROM api_requests;
   ```

3. Verify streaming chunks:
   ```bash
   SELECT COUNT(*) FROM streaming_chunks;
   ```

### Performance Issues

1. Enable query logging:

   ```bash
   SLOW_QUERY_THRESHOLD_MS=1000
   ```

2. Check database indexes:

   ```sql
   SELECT * FROM pg_indexes WHERE tablename = 'api_requests';
   ```

3. Monitor connection pool:
   ```bash
   SELECT count(*) FROM pg_stat_activity;
   ```

## Dashboard API

The dashboard exposes APIs for integration:

### Get Current Stats

```bash
curl http://localhost:3001/api/stats \
  -H "X-Dashboard-Key: $DASHBOARD_API_KEY"
```

### Get Token Usage

```bash
curl "http://localhost:3001/api/token-usage/current?window=300" \
  -H "X-Dashboard-Key: $DASHBOARD_API_KEY"
```

### Get Conversations

```bash
curl "http://localhost:3001/api/conversations?limit=10" \
  -H "X-Dashboard-Key: $DASHBOARD_API_KEY"
```

## Customization

### Environment Variables

```bash
# Dashboard port
DASHBOARD_PORT=3001

# Cache settings
DASHBOARD_CACHE_TTL=30

# Display settings
DASHBOARD_TIMEZONE=UTC
DASHBOARD_DATE_FORMAT=ISO

# Feature flags
DASHBOARD_ENABLE_EXPORT=true
DASHBOARD_ENABLE_REALTIME=true
```

### Custom Themes

Place custom CSS in:

```
services/dashboard/public/custom.css
```

## Best Practices

1. **Regular Monitoring**: Check dashboard daily for anomalies
2. **Set Up Alerts**: Configure notifications for critical metrics
3. **Archive Old Data**: Export and archive historical data monthly
4. **Monitor Costs**: Track token usage against budget
5. **Review Errors**: Investigate error patterns weekly

## Next Steps

- [Configure alerts](../03-Operations/monitoring.md)
- [Optimize performance](../05-Troubleshooting/performance.md)
- [Set up backups](../03-Operations/backup-recovery.md)
- [Review security](../03-Operations/security.md)
