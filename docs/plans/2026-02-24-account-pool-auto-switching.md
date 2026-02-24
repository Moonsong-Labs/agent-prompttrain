# Account Pool Auto-Switching Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically switch between linked accounts when Anthropic's real-time utilization (5h or 7d window) exceeds a configurable threshold, so high-usage projects aren't blocked by rate limits.

**Architecture:** A new `AccountPoolService` sits between `AuthenticationService` and credential queries. It calls the Anthropic OAuth usage API (with 60s caching) to get real utilization percentages, and uses sticky least-loaded selection. Projects with 2+ linked accounts use the pool; 0-1 accounts retain current behavior.

**Tech Stack:** Bun, TypeScript, PostgreSQL, pg (node-postgres), Hono

**Design doc:** `docs/plans/2026-02-24-account-pool-auto-switching-design.md`

---

### Task 1: Database Migration — Add Threshold Column

**Files:**

- Create: `scripts/db/migrations/018-account-pool-threshold.ts`

**Step 1: Write the migration script**

Follow the pattern from `scripts/db/migrations/017-multi-provider-support.ts`.

```typescript
import { Pool } from 'pg'

/**
 * Migration 018: Add token_limit_threshold to credentials table
 *
 * Adds per-account threshold for the account pool auto-switching feature.
 * When an account's utilization (from Anthropic OAuth API) exceeds this
 * threshold, the pool switches to the next available account.
 */
async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  try {
    console.log('Migration 018: Adding token_limit_threshold to credentials table...')

    await pool.query('BEGIN')

    console.log('Adding token_limit_threshold column...')
    await pool.query(`
      ALTER TABLE credentials
      ADD COLUMN IF NOT EXISTS token_limit_threshold DECIMAL(3,2) NOT NULL DEFAULT 0.80
    `)

    console.log('Adding CHECK constraint...')
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_token_limit_threshold_range'
        ) THEN
          ALTER TABLE credentials
          ADD CONSTRAINT chk_token_limit_threshold_range
          CHECK (token_limit_threshold > 0 AND token_limit_threshold <= 1);
        END IF;
      END $$
    `)

    await pool.query('COMMIT')

    // Verify
    const result = await pool.query(`
      SELECT column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_name = 'credentials' AND column_name = 'token_limit_threshold'
    `)
    console.log('\nMigration complete:')
    for (const row of result.rows) {
      console.log(`  ${row.column_name}: ${row.data_type} (default: ${row.column_default})`)
    }
  } catch (error) {
    await pool.query('ROLLBACK')
    console.error('Migration failed:', error)
    throw error
  } finally {
    await pool.end()
  }
}

migrate().catch(err => {
  console.error(err)
  process.exit(1)
})
```

**Step 2: Run the migration**

Run: `bun run scripts/db/migrations/018-account-pool-threshold.ts`
Expected: Column added with default 0.80.

**Step 3: Commit**

```bash
git add scripts/db/migrations/018-account-pool-threshold.ts
git commit -m "feat(db): add token_limit_threshold column for account pool switching"
```

---

### Task 2: Update Shared Types

**Files:**

- Modify: `packages/shared/src/types/credentials.ts:7-14` (BaseCredential interface)

**Step 1: Add threshold field to BaseCredential**

In `packages/shared/src/types/credentials.ts`, add to `BaseCredential` (after line 13):

```typescript
export interface BaseCredential {
  id: string
  account_id: string
  account_name: string
  provider: ProviderType
  created_at: Date
  updated_at: Date
  token_limit_threshold: number
}
```

**Step 2: Add OAuthUsageData type**

Add a new type to `packages/shared/src/types/credentials.ts` for the Anthropic usage API response (after line 175 or in a sensible location):

```typescript
export interface OAuthUsageWindow {
  utilization: number
  resets_at: string
}

export interface OAuthUsageData {
  five_hour: OAuthUsageWindow | null
  seven_day: OAuthUsageWindow | null
  seven_day_opus: OAuthUsageWindow | null
  seven_day_sonnet: OAuthUsageWindow | null
}
```

**Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (new fields have DB defaults, existing code does `SELECT *`)

**Step 4: Commit**

```bash
git add packages/shared/src/types/credentials.ts
git commit -m "feat(shared): add token_limit_threshold and OAuthUsageData types"
```

---

### Task 3: Add getProjectLinkedCredentials Query

**Files:**

- Modify: `packages/shared/src/database/queries/project-queries.ts` (add new function at end)

**Step 1: Add the query function**

Append to `packages/shared/src/database/queries/project-queries.ts`:

```typescript
/**
 * Get all credentials linked to a project via project_accounts junction table.
 * Used by AccountPoolService to determine pool eligibility (2+ accounts)
 * and to get the pool of available accounts.
 */
