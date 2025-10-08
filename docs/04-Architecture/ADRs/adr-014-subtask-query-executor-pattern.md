# ADR-014: SubtaskQueryExecutor Pattern for Task Detection

## Status

Accepted

## Context

The proxy system needs to detect when a request is a subtask spawned by the Task tool. Previously, this was implemented using a two-phase approach:

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
SELECT request_id, response_body, timestamp
FROM api_requests
WHERE project_id = $1
  AND timestamp BETWEEN $2 AND $3
  AND response_body @> jsonb_build_object(
    'content', jsonb_build_array(
      jsonb_build_object(
        'type', 'tool_use',
        'name', 'Task',
        'input', jsonb_build_object('prompt', $4::text)
      )
    )
  )
```

This query leverages a GIN index on `response_body` for efficient lookups.

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
