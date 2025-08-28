# Technical Debt Register

This document tracks known technical debt in the Agent Prompt Train project. Each item includes context, impact, and proposed remediation.

## High Priority

### 1. Memory Leak in StorageAdapter

**Location**: `services/proxy/src/storage/StorageAdapter.ts:12-15`

**Issue**: The `requestIdMap` grows indefinitely as requests are processed, causing memory usage to increase over time.

```typescript
// Current problematic code
private requestIdMap = new Map<string, string>();

// Missing cleanup after storeResponse
```

**Impact**:

- Service crashes after extended operation
- Increased memory costs
- Potential data loss during OOM crashes

**Remediation**:

```typescript
async storeResponse(data: ResponseData) {
  // ... existing code ...

  // Add cleanup
  this.requestIdMap.delete(data.request_id);
}

// Add periodic cleanup for orphaned entries
setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  for (const [key, value] of this.requestIdMap.entries()) {
    if (value.timestamp < oneHourAgo) {
      this.requestIdMap.delete(key);
    }
  }
}, 300000); // Every 5 minutes
```

**Reference**: [PR #13 Review](https://github.com/Moonsong-Labs/agent-prompttrain/pull/13#review)

### 2. ✅ N+1 Query Pattern in Conversations API [RESOLVED]

**Location**: `services/proxy/src/routes/api.ts:456-460`

**Issue**: Correlated subqueries create an N+1 query pattern, causing poor performance with large datasets.

**Resolution** (2025-06-26):

- Replaced correlated subqueries with window functions using `ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY timestamp DESC, request_id DESC)`
- Added deterministic ordering with `request_id` as tie-breaker
- Created optimized indexes in migration `004-optimize-conversation-window-functions.ts`:
  - `idx_requests_conversation_timestamp_id` for efficient window function execution
  - `idx_requests_conversation_subtask` for subtask filtering
  - `idx_requests_request_id` for final LEFT JOIN
- Changed parent_task_request_id selection to use first subtask in conversation for consistency

**Performance Improvements**:

- Eliminated N+1 pattern by computing all fields in a single pass
- Reduced query complexity from O(n\*m) to O(n log n)
- Added proper indexes aligned with window function partitioning

**Reference**: [PR #13 Review](https://github.com/Moonsong-Labs/agent-prompttrain/pull/13#review)

## Medium Priority

### 3. ✅ N+1 Query in Token Usage Time Series [RESOLVED]

**Location**: `services/proxy/src/routes/api.ts:771-774`

**Issue**: Was looping through each account and executing separate queries for time series data.

**Resolution Date**: 2025-06-26

**Fix Applied**:

- Refactored to fetch all time series data in a single query
- Used UNNEST with array parameter to process all accounts at once
- Employed FILTER clause for conditional aggregation
- Grouped results by account using Map for efficient lookup

**Performance Improvement**:

- Reduced database queries from N+1 to 1 (where N = number of accounts)
- Significantly improved dashboard loading time for multiple accounts

### 4. ✅ Dashboard Overview Performance [RESOLVED]

**Location**: `services/dashboard/src/routes/overview.ts`

**Issue**: Dashboard overview page was fetching up to 10,000 conversations at once and processing them client-side, causing severe performance issues with large databases (40+ GB).

**Resolution Date**: 2025-08-11

**Fix Applied**:

Phase 1 (Initial Optimization):

- Created new `/api/dashboard/stats` endpoint for aggregated statistics using CTEs
- Added server-side pagination to `/api/conversations` endpoint (offset, limit, date filters)
- Reduced default fetch from 10,000 to 50 conversations
- Dashboard now fetches stats and conversations in parallel
- All aggregation moved to server-side using optimized SQL queries

Phase 2 (Query Restructuring - "Limit First, Aggregate Second"):

- Restructured `/api/conversations` query to paginate BEFORE aggregation
- CTEs now process only the 50 conversations needed for the current page
- Window functions applied only to relevant requests, not entire dataset
- Preserved exact same API output format for backward compatibility

**Performance Improvement**:

- Data transfer reduced by 99.5% (50 vs 10,000 records)
- Query execution time reduced from 6+ seconds to <500ms (12x improvement)
- Dashboard load time reduced from >10s to <1s
- Memory usage significantly reduced (no large arrays in browser)
- Database processes ~50 conversations instead of millions of rows

**Technical Implementation**:

Query optimization strategy:

1. First CTE identifies only the 50 conversation IDs for the current page
2. Second CTE fetches request data only for those 50 conversations
3. Third CTE aggregates only those 50 conversations
4. Final SELECT maintains original output structure

Key changes:

- Moved LIMIT/OFFSET to first CTE instead of last
- Window functions scoped to relevant requests only
- Leverages existing indexes from migration `004-optimize-conversation-window-functions.ts`

### 5. Missing Automated Tests

**Location**: Project-wide

**Issue**: ~~No automated test suite despite complex business logic.~~ **Partially Addressed**

**Status Update**: E2E tests have been implemented with Playwright (see ADR-021, PR #110). Unit and integration tests still pending.

**Impact**:

- ~~Risk of regressions~~ **Reduced** (E2E tests catch UI/workflow regressions)
- Slower development velocity (unit tests still needed)
- ~~Lower confidence in changes~~ **Improved** (E2E tests provide safety net)

**Remaining Work**:

1. Add unit tests for critical functions:
   - Message hashing
   - Token counting
   - Authentication logic
2. Add integration tests for API endpoints
3. ~~Add end-to-end tests for critical user journeys~~ ✅ **Completed**
4. ~~Set up CI/CD pipeline with test requirements~~ ✅ **Completed for E2E**

### 5. Configuration Hardcoding

**Location**: Various files

**Issue**: Some configuration values are hardcoded rather than externalized.

**Impact**:

- Requires code changes for configuration updates
- Risk of exposing sensitive values

**Remediation**:

- Audit all hardcoded values
- Move to environment variables or config files
- Document all configuration options

## Low Priority

### 6. Incomplete Error Handling

**Location**: Various async functions

**Issue**: Some async operations lack proper error handling and recovery.

**Impact**:

- Ungraceful failures
- Poor error messages for debugging

**Remediation**:

- Add try-catch blocks to all async operations
- Implement proper error logging
- Add error recovery mechanisms

### 7. ✅ Database Migration Strategy [RESOLVED]

**Location**: `scripts/db/migrations/`

**Issue**: Manual migration execution without version tracking.

**Resolution Date**: 2025-06-26

**Fix Applied**:

- Standardized on TypeScript migration scripts with numeric ordering
- Created comprehensive `init-database.sql` for fresh installations
- Updated `writer.ts` to use init SQL file instead of inline table creation
- Documented migration patterns and best practices
- All migrations are idempotent (safe to run multiple times)

**Improvements**:

- Consistent schema management approach
- Clear migration ordering with numeric prefixes
- TypeScript provides type safety and better tooling
- See ADR-012 for detailed architecture decision

**Future Enhancements** (Nice to have):

- Migration version tracking table
- Automated migration runner
- Rollback capability

### 8. API Response Caching

**Location**: API routes

**Issue**: No caching for expensive queries.

**Impact**:

- Repeated expensive computations
- Higher latency for common requests

**Remediation**:

- Implement Redis caching layer
- Add cache invalidation logic
- Configure TTLs appropriately

## Tracking and Resolution

### Process

1. **Identification**: Document new debt as it's introduced
2. **Prioritization**: Assess impact and effort quarterly
3. **Resolution**: Allocate 20% of development time to debt reduction
4. **Prevention**: Review PRs for new debt introduction

### Metrics

Track technical debt health:

- Number of high-priority items
- Average age of debt items
- Time spent on debt-related incidents
- Performance degradation trends

### Recent Progress

- ✅ Implemented conversation tracking (removed from debt)
- ✅ Added token usage tracking (removed from debt)
- ✅ Improved OAuth error handling (removed from debt)
- ✅ Fixed N+1 query pattern in Conversations API (2025-06-26)

## Future Considerations

### Architectural Improvements

1. **Event Sourcing**: Consider for better audit trail
2. **CQRS**: Separate read/write models for performance
3. **Service Mesh**: For better observability and security

### Performance Optimizations

1. **Connection Pooling**: Optimize database connections
2. **Query Optimization**: Regular query plan analysis
3. **Horizontal Scaling**: Prepare for multi-instance deployment

### Security Enhancements

1. **Secrets Management**: Integrate with secret stores
2. **Audit Logging**: Comprehensive security audit trail
3. **Rate Limiting**: Implement proper rate limiting

## References

- [Performance Troubleshooting](../05-Troubleshooting/performance.md)
- [Database Optimization](../03-Operations/database.md)
- [Architecture Overview](./internals.md)

---

Last Updated: 2025-06-26
Next Review: 2025-07-26

## Recent Grooming Progress

- ✅ Fixed Memory Leak in StorageAdapter (HIGH priority)
- ✅ Fixed N+1 Query in Conversations API (HIGH priority)
- ✅ Fixed N+1 Query in Token Usage Time Series (MEDIUM priority)
- ✅ Fixed console.log violations in TestSampleCollector
- ✅ Resolved Database Migration Strategy (LOW priority)
- ✅ Fixed critical data privacy issues in TestSampleCollector
- ✅ Consolidated database schema management