export async function getProjectLinkedCredentials(
  pool: Pool,
  projectId: string
): Promise<Credential[]> {
  const result = await pool.query<Credential>(
    `
    SELECT c.*
    FROM project_accounts pa
    JOIN credentials c ON pa.credential_id = c.id
    JOIN projects p ON pa.project_id = p.id
    WHERE p.project_id = $1
    ORDER BY pa.linked_at ASC
    `,
    [projectId]
  )
  return result.rows
}
```

Note: The column may be `created_at` instead of `linked_at` on `project_accounts`. Check the actual schema and adjust accordingly.

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/shared/src/database/queries/project-queries.ts
git commit -m "feat(shared): add getProjectLinkedCredentials query for account pool"
```

---

### Task 4: Create AccountPoolService

**Files:**

- Create: `services/proxy/src/services/account-pool-service.ts`

**Step 1: Write the service**

This is the core service. Key responsibilities:

- Fetch usage from Anthropic OAuth API with 60s caching
- Implement sticky least-loaded selection
- Throw `AccountPoolExhaustedError` when all accounts exhausted

The service needs:

- `Pool` for database queries (fetching linked credentials)
- Access to `getApiKey()` from `credentials.ts` to get valid OAuth tokens for the usage API call
- In-memory caches: sticky map + usage cache

**Important implementation details:**

1. **Usage fetch**: Reuse the same pattern as `GET /api/oauth-usage/:accountId` in `services/proxy/src/routes/api.ts:1469-1517`. Call `https://api.anthropic.com/api/oauth/usage` with the account's OAuth token.

2. **Max utilization**: For each account, compute `Math.max(five_hour?.utilization ?? 0, seven_day?.utilization ?? 0)`. Switch when this exceeds `token_limit_threshold`.

3. **Cache**: `Map<string, { usage: OAuthUsageData, fetchedAt: number }>` with 60s TTL.

4. **Sticky map**: `Map<string, string>` mapping `projectId -> accountId`.

5. **Parallel usage fetches**: When checking all linked accounts, use `Promise.all()` to fetch usage concurrently (most will be cache hits).

6. **Error handling**: If the OAuth usage API fails for an account, treat it conservatively (assume over threshold) so we don't accidentally overload it.

7. **Bedrock accounts**: Skip them in pool selection (no OAuth usage API). If all linked accounts are Bedrock, fall back to default account behavior.

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add services/proxy/src/services/account-pool-service.ts
git commit -m "feat(proxy): add AccountPoolService with OAuth usage-based switching

Implements sticky least-loaded account selection using real utilization
data from Anthropic OAuth usage API. 60-second cache per account.
Checks both 5h and 7d windows, switches when either exceeds threshold."
```

---

### Task 5: Integrate into AuthenticationService

**Files:**

- Modify: `services/proxy/src/services/AuthenticationService.ts`

**Step 1: Update authenticate() method**

1. Import `AccountPoolService` and `AccountPoolExhaustedError`
2. Create `AccountPoolService` in constructor (it needs `this.pool`)
3. Replace the Priority 2 block (lines 61-72) to delegate to pool service

Replace lines 61-72:

```typescript
    // Priority 2: Use project's default account
    const credentials = await getProjectCredentials(this.pool, projectId)
    ...
    return this.buildAuthResult(credentials[0], context)
```

With:

```typescript
// Priority 2: Account pool or default account
try {
  const selection = await this.accountPoolService.selectAccount(projectId)

  if (selection.fromPool) {
    logger.info('Account selected from pool', {
      requestId: context.requestId,
      projectId,
      metadata: {
        accountId: selection.credential.account_id,
        maxUtilization: Math.round(selection.maxUtilization * 100),
      },
    })
  }

  return this.buildAuthResult(selection.credential, context)
} catch (error) {
  if (error instanceof AccountPoolExhaustedError) {
    throw error
  }
  throw new AuthenticationError('No default account configured for this project', {
    requestId: context.requestId,
    projectId,
    hint: 'Set a default account for this project via the dashboard',
  })
}
```

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add services/proxy/src/services/AuthenticationService.ts
git commit -m "feat(proxy): integrate AccountPoolService into authentication flow

Delegates account selection to AccountPoolService for projects with 2+
linked accounts. Single-account projects retain default behavior."
```

