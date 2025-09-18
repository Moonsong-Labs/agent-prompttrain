# ADR-014: SQL Query Logging for Development and Debugging

## Status

Accepted

## Context

During development and troubleshooting of Agent Prompt Train, developers need visibility into SQL queries being executed by the application. This is particularly important for:

- Debugging conversation linking logic
- Optimizing slow queries
- Understanding database performance issues
- Troubleshooting data consistency problems

The challenge is to provide comprehensive SQL logging without:

- Impacting production performance
- Exposing sensitive data in logs
- Creating excessive log noise
- Requiring code changes for each query

## Decision Drivers

- **Developer Experience**: Easy to enable/disable logging
- **Performance**: Zero overhead when disabled
- **Security**: No sensitive data exposure
- **Flexibility**: Different logging levels for different needs
- **Integration**: Works with existing logging infrastructure

## Considered Options

1. **Manual Query Logging**
   - Description: Add log statements around each query
   - Pros: Fine-grained control, explicit
   - Cons: Tedious, easy to miss queries, code clutter

2. **Database-Level Logging**
   - Description: Use PostgreSQL's built-in query logging
   - Pros: Complete coverage, no application changes
   - Cons: Requires database configuration, logs all connections

3. **Pool Wrapper with Logging**
   - Description: Wrap the pg Pool to intercept and log queries
   - Pros: Centralized, configurable, works with existing code
   - Cons: Requires careful implementation to preserve Pool behavior

## Decision

We will implement **Pool Wrapper with Logging** to provide comprehensive SQL query logging.

### Implementation Details

1. **SQL Logger Wrapper** (`services/proxy/src/utils/sql-logger.ts`):

```typescript
export function enableSqlLogging(
  pool: Pool,
  options: {
    logQueries?: boolean
    logSlowQueries?: boolean
    slowQueryThreshold?: number
    logStackTrace?: boolean
  }
): Pool
```

2. **Environment Variable Control**:
   - `DEBUG=true` - Enables all debug logging including SQL
   - `DEBUG_SQL=true` - Enables only SQL query logging
   - `SLOW_QUERY_THRESHOLD_MS=5000` - Threshold for slow query warnings

3. **Logging Features**:
   - Query text with parameters
   - Execution time measurement
   - Row count in results
   - Stack traces for debugging (optional)
   - Slow query warnings
   - Failed query details

4. **Security Considerations**:
   - Date objects converted to ISO strings for logging
   - Sensitive data patterns already masked by logger middleware
   - No password or API key logging

### Usage Example

```bash
# Enable SQL logging during development
DEBUG_SQL=true bun run dev

# Enable all debug logging
DEBUG=true bun run dev

# Configure slow query threshold
SLOW_QUERY_THRESHOLD_MS=1000 DEBUG_SQL=true bun run dev
```

### Log Output Format

```
[DEBUG] SQL Query {
  metadata: {
    query: "SELECT * FROM api_requests WHERE train_id = $1",
    values: ["example.com"],
    caller: "at ConversationLinker.findParentByHash"
  }
}

[WARN] Slow SQL query detected {
  metadata: {
    query: "SELECT COUNT(*) FROM api_requests...",
    duration: 5234,
    values: [...],
    caller: "at DashboardService.getStats"
  }
}
```

## Consequences

### Positive

- **Zero Production Impact**: Completely disabled by default
- **Comprehensive Coverage**: All queries automatically logged
- **Performance Insights**: Identifies slow queries and bottlenecks
- **Debugging Support**: Stack traces help locate query origins
- **Flexible Configuration**: Multiple enable/disable options

### Negative

- **Log Volume**: Can generate significant logs in development
- **Wrapper Complexity**: Must carefully preserve Pool behavior
- **Type Safety**: Requires careful typing to maintain compatibility

### Risks and Mitigations

- **Risk**: Wrapper breaks Pool functionality
  - **Mitigation**: Extensive testing, preserve all Pool methods

- **Risk**: Performance impact even when disabled
  - **Mitigation**: Early return if logging disabled, minimal overhead

- **Risk**: Sensitive data in logs
  - **Mitigation**: Rely on existing logger masking, document risks

## Implementation Notes

The SQL logging feature has been successfully implemented and provides valuable insights during development. Key learnings:

1. **Pool Wrapping**: Must preserve all Pool properties and methods
2. **Promise Handling**: Support both callback and promise-based queries
3. **Type Safety**: TypeScript's Pool interface requires careful adherence
4. **Integration**: Works seamlessly with existing database initialization

## Links

- [Implementation PR #44](https://github.com/Moonsong-Labs/agent-prompttrain/pull/44)
- [sql-logger.ts](../../../services/proxy/src/utils/sql-logger.ts)
- [Database Configuration](../../../services/proxy/src/services/database.ts)

---

Date: 2025-06-30
Authors: Development Team
