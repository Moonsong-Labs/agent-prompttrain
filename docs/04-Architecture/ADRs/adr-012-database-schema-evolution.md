# ADR-012: Database Schema Evolution Strategy

## Status

Accepted

## Context

As the Agent Prompt Train evolves, we need a systematic approach to manage database schema changes. Initially, the project used a single `init-database.sql` script, which worked well for fresh installations but created challenges for:

- Existing deployments needing schema updates
- Tracking schema version history
- Rolling back problematic changes
- Understanding when and why schema changes were made
- Coordinating schema changes across team members

We needed a migration system that could handle incremental schema changes while maintaining backward compatibility and data integrity.

## Decision Drivers

- **Incremental Updates**: Support schema evolution without recreating databases
- **Version Control**: Track schema changes alongside code changes
- **Rollback Capability**: Ability to revert problematic migrations
- **Data Preservation**: Update schemas without losing existing data
- **Idempotency**: Migrations should be safe to run multiple times
- **Simplicity**: Avoid complex migration frameworks for a Bun-based project
- **Transparency**: Clear visibility into what each migration does

## Considered Options

1. **SQL Migration Files Only**
   - Description: Plain SQL files with version numbers
   - Pros: Simple, database-native, no dependencies
   - Cons: Limited scripting capability, harder to handle complex migrations

2. **Full Migration Framework (Knex, TypeORM, Prisma)**
   - Description: Use an established migration framework
   - Pros: Feature-rich, battle-tested, automatic tracking
   - Cons: Heavy dependencies, may conflict with Bun, learning curve

3. **Custom TypeScript Migration Scripts**
   - Description: TypeScript files that execute SQL with custom logic
   - Pros: Full programming power, type safety, fits Bun ecosystem
   - Cons: Need to build version tracking, more complex than SQL

4. **Hybrid Approach**
   - Description: TypeScript scripts for complex migrations, SQL for simple ones
   - Pros: Flexibility, use right tool for the job
   - Cons: Inconsistency, two systems to maintain

## Decision

We will implement **custom TypeScript migration scripts** with a simple numeric ordering system.

### Implementation Details

1. **Migration Structure**:

   ```
   scripts/db/migrations/
   ├── 000-init-database.ts
   ├── 001-add-conversation-tracking.ts
   ├── 002-optimize-conversation-indexes.ts
   ├── 003-add-subtask-tracking.ts
   ├── 004-optimize-conversation-window-functions.ts
   ├── 005-populate-account-ids.ts
   └── README.md
   ```

2. **Naming Convention**:
   - 3-digit numeric prefix for ordering (000, 001, 002...)
   - Descriptive name after the number
   - TypeScript extension for Bun compatibility

3. **Migration Template**:

   ```typescript
   #!/usr/bin/env bun
   import { Pool } from 'pg'

   async function migrateName() {
     const pool = new Pool({ connectionString: process.env.DATABASE_URL })

     try {
       await pool.query('BEGIN')

       // Migration logic here
       // Use IF NOT EXISTS, IF EXISTS for idempotency

       await pool.query('COMMIT')
       console.log('Migration completed successfully!')
     } catch (error) {
       await pool.query('ROLLBACK')
       console.error('Migration failed:', error)
       process.exit(1)
     } finally {
       await pool.end()
     }
   }

   migrateName().catch(console.error)
   ```

4. **Idempotency Requirements**:
   - Use `IF NOT EXISTS` for creating objects
   - Check column existence before adding
   - Make data updates conditional
   - Support running migrations multiple times safely

5. **Documentation Requirements**:
   - Each migration must have clear comments
   - Update migrations README with details
   - Reference related PRs and issues
   - Include example queries when relevant

## Consequences

### Positive

- **Full Control**: Complete flexibility in migration logic
- **Type Safety**: TypeScript ensures correct database operations
- **Bun Native**: Works seamlessly with the project's runtime
- **Self-Contained**: Each migration is independent and executable
- **Debugging**: Easy to test and debug individual migrations
- **Complex Operations**: Can handle data transformations, not just DDL
- **Progressive Enhancement**: Can add version tracking later if needed

### Negative

- **Manual Ordering**: Developers must choose next number manually
- **No Automatic Rollback**: Must write rollback logic if needed
- **No Version Tracking**: No built-in record of applied migrations
- **Potential Conflicts**: Two developers might use same number
- **Manual Execution**: No automatic migration runner (yet)

### Risks and Mitigations

- **Risk**: Duplicate migration numbers
  - **Mitigation**: Code review process catches conflicts
  - **Mitigation**: GitHub PR checks for existing numbers