---

### Task 6: Handle AccountPoolExhaustedError in Error Responses

**Files:**

- Modify: `services/proxy/src/services/ProxyService.ts` (error handling in handleRequest)

**Step 1: Add 429 error handling**

Find the try/catch around `this.authService.authenticate(context)` in `handleRequest()` (around line 175). Add handling for `AccountPoolExhaustedError`:

```typescript
import { AccountPoolExhaustedError } from './account-pool-service'

// In the catch block:
if (error instanceof AccountPoolExhaustedError) {
  return c.json(
    {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: error.message,
      },
    },
    429
  )
}
```

The exact integration depends on the error handling structure. The error may need to be caught at the controller level instead if `ProxyService.handleRequest()` throws rather than returns error responses.

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add services/proxy/src/services/ProxyService.ts
git commit -m "feat(proxy): return HTTP 429 when all pool accounts exhausted"
```

---

### Task 7: Write Unit Tests

**Files:**

- Create: `services/proxy/src/services/__tests__/account-pool-service.test.ts`

**Step 1: Write tests using bun:test**

Mock `getProjectLinkedCredentials`, `getProjectCredentials`, and the `fetch` call to Anthropic OAuth API.

Test scenarios:

1. **0-1 linked accounts** — returns default account, `fromPool: false`
2. **2+ accounts, sticky under threshold** — returns sticky, uses cached usage
3. **Sticky over 5h threshold** — switches to least-loaded alternative
4. **Sticky over 7d threshold** — switches even if 5h is fine
5. **All accounts exhausted** — throws `AccountPoolExhaustedError` with `resets_at`
6. **Cache expiry** — after 60s, re-fetches from API
7. **Anthropic API failure** — treats account as over threshold (conservative)
8. **Bedrock accounts skipped** — only Anthropic accounts participate in pool
9. **clearStickyState() / clearUsageCache()** — resets state

**Step 2: Run tests**

Run: `bun test services/proxy/src/services/__tests__/account-pool-service.test.ts`
Expected: All PASS

**Step 3: Commit**

```bash
git add services/proxy/src/services/__tests__/account-pool-service.test.ts
git commit -m "test(proxy): add unit tests for AccountPoolService"
```

---

### Task 8: Update Safe Credential Responses

**Files:**

- Modify: `packages/shared/src/database/queries/credential-queries-internal.ts` (if needed)

**Step 1: Verify threshold field appears in credential API responses**

Since `toSafeAnthropicCredential` and `toSafeBedrockCredential` manually construct objects (not spreading), the `token_limit_threshold` field may need to be explicitly added.

Check both functions and add `token_limit_threshold: credential.token_limit_threshold` if they don't spread.

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit (if changes needed)**

```bash
git add packages/shared/src/database/queries/credential-queries-internal.ts
git commit -m "feat(shared): expose token_limit_threshold in safe credential responses"
```

---

### Task 9: Update Documentation

**Files:**

- Modify: `scripts/db/migrations/README.md`
- Modify: `docs/02-User-Guide/authentication.md`

**Step 1: Add migration 018 to README**

```markdown
### 018-account-pool-threshold.ts

Adds per-account token limit threshold for automatic account pool switching:

- `token_limit_threshold` DECIMAL(3,2) DEFAULT 0.80

When a project has 2+ linked accounts, the proxy automatically switches
to a less-loaded account when either the 5-hour or 7-day utilization
(from Anthropic OAuth API) exceeds this threshold.
```

**Step 2: Document account pool in authentication docs**

Add a section to `docs/02-User-Guide/authentication.md` covering:

- How account pooling works (2+ linked accounts enables it)
- Per-account threshold configuration
- Sticky least-loaded behavior
- 429 response when exhausted

**Step 3: Commit**

```bash
git add scripts/db/migrations/README.md docs/02-User-Guide/authentication.md
git commit -m "docs: document account pool auto-switching feature"
```

---

### Task 10: Final Validation

**Step 1: Run full typecheck**

Run: `bun run typecheck`
Expected: 0 errors

**Step 2: Run all tests**

Run: `bun test`
Expected: All PASS

**Step 3: Verify clean working tree**

Run: `git status`
Expected: No untracked or modified files
