# ADR-014: SubtaskQueryExecutor Pattern for Task Detection

## Status

Accepted

## Context

The proxy system needs to detect when a request is a subtask spawned by Claude Code's subagent tool (`Agent` in 2.1+, `Task` in 2.0 and earlier — see `SUBAGENT_TOOL_NAMES`). Previously, this was implemented using a two-phase approach:

1. ConversationLinker would detect potential subtasks
2. The proxy service would confirm by querying the database

This approach had several issues:

- Business logic was split between multiple components
- The rebuild script had to duplicate the task detection logic
- Database queries were not optimized for the specific use case

## Decision

We will implement a SubtaskQueryExecutor pattern that:

1. Moves all subtask detection logic into ConversationLinker
2. Uses dependency injection to provide database query capability
3. Optimizes queries using PostgreSQL's `@>` containment operator when possible

### Implementation Details

**SubtaskQueryExecutor Type:**

```typescript
export type SubtaskQueryExecutor = (
  project_id: string,
  timestamp: Date,
  debugMode?: boolean,
  subtaskPrompt?: string // Optional for SQL-level optimization
) => Promise<TaskInvocation[] | undefined>
```

**Query Optimization:**
When a subtask prompt is provided, the executor uses an optimized query:

```sql
-- One containment test per name in SUBAGENT_TOOL_NAMES, bound as $4 onwards
-- ('Agent' for Claude Code 2.1+, 'Task' for 2.0 and earlier).
-- Note: project_id is deliberately NOT filtered, so a subtask is still matched
-- when the parent and child requests used different accounts.
SELECT r.request_id, r.response_body, r.timestamp
FROM api_requests r
WHERE r.timestamp >= $1
  AND r.timestamp <= $2
  AND r.response_body IS NOT NULL
  AND (
    r.response_body->'content' @> jsonb_build_array(
      jsonb_build_object(
        'type', 'tool_use',
        'name', $4::text,
        'input', jsonb_build_object('prompt', $3::text)
      )
    )
    OR r.response_body->'content' @> jsonb_build_array(
      jsonb_build_object(
        'type', 'tool_use',
        'name', $5::text,
        'input', jsonb_build_object('prompt', $3::text)
      )
    )
  )
ORDER BY r.timestamp DESC
LIMIT 10
```

Containment (`@>`) keeps the query servable by the GIN index on `response_body`. In practice the
24-hour `timestamp` range is selective enough that the planner prefers the timestamp index; either
way the predicate stays index-friendly rather than degrading to a full scan.

## Consequences

### Positive

- **Single Source of Truth**: All subtask detection logic is centralized in ConversationLinker
- **Performance**: SQL-level filtering with GIN indexes significantly improves query performance
- **Reusability**: Both real-time (proxy) and batch (rebuild script) processing use the same code path
- **Testability**: The pattern allows easy mocking of the query executor for unit tests
- **Flexibility**: Different implementations can be provided for different contexts

### Negative

- **Complexity**: Adds another layer of abstraction with the executor pattern
- **Migration**: Existing code needs to be updated to use the new pattern

### Neutral

- **Database Dependency**: ConversationLinker now depends on a query executor, but this is provided via dependency injection

## Implementation Notes

1. **Time Window Configuration**: Currently uses hardcoded 24-hour query window and 30-second match window. Consider making these configurable.

2. **Error Handling**: The executor should distinguish between "no results" and "database error" scenarios.

3. **Index Requirements**: Requires a GIN index on the `response_body` column for optimal performance.

## References

- [PostgreSQL JSONB Containment](https://www.postgresql.org/docs/current/datatype-json.html#JSON-CONTAINMENT)
- [GIN Indexes for JSONB](https://www.postgresql.org/docs/current/gin-builtin-opclasses.html)