- **Risk**: Forgetting to run migrations
  - **Mitigation**: Document in deployment checklist
  - **Mitigation**: Add startup check in future

- **Risk**: Migration failures leaving inconsistent state
  - **Mitigation**: Always use transactions
  - **Mitigation**: Test migrations on dev database first

## Implementation Notes

- Each migration runs in a transaction for atomicity
- Migrations should be idempotent (safe to run multiple times)
- Complex data migrations include progress logging
- Performance optimizations include ANALYZE after bulk updates
- init-database.sql remains for fresh installations
- Migrations complement, not replace, the init script

## Migration Best Practices

1. **Before Writing a Migration**:
   - Check if changes can be backward compatible
   - Consider impact on running systems
   - Plan for data migration if needed

2. **Writing Migrations**:
   - Start with BEGIN, end with COMMIT
   - Always handle errors with ROLLBACK
   - Include existence checks for idempotency
   - Add helpful console output
   - Run ANALYZE after significant changes

3. **Testing Migrations**:
   - Test on a copy of production data
   - Verify idempotency by running twice
   - Check performance impact
   - Ensure rollback strategy exists

4. **Deployment**:
   - Run migrations before deploying new code
   - Monitor for errors during execution
   - Have rollback plan ready
   - Document in release notes

## Future Enhancements

1. **Migration Runner**: Build a tool to run all pending migrations
2. **Version Tracking**: Add migrations table to track applied versions
3. **Rollback Scripts**: Standardize down migrations
4. **Validation**: Pre-flight checks before migrations
5. **Auto-Generation**: Generate migrations from schema diffs
6. **CI Integration**: Automated migration testing

## Examples

### Adding System Hash Column (006-split-conversation-hashes.ts)

```typescript
// Add column for dual hash system
await pool.query(`
  ALTER TABLE api_requests 
  ADD COLUMN IF NOT EXISTS system_hash VARCHAR(64)
`)

// Create index for the new column
await pool.query(`
  CREATE INDEX IF NOT EXISTS idx_api_requests_system_hash 
  ON api_requests(system_hash) 
  WHERE system_hash IS NOT NULL
`)
```

### Adding Parent Request ID (007-add-parent-request-id.ts)

```typescript
// Add foreign key reference column
await pool.query(`
  ALTER TABLE api_requests 
  ADD COLUMN IF NOT EXISTS parent_request_id UUID REFERENCES api_requests(request_id)
`)

// Create index
await pool.query(`
  CREATE INDEX IF NOT EXISTS idx_api_requests_parent_request_id 
  ON api_requests(parent_request_id)
`)

// Populate existing data
await pool.query(`
  WITH parent_mapping AS (
    SELECT child.request_id AS child_id, 
           parent.request_id AS parent_id
    FROM api_requests child
    JOIN api_requests parent 
      ON child.parent_message_hash = parent.current_message_hash
      AND child.train_id = parent.train_id
      AND child.conversation_id = parent.conversation_id
  )
  UPDATE api_requests 
  SET parent_request_id = parent_mapping.parent_id
  FROM parent_mapping 
  WHERE api_requests.request_id = parent_mapping.child_id
`)
```

### Adding a Column (003-add-subtask-tracking.ts)

```typescript
// Add columns with existence check
await pool.query(`
  ALTER TABLE api_requests
  ADD COLUMN IF NOT EXISTS parent_task_request_id UUID REFERENCES api_requests(request_id),
  ADD COLUMN IF NOT EXISTS is_subtask BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS task_tool_invocation JSONB
`)
```

### Creating Indexes (004-optimize-conversation-window-functions.ts)

```typescript
// Create index with IF NOT EXISTS
await pool.query(`
  CREATE INDEX IF NOT EXISTS idx_requests_conversation_timestamp_id 
  ON api_requests(conversation_id, timestamp DESC, request_id DESC) 
  WHERE conversation_id IS NOT NULL
`)
```

### Data Migration (005-populate-account-ids.ts)

```typescript
// Update data conditionally
await pool.query(
  `
  UPDATE api_requests 
  SET account_id = $1 
  WHERE train_id = ANY($2::text[])
    AND account_id IS NULL
`,
  [mapping.accountId, mapping.train_ids]
)
```

## Links

- [Database Documentation](../../03-Operations/database.md)
- [Migration Scripts](../../../scripts/db/migrations/)
- [Init Database Script](../../../scripts/init-database.sql)
- [Technical Debt Register](../technical-debt.md)

---

Date: 2025-06-26
Authors: Development Team
