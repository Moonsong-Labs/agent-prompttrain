# ADR-005: Comprehensive Token Usage Tracking

## Status

Accepted

## Context

Claude API implements rate limiting based on token usage within 5-hour sliding windows. Initially, the proxy only tracked tokens in memory for basic statistics, which had several limitations:

- No persistence across restarts
- No account-level tracking (only domain-level)
- No support for monitoring Claude's 5-hour windows
- No historical data for cost analysis
- Couldn't track all request types (query_evaluation, quota)

With Claude's 140,000 token limit per 5-hour window, users needed better visibility into their usage patterns to avoid hitting rate limits unexpectedly.

## Decision Drivers

- **Rate Limit Compliance**: Monitor Claude API's 5-hour sliding windows
- **Account-Level Tracking**: Support multiple domains per account
- **Historical Analysis**: Enable cost tracking and usage patterns
- **Performance**: Minimal impact on request processing
- **Simplicity**: Avoid complex partitioning schemes initially
- **Completeness**: Track all request types, not just inference

## Considered Options

1. **Separate Partitioned Table**
   - Description: New `token_usage` table with monthly partitions
   - Pros: Optimized for time-series queries, easy archival
   - Cons: Complex implementation, data duplication, sync issues

2. **Time-Series Database**
   - Description: Use InfluxDB or TimescaleDB
   - Pros: Built for time-series data, automatic retention
   - Cons: Additional dependency, operational complexity

3. **In-Memory with Periodic Snapshots**
   - Description: Track in memory, periodically write to database
   - Pros: Fast, minimal request impact
   - Cons: Data loss risk, complex aggregation, no real-time queries

4. **Direct Storage in api_requests Table**
   - Description: Add account tracking to existing request table
   - Pros: Simple, single source of truth, no sync issues
   - Cons: Potentially slower queries on large datasets

## Decision

We will implement **direct storage in the api_requests table** with account-level tracking.

### Implementation Details

1. **Account Identification**:

   ```json
   // In credentials file
   {
     "type": "api_key",
     "accountId": "acc_f9e1c2d3b4a5", // Required for tracking
     "api_key": "sk-ant-..."
   }
   ```

2. **Database Schema**:

   ```sql
   ALTER TABLE api_requests
   ADD COLUMN account_id VARCHAR(255);

   CREATE INDEX idx_api_requests_account_time
   ON api_requests(account_id, created_at);
   ```

3. **Request Type Handling**:
   - Track ALL types: `inference`, `query_evaluation`, `quota`
   - Non-storable types excluded from response storage but tracked for metrics

4. **5-Hour Window Queries**:

   ```sql
   SELECT
     account_id,
     SUM(input_tokens + output_tokens) as tokens_used,
     COUNT(*) as request_count
   FROM api_requests
   WHERE account_id = $1
     AND created_at > NOW() - INTERVAL '5 hours'
   GROUP BY account_id;
   ```

5. **API Endpoints**:
   - `/api/token-usage/current` - Current window usage
   - `/api/token-usage/daily` - Historical daily aggregates
   - `/api/token-usage/time-series` - 5-minute granularity
   - `/api/token-usage/accounts` - All accounts overview

## Consequences

### Positive

- **Single Source of Truth**: All data in one table, no synchronization issues
- **Account-Level Visibility**: Track usage across multiple domains
- **5-Hour Window Support**: Accurate Claude API limit monitoring
- **Historical Data**: Complete usage history for analysis
- **Simple Implementation**: No complex partitioning or additional services
- **Real-Time Queries**: Instant access to current usage

### Negative

- **Query Performance**: May slow down with millions of records
- **No Automatic Archival**: Requires manual data management
- **Storage Growth**: Token data stored with full request records
- **Index Overhead**: Additional indexes for efficient queries

### Risks and Mitigations

- **Risk**: Slow queries on large datasets
  - **Mitigation**: Proper indexes on (account_id, created_at)
  - **Mitigation**: Consider partitioning in future if needed

- **Risk**: Missing account IDs in legacy data
  - **Mitigation**: Warning logs for missing accountId
  - **Mitigation**: Backward compatible with domain-only tracking

## Implementation Notes

- Introduced in PR #20
- Reuses existing `api_requests` table rather than creating new tables
- Efficient queries using PostgreSQL interval arithmetic
- Dashboard integration for visualization
- Rate limit warnings at 80% usage

## Monitoring and Alerts

1. **Usage Thresholds**:
   - Warn at 80% of 5-hour limit
   - Alert at 90% of 5-hour limit
   - Automatic model fallback when exceeded

2. **Metrics Tracked**:
   - Tokens per account per window
   - Request counts by type
   - Average tokens per request
   - Peak usage times

## Future Enhancements

1. **Table Partitioning**: Implement monthly partitions when data grows
2. **Automated Archival**: Move old data to cold storage
3. **Predictive Alerts**: ML-based usage prediction
4. **Cost Allocation**: Per-account billing support
5. **Usage Quotas**: Configurable limits per account

## Links

- [PR #20: Comprehensive token tracking](https://github.com/Moonsong-Labs/agent-prompttrain/pull/20)
- [Monitoring Guide](../../03-Operations/monitoring.md)
- [API Reference](../../02-User-Guide/api-reference.md#token-usage)

---

Date: 2024-06-25
Authors: Development Team
