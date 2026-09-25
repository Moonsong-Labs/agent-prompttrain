# Conversation Summaries Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve every `GET /api/conversations` call without explicit dates from a write-maintained `conversation_summaries` table, so page selection and the exact total are index lookups cold or warm, behind `CONVERSATION_SUMMARIES_ENABLED` (default off).

**Architecture:** Migration 027 adds one row per (conversation, project) with first/last activity and the accounts used. `StorageWriter.storeRequest` upserts it after every stored request with order-independent merge rules shared (one SQL constant) with a chunked backfill/reconcile script. `listConversations` gains a flag-gated path that resolves the caller's accessible projects, selects de-duplicated page IDs and an exact `COUNT(DISTINCT)` from the table (account-filtered pages keep the request-level selection) and keeps the existing details query; a read-only verify script checks parity before rollout.

**Tech Stack:** Bun 1.3, TypeScript, Hono, node-postgres (`pg`), PostgreSQL 16 (Aurora in production), `bun:test`, Playwright.

**Spec:** docs/superpowers/specs/2026-09-25-conversation-summaries-design.md

## Global Constraints

- Branch `perf/conversation-summaries` (HEAD 62daccf on top of origin/main 60efff0, which contains #213). This plan file is committed by the controller, not by any task.
- The repository `.env` holds the PRODUCTION `DATABASE_URL` and Bun auto-loads it; `env -u DATABASE_URL` does NOT protect. Every Bun command is written as `bun --no-env-file …` (direct `bun <file>` / `bun test <paths>`) or with the explicit prefix `DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST=` (every `bun run …`, every `bunx …`, and `git commit`, whose Husky hook runs `bunx lint-staged`).
- Local database work uses the Docker container `perf03-pg`: `postgresql://postgres:postgres@localhost:55432/perf03_test` for integration suites; `perf03_e2e_test` is dropped and recreated for every E2E run.
- Never run `bun run docker:validate` or `docker compose`. No production access in any task; the spec's rollout steps (migration, deploy, backfill, verify, flag) are human-approved and outside this plan.
- Stage explicit paths only (never `git add -A` / `git add .`); the working tree holds unrelated untracked files (`.agents/`, `output*.json`, `sync-info.json`, …) that must stay unstaged.
- Lint stays at 0 errors and ≤ 245 warnings (baseline 2026-09-25: dashboard 105 + proxy 140), counted with `DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run lint 2>&1 | grep -oE '[0-9]+ errors, [0-9]+ warnings' | awk '{e+=$1; w+=$3} END {print e" errors, "w" warnings"}'`.
- Files contain Unicode whitespace only as `\uXXXX` escapes: `grep -nP '[\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]' <files>` must print nothing.
- Public repository: no security findings in code comments, docs or commit messages.
- Conventional Commits, each message ending with the trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; `kebab-case` file names, `camelCase` code, `snake_case` columns.
- Per-task gates: `bun run typecheck`, the lint count, `prettier --check` and the invisible-character grep on the task's files, and the task's tests; `test:ci` from Task 2 on; the DB suites from Task 5 on; E2E in Tasks 6 and 9.
- Migration `scripts/db/migrations/027-add-conversation-summaries.ts`: idempotent (`IF NOT EXISTS`), `SET LOCAL lock_timeout = '5s'`, `up`/`down`, same pattern as migration 026.
- Table: `conversation_id UUID NOT NULL`, `project_id VARCHAR(255) NOT NULL`, `first_activity_at TIMESTAMPTZ NOT NULL`, `last_activity_at TIMESTAMPTZ NOT NULL`, `account_ids TEXT[] NOT NULL DEFAULT '{}'`, `PRIMARY KEY (conversation_id, project_id)`.
- Indexes: `idx_conversation_summaries_last_activity ON conversation_summaries (last_activity_at DESC, conversation_id DESC)`, `idx_conversation_summaries_project_last_activity ON conversation_summaries (project_id, last_activity_at DESC, conversation_id DESC)`, `idx_conversation_summaries_account_ids ON conversation_summaries USING GIN (account_ids)`.
- Merge rules (one constant, used by the writer and the backfill): `first_activity_at = LEAST(cs.first_activity_at, EXCLUDED.first_activity_at)`, `last_activity_at = GREATEST(cs.last_activity_at, EXCLUDED.last_activity_at)`, `account_ids = CASE WHEN EXCLUDED.account_ids <@ cs.account_ids THEN cs.account_ids ELSE ARRAY(SELECT DISTINCT unnest(cs.account_ids || EXCLUDED.account_ids)) END`, plus a `WHERE` guard that skips updates changing nothing.
- Writer: after the `api_requests` INSERT stored the row (including the 22P02/22P05 retry and the pre-026 fallback; `rowCount > 0`) and only when `request.conversationId` is set, one separate awaited upsert `VALUES ($1, $2, $3, $3, $4)` with `$3` = the request's own `timestamp` and `$4` = `{accountId}` or `{}`; errors caught and logged; a missing table is detected once per writer with one loud error (same pattern as `hasSummaryColumns`).
- Flag `CONVERSATION_SUMMARIES_ENABLED`, read per call as `process.env.CONVERSATION_SUMMARIES_ENABLED === 'true'`, default off; used only when the request has no `dateFrom`/`dateTo`.
- Flag off and explicit `dateFrom`/`dateTo` behave exactly as #213: `services/proxy/tests/conversation-list.test.ts`, `services/proxy/tests/storage-writer-summary.test.ts` and `tests/integration/conversation-list.db.test.ts` stay unchanged and passing.
- Page IDs: `ORDER BY last_activity_at DESC, conversation_id DESC LIMIT $offset + $limit + 32`, de-duplicated by `conversation_id` keeping the first (newest) occurrence, re-scanned with a doubled limit while fewer than `offset + limit` distinct IDs remain and the scan returned its full limit, sliced `[offset, offset + limit)`. Total: `COUNT(DISTINCT conversation_id)` over the table with the same filters.
- With `accountId`, page IDs keep #213's request-level selection (a row's `last_activity_at` spans every account, the reference orders by the filtered account's own activity); the total still comes from the table.
- The response shape, the 15 s route response cache and `conversationListCacheKey` are unchanged (no edit to `services/proxy/src/routes/api.ts`).
- Backfill `scripts/db/backfill-conversation-summaries.ts`: chunks default to 7 days walking the whole history (or `--since <ts>`); dry-run by default (reports chunk counts), `--execute` to write; `statement_timeout 120s`, `lock_timeout 5s`, `application_name = backfill-conversation-summaries`; refuses `--execute` on a read-only session; masked DB host; progress per chunk; package script `db:backfill:conversation-summaries`.
- Verify `scripts/db/verify-conversation-summaries.ts`: read-only (sets its own read-only session), prints ids/counts only, exit 1 on mismatch.
- ADR `docs/04-Architecture/ADRs/adr-039-conversation-summaries-table.md` (Accepted, 2026-09-25); ADR-038 status "Superseded by ADR-039". Docs written before Task 8 mention "ADR-039" as plain text.

## Review Focus

1. **Multi-account conversations under an `accountId` filter** (8.6 % of production conversations): the row's `last_activity_at` covers every account while the reference orders by the filtered account's own last request → pinned by Task 4 "keeps the request-level page selection for accountId and counts from the table" and Task 5 "orders accountId pages by that account's own activity".
2. **A principal with no accessible project, or a `projectId` outside them**: an empty project list must never widen to "no restriction" → pinned by Task 4 "returns nothing when no project is accessible" and Task 5 case "non-member with a private projectId".
3. **A cross-project conversation whose newest request is in a project the viewer cannot see**: it must sort by its accessible activity only and show only accessible details → pinned by Task 5 "orders a cross-project conversation by its accessible activity only".
4. **Requests written or re-keyed outside `StorageWriter`** (SQL seeds, `copy-conversation.ts`, `rebuild-conversations.ts`): the table silently misses or keeps conversations → pinned by Task 6 Step 2 (flag on without the backfill fails Journey 3, passes after) and Task 7 "reports a stale row, a missing row and the page they disturb".
5. **The backfill running while the proxy writes the same conversations, and reconcile re-runs over converged rows**: interleaved upserts must converge and a re-run must rewrite nothing → pinned by Task 5 "converges when the backfill runs concurrently with live writes" and "a backfill after live writes changes nothing".

---

### Task 1: Migration 027 and schema docs

**Files:**

- Create: `scripts/db/migrations/027-add-conversation-summaries.ts`
- Modify: `docs/03-Operations/database.md:88` (table section before `## Indexes`) and `:125` (index list before `## Key Features`)
- Modify: `scripts/db/migrations/README.md:237` (entry before `## Future Migrations`)
- Test: schema check against `perf03_test` (psql); idempotency is re-tested in Task 5

**Interfaces:**

- Consumes: nothing.
- Produces: table `conversation_summaries` with the three indexes on `perf03_test`; `up(pool: Pool): Promise<void>` and `down(pool: Pool): Promise<void>` exported from the migration (CLI: `… 027-add-conversation-summaries.ts up|down`).

- [ ] **Step 1: Write the failing schema check**

The check prints the table's columns and indexes:

```bash
docker exec perf03-pg psql -U postgres -d perf03_test -Atc "
SELECT string_agg(column_name || ' ' || data_type || ' ' || is_nullable || ' ' || COALESCE(column_default, '-'), ', ' ORDER BY ordinal_position)
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'conversation_summaries'"
docker exec perf03-pg psql -U postgres -d perf03_test -Atc "
SELECT indexname || ': ' || regexp_replace(indexdef, '^.* USING ', '')
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'conversation_summaries'
ORDER BY indexname"
```

- [ ] **Step 2: Run it to verify it fails**

Run the two commands of Step 1.

Expected: the first prints an empty line and the second prints nothing (the table does not exist).

- [ ] **Step 3: Write the migration and the docs**

Create `scripts/db/migrations/027-add-conversation-summaries.ts`:

```ts
#!/usr/bin/env bun

/**
 * Migration: Add the conversation_summaries table (ADR-039)
 *
 * One row per conversation and project with its first and last activity and the accounts used.
 * The proxy upserts it for every stored request and
 * scripts/db/backfill-conversation-summaries.ts fills it from history, so GET /api/conversations
 * can select pages and count totals from it when CONVERSATION_SUMMARIES_ENABLED=true.
 * Created empty, so it is effectively instant.
 */

import { Pool } from 'pg'

const EXPECTED_INDEXES = [
  'conversation_summaries_pkey',
  'idx_conversation_summaries_account_ids',
  'idx_conversation_summaries_last_activity',
  'idx_conversation_summaries_project_last_activity',
]

async function up(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    // Never queue behind long-running queries
    await client.query("SET LOCAL lock_timeout = '5s'")

    console.log('Creating conversation_summaries...')

    await client.query(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        conversation_id   UUID         NOT NULL,
        project_id        VARCHAR(255) NOT NULL,
        first_activity_at TIMESTAMPTZ  NOT NULL,
        last_activity_at  TIMESTAMPTZ  NOT NULL,
        account_ids       TEXT[]       NOT NULL DEFAULT '{}',
        PRIMARY KEY (conversation_id, project_id)
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_conversation_summaries_last_activity
        ON conversation_summaries (last_activity_at DESC, conversation_id DESC)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_conversation_summaries_project_last_activity
        ON conversation_summaries (project_id, last_activity_at DESC, conversation_id DESC)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_conversation_summaries_account_ids
        ON conversation_summaries USING GIN (account_ids)
    `)
    console.log('✓ Created table and indexes')

    const result = await client.query(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'conversation_summaries'
         AND indexname = ANY($1)`,
      [EXPECTED_INDEXES]
    )

    if (result.rows.length !== EXPECTED_INDEXES.length) {
      throw new Error(
        'Verification failed: conversation_summaries or one of its indexes is missing'
      )
    }

    console.log('✓ Verified table and indexes exist')

    await client.query('COMMIT')
    console.log('✅ conversation_summaries created successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to create conversation_summaries:', error)
    throw error
  } finally {
    client.release()
  }
}

async function down(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout = '5s'")

    console.log('Dropping conversation_summaries...')

    await client.query('DROP TABLE IF EXISTS conversation_summaries')

    await client.query('COMMIT')
    console.log('✅ conversation_summaries dropped successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to drop conversation_summaries:', error)
    throw error
  } finally {
    client.release()
  }
}

// Main execution
async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })

  try {
    const action = process.argv[2] || 'up'

    if (action === 'up') {
      await up(pool)
    } else if (action === 'down') {
      await down(pool)
    } else {
      console.error(`❌ Unknown action: ${action}. Use 'up' or 'down'`)
      process.exit(1)
    }
  } catch (error) {
    console.error('❌ Migration failed:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

// Run if executed directly
if (import.meta.main) {
  main()
}

export { up, down }
```

In `docs/03-Operations/database.md`, insert before `## Indexes` (line 89):

```markdown
### conversation_summaries

One row per conversation and project (migration 027, ADR-039). The proxy upserts it for every
stored request with a conversation, and `scripts/db/backfill-conversation-summaries.ts` fills it
from history. `GET /api/conversations` selects pages and counts totals from it when
`CONVERSATION_SUMMARIES_ENABLED=true`.

| Column            | Type         | Description                                                      |
| ----------------- | ------------ | ---------------------------------------------------------------- |
| conversation_id   | UUID         | Conversation (primary key with `project_id`)                     |
| project_id        | VARCHAR(255) | Project slug, as in `api_requests.project_id` (no foreign key)   |
| first_activity_at | TIMESTAMPTZ  | Earliest request `timestamp` of the conversation in this project |
| last_activity_at  | TIMESTAMPTZ  | Latest request `timestamp` of the conversation in this project   |
| account_ids       | TEXT[]       | Accounts used by those requests (default `'{}'`)                 |
```

In the same file, insert before `## Key Features` (after the `### Conversation Analysis Indexes` list):

```markdown
### Conversation Summary Indexes

- `idx_conversation_summaries_last_activity` - Newest-first page selection
- `idx_conversation_summaries_project_last_activity` - Newest-first page selection within a project
- `idx_conversation_summaries_account_ids` - GIN index for account filters
```

In `scripts/db/migrations/README.md`, insert before `## Future Migrations` (line 239):

```markdown
### 027-add-conversation-summaries.ts

Creates `conversation_summaries`, one row per conversation and project with its first and last
activity and the accounts used, so `GET /api/conversations` can select pages and count totals
without scanning `api_requests` (ADR-039). Idempotent (`IF NOT EXISTS`), sets
`lock_timeout = '5s'` and is created empty, so it is effectively instant.

Apply it before deploying the proxy that maintains the table (a proxy started without it stores
requests normally and logs one error until the migration is applied and the proxy restarted),
then fill history with `bun run db:backfill:conversation-summaries --execute` (see
[scripts/README.md](../../README.md)) and only then set `CONVERSATION_SUMMARIES_ENABLED=true`.
```

- [ ] **Step 4: Apply up, up, down, up and verify**

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test bun --no-env-file scripts/db/migrations/027-add-conversation-summaries.ts up
DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test bun --no-env-file scripts/db/migrations/027-add-conversation-summaries.ts up
```

Expected: both print `✅ conversation_summaries created successfully` and exit 0. Then run the two Step 1 commands. Expected:

```
conversation_id uuid NO -, project_id character varying NO -, first_activity_at timestamp with time zone NO -, last_activity_at timestamp with time zone NO -, account_ids ARRAY NO '{}'::text[]
conversation_summaries_pkey: btree (conversation_id, project_id)
idx_conversation_summaries_account_ids: gin (account_ids)
idx_conversation_summaries_last_activity: btree (last_activity_at DESC, conversation_id DESC)
idx_conversation_summaries_project_last_activity: btree (project_id, last_activity_at DESC, conversation_id DESC)
```

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test bun --no-env-file scripts/db/migrations/027-add-conversation-summaries.ts down
```

Expected: `✅ conversation_summaries dropped successfully`; the Step 1 commands print an empty line and nothing again.

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test bun --no-env-file scripts/db/migrations/027-add-conversation-summaries.ts up
```

Expected: created again; the Step 1 commands print the five lines above. Leave it applied (Tasks 2–7 use it).

Gates:

```bash
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run typecheck
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bunx prettier --check scripts/db/migrations/027-add-conversation-summaries.ts scripts/db/migrations/README.md docs/03-Operations/database.md
grep -nP '[\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]' scripts/db/migrations/027-add-conversation-summaries.ts scripts/db/migrations/README.md docs/03-Operations/database.md
```

Expected: typecheck exit 0; prettier `All matched files use Prettier code style!` (run `bunx prettier --write` on the same files with the same prefix if not, then re-check); grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add scripts/db/migrations/027-add-conversation-summaries.ts scripts/db/migrations/README.md docs/03-Operations/database.md
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= git commit \
  -m "feat(db): add conversation_summaries table (migration 027)" \
  -m "One row per conversation and project with first/last activity and accounts, indexed for newest-first page selection (ADR-039)." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Writer upsert with table-missing detection

**Files:**

- Create: `services/proxy/src/storage/conversation-summaries.ts`
- Modify: `services/proxy/src/storage/writer.ts:7` (import), `:118` (field), `:205-228` (INSERT block), `:238` (new private methods after `storeRequest`)
- Test: `services/proxy/tests/storage-writer-conversation-summary.test.ts`

**Interfaces:**

- Consumes: table `conversation_summaries` (Task 1).
- Produces (from `services/proxy/src/storage/conversation-summaries.ts`):
  - `CONVERSATION_SUMMARY_MERGE_SQL: string` — the `ON CONFLICT (conversation_id, project_id) DO UPDATE … WHERE …` clause; the target table must be aliased `cs`.
  - `UPSERT_CONVERSATION_SUMMARY_SQL: string` — parameters `$1` conversation_id, `$2` project_id, `$3` request timestamp, `$4` `text[]` of accounts.
  - `StorageWriter.storeRequest(request)` now also upserts the summary (private helpers `insertRequest(request, values): Promise<number>`, `upsertConversationSummary(request, conversationId): Promise<void>`, `hasSummaryTable(): Promise<boolean>`).

- [ ] **Step 1: Write the failing test**

Create `services/proxy/tests/storage-writer-conversation-summary.test.ts`:

```ts
import { describe, it, expect, mock, spyOn, afterEach } from 'bun:test'
import { StorageWriter } from '../src/storage/writer'
import { logger } from '../src/middleware/logger'

const SUMMARY_COLUMNS = ['last_message_summary', 'user_text_message_count']

interface PoolOptions {
  columns?: string[]
  insertFailures?: unknown[]
  /** rowCount of a successful request INSERT (0 when the request id is already stored) */
  insertRowCount?: number
  tableExists?: boolean
  tableCheckFailures?: number
  upsertFailures?: unknown[]
}

function createPool(options: PoolOptions = {}) {
  const columns = options.columns ?? SUMMARY_COLUMNS
  const insertFailures = [...(options.insertFailures ?? [])]
  const upsertFailures = [...(options.upsertFailures ?? [])]
  let tableCheckFailures = options.tableCheckFailures ?? 0
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const pool = {
    query: mock(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('information_schema.columns')) {
        return { rows: columns.map(column_name => ({ column_name })), rowCount: columns.length }
      }
      if (sql.includes('information_schema.tables')) {
        if (tableCheckFailures > 0) {
          tableCheckFailures--
          throw new Error('connection reset')
        }
        const exists = options.tableExists ?? true
        return {
          rows: exists ? [{ table_name: 'conversation_summaries' }] : [],
          rowCount: exists ? 1 : 0,
        }
      }
      if (sql.includes('INSERT INTO api_requests')) {
        if (insertFailures.length > 0) {
          throw insertFailures.shift()
        }
        return { rows: [], rowCount: options.insertRowCount ?? 1 }
      }
      if (sql.includes('INSERT INTO conversation_summaries')) {
        if (upsertFailures.length > 0) {
          throw upsertFailures.shift()
        }
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }),
  }
  const matching = (fragment: string) => calls.filter(call => call.sql.includes(fragment))
  return {
    writer: new StorageWriter(pool as any),
    calls,
    inserts: () => matching('INSERT INTO api_requests'),
    upserts: () => matching('INSERT INTO conversation_summaries'),
    tableChecks: () => matching('information_schema.tables'),
  }
}

const baseRequest = {
  requestId: '11111111-1111-4111-8111-111111111111',
  projectId: 'project-test',
  accountId: 'account-1',
  timestamp: new Date('2026-09-25T00:00:00Z'),
  method: 'POST',
  path: '/v1/messages',
  headers: {},
  apiKey: '',
  model: 'claude-test',
  conversationId: '22222222-2222-4222-8222-222222222222',
  parentMessageHash: 'parent-hash',
  body: { messages: [{ role: 'user', content: 'hello' }] },
}
const secondRequest = { ...baseRequest, requestId: '33333333-3333-4333-8333-333333333333' }

afterEach(() => {
  mock.restore()
})

/**
 * Silence a logger method and count its calls from now on. Other test files replace logger
 * methods with long-lived mocks, so clear any calls recorded before this test.
 */
function silence(method: 'warn' | 'error') {
  const spy = spyOn(logger, method).mockImplementation(() => {})
  spy.mockClear()
  return spy
}

describe('StorageWriter conversation summaries (migration 027)', () => {
  it('upserts the summary after the request INSERT with the merge rules', async () => {
    const { writer, calls, upserts } = createPool()

    await writer.storeRequest(baseRequest)

    const insertAt = calls.findIndex(call => call.sql.includes('INSERT INTO api_requests'))
    const upsertAt = calls.findIndex(call =>
      call.sql.includes('INSERT INTO conversation_summaries')
    )
    expect(insertAt).toBeGreaterThanOrEqual(0)
    expect(upsertAt).toBeGreaterThan(insertAt)
    expect(upserts()).toHaveLength(1)
    const [upsert] = upserts()
    expect(upsert.sql).toContain('VALUES ($1, $2, $3, $3, $4)')
    expect(upsert.sql).toContain('ON CONFLICT (conversation_id, project_id) DO UPDATE')
    expect(upsert.sql).toContain('LEAST(cs.first_activity_at, EXCLUDED.first_activity_at)')
    expect(upsert.sql).toContain('GREATEST(cs.last_activity_at, EXCLUDED.last_activity_at)')
    expect(upsert.values).toEqual([
      baseRequest.conversationId,
      baseRequest.projectId,
      baseRequest.timestamp,
      ['account-1'],
    ])
  })

  it('records an empty account list when the request has no account', async () => {
    const { writer, upserts } = createPool()

    await writer.storeRequest({ ...baseRequest, accountId: undefined })

    expect(upserts()[0].values![3]).toEqual([])
  })

  it('skips the summary for a request without a conversation', async () => {
    const { writer, inserts, upserts, tableChecks } = createPool()

    await writer.storeRequest({ ...baseRequest, conversationId: undefined })

    expect(inserts()).toHaveLength(1)
    expect(upserts()).toHaveLength(0)
    expect(tableChecks()).toHaveLength(0)
  })

  it('does not upsert when the request INSERT fails', async () => {
    const error = silence('error')
    const { writer, upserts } = createPool({ insertFailures: [{ code: '23503' }] })

    await writer.storeRequest(baseRequest)

    expect(upserts()).toHaveLength(0)
    expect(error).toHaveBeenCalledWith('Failed to store request', expect.anything())
  })

  it('upserts once after the INSERT is retried without a summary', async () => {
    silence('warn')
    const { writer, inserts, upserts } = createPool({ insertFailures: [{ code: '22P02' }] })

    await writer.storeRequest(baseRequest)

    expect(inserts()).toHaveLength(2)
    expect(upserts()).toHaveLength(1)
  })

  it('upserts after the pre-026 INSERT', async () => {
    silence('error')
    const { writer, inserts, upserts } = createPool({ columns: [] })

    await writer.storeRequest(baseRequest)

    expect(inserts()[0].values).toHaveLength(21)
    expect(upserts()).toHaveLength(1)
  })

  it('does not upsert when the INSERT stored nothing (request id already stored)', async () => {
    const { writer, upserts, tableChecks } = createPool({ insertRowCount: 0 })

    await writer.storeRequest(baseRequest)

    expect(upserts()).toHaveLength(0)
    expect(tableChecks()).toHaveLength(0)
  })

  it('logs a failed upsert without failing the stored request', async () => {
    const error = silence('error')
    const { writer, inserts, upserts } = createPool({
      upsertFailures: [new Error('deadlock detected')],
    })

    await expect(writer.storeRequest(baseRequest)).resolves.toBeUndefined()
    await writer.storeRequest(secondRequest)

    expect(inserts()).toHaveLength(2)
    // A failed upsert does not disable the next one
    expect(upserts()).toHaveLength(2)
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(
      'Failed to update the conversation summary',
      expect.anything()
    )
    expect(error).not.toHaveBeenCalledWith('Failed to store request', expect.anything())
  })

  it('skips the upsert and logs one error while the table is missing', async () => {
    const error = silence('error')
    const { writer, inserts, upserts, tableChecks } = createPool({ tableExists: false })

    await writer.storeRequest(baseRequest)
    await writer.storeRequest(secondRequest)

    expect(inserts()).toHaveLength(2)
    expect(tableChecks()).toHaveLength(1)
    expect(upserts()).toHaveLength(0)
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0][0]).toContain('027')
  })

  it('checks for the table again after a failed check', async () => {
    const warn = silence('warn')
    const error = silence('error')
    const { writer, upserts, tableChecks } = createPool({ tableCheckFailures: 1 })

    await writer.storeRequest(baseRequest)
    await writer.storeRequest(secondRequest)

    expect(tableChecks()).toHaveLength(2)
    expect(upserts()).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(error).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun --no-env-file test services/proxy/tests/storage-writer-conversation-summary.test.ts
```

Expected: FAIL — every test that expects an upsert or a table check fails (e.g. `expect(received).toHaveLength(1)` … `Received length: 0` in "upserts the summary after the request INSERT with the merge rules", and `tableChecks()` length 0 in "skips the upsert and logs one error while the table is missing").

- [ ] **Step 3: Write minimal implementation**

Create `services/proxy/src/storage/conversation-summaries.ts`:

```ts
/**
 * SQL shared by the proxy's per-request upsert (StorageWriter) and
 * scripts/db/backfill-conversation-summaries.ts, so live writes, retries and the backfill merge
 * identically in any order (ADR-039).
 */

/**
 * Keeps the earliest first activity, the latest last activity and the union of accounts. The
 * target table must be aliased `cs`. Rows that would not change are not rewritten, so re-runs
 * and duplicate activity leave no dead tuples.
 */
export const CONVERSATION_SUMMARY_MERGE_SQL = `
  ON CONFLICT (conversation_id, project_id) DO UPDATE SET
    first_activity_at = LEAST(cs.first_activity_at, EXCLUDED.first_activity_at),
    last_activity_at = GREATEST(cs.last_activity_at, EXCLUDED.last_activity_at),
    account_ids = CASE
      WHEN EXCLUDED.account_ids <@ cs.account_ids THEN cs.account_ids
      ELSE ARRAY(SELECT DISTINCT unnest(cs.account_ids || EXCLUDED.account_ids))
    END
  WHERE EXCLUDED.first_activity_at < cs.first_activity_at
    OR EXCLUDED.last_activity_at > cs.last_activity_at
    OR NOT (EXCLUDED.account_ids <@ cs.account_ids)`

/** $1 conversation_id, $2 project_id, $3 request timestamp, $4 accounts ({accountId} or {}) */
export const UPSERT_CONVERSATION_SUMMARY_SQL = `
  INSERT INTO conversation_summaries AS cs
    (conversation_id, project_id, first_activity_at, last_activity_at, account_ids)
  VALUES ($1, $2, $3, $3, $4)
  ${CONVERSATION_SUMMARY_MERGE_SQL}`
```

In `services/proxy/src/storage/writer.ts`:

1. After line 7 (`import { buildSummaryColumns } from './summary-columns.js'`) add:

```ts
import { UPSERT_CONVERSATION_SUMMARY_SQL } from './conversation-summaries.js'
```

2. After line 118 (`private summaryColumnsCheck?: Promise<boolean>`) add:

```ts
  private summaryTableCheck?: Promise<boolean>
```

3. Replace lines 205–228 — everything between the closing `]` of the `values` array and the outer `} catch (error) {` (from `if (!(await this.hasSummaryColumns())) {` through the closing `}` of the retry `catch`) — so that the block reads as follows (the first and last lines are the existing context lines, unchanged):

```ts
      ]

      const stored = await this.insertRequest(request, values)

      // A request id that is already stored adds no activity
      if (stored > 0 && request.conversationId) {
        await this.upsertConversationSummary(request, request.conversationId)
      }
    } catch (error) {
```

4. After the closing `}` of `storeRequest` (line 237 before the edit, followed by the `hasSummaryColumns` doc comment), insert:

```ts
  /**
   * Insert the request row, with the migration 026 summary columns when they exist, and return
   * how many rows were stored (0 when the request id is already stored).
   */
  private async insertRequest(request: StorageRequest, values: unknown[]): Promise<number> {
    if (!(await this.hasSummaryColumns())) {
      const result = await this.pool.query(INSERT_REQUEST_PRE_026_SQL, values)
      return result.rowCount ?? 0
    }

    const summaryColumns = buildSummaryColumns(request.body)
    const summaryValues = [summaryColumns.lastMessageSummary, summaryColumns.userTextMessageCount]

    try {
      const result = await this.pool.query(INSERT_REQUEST_SQL, [...values, ...summaryValues])
      return result.rowCount ?? 0
    } catch (error) {
      if (summaryValues.every(value => value === null) || !isInvalidTextError(error)) {
        throw error
      }
      // A summary must never cost the request row (ADR-037): store it once more without one
      logger.warn('Request summary rejected by the database, storing the request without it', {
        requestId: request.requestId,
        metadata: {
          code: (error as { code?: unknown }).code,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      const result = await this.pool.query(INSERT_REQUEST_SQL, [...values, null, null])
      return result.rowCount ?? 0
    }
  }

  /**
   * Record the request's activity in conversation_summaries (ADR-039). Runs after the request
   * row is stored and never throws, so it can neither fail nor lose the request.
   */
  private async upsertConversationSummary(
    request: StorageRequest,
    conversationId: string
  ): Promise<void> {
    try {
      if (!(await this.hasSummaryTable())) {
        return
      }
      await this.pool.query(UPSERT_CONVERSATION_SUMMARY_SQL, [
        conversationId,
        request.projectId,
        request.timestamp,
        request.accountId ? [request.accountId] : [],
      ])
    } catch (error) {
      logger.error('Failed to update the conversation summary', {
        requestId: request.requestId,
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  /**
   * Whether conversation_summaries exists (migration 027), checked once per writer. Without it
   * requests are stored as usual and no summary is maintained.
   */
  private hasSummaryTable(): Promise<boolean> {
    if (!this.summaryTableCheck) {
      this.summaryTableCheck = this.checkSummaryTable()
    }
    return this.summaryTableCheck
  }

  private async checkSummaryTable(): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name = 'conversation_summaries'`
      )
      if (result.rows.length === 0) {
        logger.error(
          'conversation_summaries is missing: run migration 027 (scripts/db/migrations/027-add-conversation-summaries.ts), then restart the proxy. Until then conversation summaries are not maintained.'
        )
        return false
      }
      return true
    } catch (error) {
      // Check again on the next request; a skipped summary is repaired by the backfill
      this.summaryTableCheck = undefined
      logger.warn('Could not check for the conversation_summaries table', {
        metadata: { error: error instanceof Error ? error.message : String(error) },
      })
      return false
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun --no-env-file test services/proxy/tests/storage-writer-conversation-summary.test.ts services/proxy/tests/storage-writer-summary.test.ts
```

Expected: PASS — 10 new tests and every existing `storage-writer-summary` test, `0 fail` (the existing mock returns `rowCount: 0` for its INSERTs, so it never reaches the upsert and its assertions are unchanged).

Gates:

```bash
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run typecheck
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run lint 2>&1 | grep -oE '[0-9]+ errors, [0-9]+ warnings' | awk '{e+=$1; w+=$3} END {print e" errors, "w" warnings"}'
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run test:ci
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bunx prettier --check services/proxy/src/storage/conversation-summaries.ts services/proxy/src/storage/writer.ts services/proxy/tests/storage-writer-conversation-summary.test.ts
grep -nP '[\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]' services/proxy/src/storage/conversation-summaries.ts services/proxy/src/storage/writer.ts services/proxy/tests/storage-writer-conversation-summary.test.ts
```

Expected: typecheck exit 0; `0 errors, 245 warnings` or fewer; `test:ci` passes; prettier clean; grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add services/proxy/src/storage/conversation-summaries.ts services/proxy/src/storage/writer.ts services/proxy/tests/storage-writer-conversation-summary.test.ts
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= git commit \
  -m "feat(proxy): maintain conversation summaries on every stored request" \
  -m "After a request row is stored, upsert its conversation/project activity with order-independent merge rules; errors are logged and a missing table is reported once (ADR-039)." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Backfill and reconcile script

**Files:**

- Create: `scripts/db/backfill-conversation-summaries.ts`
- Modify: `package.json:71` (script after `db:backfill:last-message-summary`)
- Modify: `scripts/README.md:100` (section before `### backup-database.ts`)
- Test: `scripts/db/__tests__/backfill-conversation-summaries.test.ts`

**Interfaces:**

- Consumes: `CONVERSATION_SUMMARY_MERGE_SQL` (Task 2).
- Produces (from `scripts/db/backfill-conversation-summaries.ts`):
  - `interface SummariesBackfillOptions { since?: string; chunkDays: number; execute: boolean }`
  - `interface BackfillChunk { from: Date; to: Date }`
  - `interface SummariesBackfillResult { chunks: number; groups: number; changed: number }` (`changed` = rows inserted or updated; 0 in a dry run)
  - `parseSummariesBackfillArgs(argv: string[]): SummariesBackfillOptions`
  - `planBackfillChunks(start: Date, end: Date, chunkDays: number): BackfillChunk[]` — newest first, `[from, to)`
  - `backfillConversationSummaries(pool: Pool, options: SummariesBackfillOptions, log?: (line: string) => void): Promise<SummariesBackfillResult>`
  - package script `db:backfill:conversation-summaries`

- [ ] **Step 1: Write the failing test**

Create `scripts/db/__tests__/backfill-conversation-summaries.test.ts`:

```ts
import { describe, it, expect } from 'bun:test'
import {
  backfillConversationSummaries,
  parseSummariesBackfillArgs,
  planBackfillChunks,
} from '../backfill-conversation-summaries'

const at = (iso: string) => new Date(iso)

describe('parseSummariesBackfillArgs', () => {
  it('defaults to a dry run over the whole history in 7-day chunks', () => {
    expect(parseSummariesBackfillArgs([])).toEqual({
      since: undefined,
      chunkDays: 7,
      execute: false,
    })
  })

  it('parses every flag', () => {
    expect(
      parseSummariesBackfillArgs([
        '--since',
        '2026-09-01T00:00:00Z',
        '--chunk-days',
        '1',
        '--execute',
      ])
    ).toEqual({ since: '2026-09-01T00:00:00.000Z', chunkDays: 1, execute: true })
  })

  it('rejects invalid values', () => {
    expect(() => parseSummariesBackfillArgs(['--since', 'yesterday'])).toThrow('--since')
    expect(() => parseSummariesBackfillArgs(['--since'])).toThrow('--since')
    expect(() => parseSummariesBackfillArgs(['--chunk-days', '0'])).toThrow('--chunk-days')
    expect(() => parseSummariesBackfillArgs(['--chunk-days', '400'])).toThrow('--chunk-days')
    expect(() => parseSummariesBackfillArgs(['--chunk-days', '1.5'])).toThrow('--chunk-days')
    expect(() => parseSummariesBackfillArgs(['--bogus'])).toThrow('Unknown option')
  })
})

describe('planBackfillChunks', () => {
  it('walks newest first in contiguous chunks of at most chunkDays', () => {
    expect(planBackfillChunks(at('2026-09-01T00:00:00Z'), at('2026-09-20T00:00:00Z'), 7)).toEqual([
      { from: at('2026-09-13T00:00:00Z'), to: at('2026-09-20T00:00:00Z') },
      { from: at('2026-09-06T00:00:00Z'), to: at('2026-09-13T00:00:00Z') },
      { from: at('2026-09-01T00:00:00Z'), to: at('2026-09-06T00:00:00Z') },
    ])
  })

  it('covers an exact multiple without an empty chunk', () => {
    const chunks = planBackfillChunks(at('2026-09-06T00:00:00Z'), at('2026-09-20T00:00:00Z'), 7)
    expect(chunks.map(chunk => chunk.from.toISOString())).toEqual([
      '2026-09-13T00:00:00.000Z',
      '2026-09-06T00:00:00.000Z',
    ])
  })

  it('returns one short chunk for a short range', () => {
    expect(
      planBackfillChunks(at('2026-09-01T00:00:00Z'), at('2026-09-01T00:00:00.001Z'), 7)
    ).toEqual([{ from: at('2026-09-01T00:00:00Z'), to: at('2026-09-01T00:00:00.001Z') }])
  })

  it('returns nothing for an empty or inverted range', () => {
    expect(planBackfillChunks(at('2026-09-01T00:00:00Z'), at('2026-09-01T00:00:00Z'), 7)).toEqual(
      []
    )
    expect(planBackfillChunks(at('2026-09-20T00:00:00Z'), at('2026-09-01T00:00:00Z'), 7)).toEqual(
      []
    )
  })
})

function createPool(options: { start?: Date | null; end?: Date | null; readOnly?: boolean } = {}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  let released = false
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      if (sql.startsWith('SHOW transaction_read_only')) {
        return { rows: [{ transaction_read_only: options.readOnly ? 'on' : 'off' }] }
      }
      if (sql.includes('AS history_start')) {
        return {
          rows: [
            {
              history_start:
                options.start === undefined ? at('2026-09-01T00:00:00Z') : options.start,
              history_end: options.end === undefined ? at('2026-09-14T12:00:00Z') : options.end,
            },
          ],
        }
      }
      if (sql.includes('RETURNING 1')) {
        return { rows: [{ groups: 3, changed: 2 }] }
      }
      if (sql.includes('AS groups')) {
        return { rows: [{ groups: 3 }] }
      }
      return { rows: [] }
    },
    release: () => {
      released = true
    },
  }
  return {
    pool: { connect: async () => client } as any,
    calls,
    released: () => released,
    of: (fragment: string) => calls.filter(call => call.sql.includes(fragment)),
  }
}

describe('backfillConversationSummaries', () => {
  const quiet = () => {}

  it('dry run counts each chunk and writes nothing', async () => {
    const { pool, calls, of, released } = createPool()

    const result = await backfillConversationSummaries(
      pool,
      { chunkDays: 7, execute: false },
      quiet
    )

    expect(result).toEqual({ chunks: 2, groups: 6, changed: 0 })
    expect(calls.some(call => /INSERT|UPDATE|DELETE/.test(call.sql))).toBe(false)
    const statements = calls.map(call => call.sql)
    expect(statements).toContain("SET statement_timeout = '120s'")
    expect(statements).toContain("SET lock_timeout = '5s'")
    expect(statements).toContain("SET application_name = 'backfill-conversation-summaries'")
    // The newest request is included: the range ends 1 ms after it
    expect(of('AS groups').map(call => call.values)).toEqual([
      [at('2026-09-07T12:00:00.001Z'), at('2026-09-14T12:00:00.001Z')],
      [at('2026-09-01T00:00:00Z'), at('2026-09-07T12:00:00.001Z')],
    ])
    expect(released()).toBe(true)
  })

  it('executes one merge upsert per chunk', async () => {
    const { pool, of } = createPool()

    const result = await backfillConversationSummaries(pool, { chunkDays: 7, execute: true }, quiet)

    expect(result).toEqual({ chunks: 2, groups: 6, changed: 4 })
    const upserts = of('INSERT INTO conversation_summaries')
    expect(upserts).toHaveLength(2)
    expect(upserts[0].sql).toContain('GROUP BY conversation_id, project_id')
    expect(upserts[0].sql).toContain('ON CONFLICT (conversation_id, project_id) DO UPDATE')
    expect(of('SHOW transaction_read_only')).toHaveLength(1)
  })

  it('refuses --execute on a read-only session', async () => {
    const { pool, of, released } = createPool({ readOnly: true })

    await expect(
      backfillConversationSummaries(pool, { chunkDays: 7, execute: true }, quiet)
    ).rejects.toThrow('read-only')

    expect(of('INSERT')).toHaveLength(0)
    expect(released()).toBe(true)
  })

  it('starts at --since', async () => {
    const { pool, of } = createPool()

    const result = await backfillConversationSummaries(
      pool,
      { since: '2026-09-10T00:00:00.000Z', chunkDays: 7, execute: false },
      quiet
    )

    expect(result.chunks).toBe(1)
    expect(of('AS groups')[0].values).toEqual([
      at('2026-09-10T00:00:00Z'),
      at('2026-09-14T12:00:00.001Z'),
    ])
  })

  it('does nothing without requests in a conversation', async () => {
    const { pool, of } = createPool({ start: null, end: null })

    const result = await backfillConversationSummaries(pool, { chunkDays: 7, execute: true }, quiet)

    expect(result).toEqual({ chunks: 0, groups: 0, changed: 0 })
    expect(of('INSERT')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun --no-env-file test scripts/db/__tests__/backfill-conversation-summaries.test.ts
```

Expected: FAIL — `Cannot find module '../backfill-conversation-summaries'`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/db/backfill-conversation-summaries.ts`:

```ts
#!/usr/bin/env bun

/**
 * Backfill and reconcile conversation_summaries from api_requests (ADR-039).
 *
 * Dry-run by default: counts the (conversation, project) groups of each chunk and writes
 * nothing. Pass --execute to upsert them with the proxy's merge rules (earliest first activity,
 * latest last activity, union of accounts): safe while the proxy is writing and safe to re-run;
 * rows that would not change are not rewritten. Walks the whole history newest first, in chunks
 * of --chunk-days, or only the activity since --since.
 *
 * Usage:
 *   bun run db:backfill:conversation-summaries [--since <ISO timestamp>] [--chunk-days 7]
 *     [--execute]
 */

import { Pool, type PoolClient } from 'pg'
import { CONVERSATION_SUMMARY_MERGE_SQL } from '../../services/proxy/src/storage/conversation-summaries.js'

export interface SummariesBackfillOptions {
  since?: string
  chunkDays: number
  execute: boolean
}

export interface BackfillChunk {
  from: Date
  to: Date
}

export interface SummariesBackfillResult {
  chunks: number
  groups: number
  changed: number
}

const DAY_MS = 24 * 60 * 60 * 1000

export function parseSummariesBackfillArgs(argv: string[]): SummariesBackfillOptions {
  const options: SummariesBackfillOptions = { since: undefined, chunkDays: 7, execute: false }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--since': {
        const value = argv[++i]
        if (!value || Number.isNaN(Date.parse(value))) {
          throw new Error('--since must be an ISO timestamp')
        }
        options.since = new Date(value).toISOString()
        break
      }
      case '--chunk-days': {
        const value = Number(argv[++i])
        if (!Number.isInteger(value) || value < 1 || value > 366) {
          throw new Error('--chunk-days must be an integer between 1 and 366')
        }
        options.chunkDays = value
        break
      }
      case '--execute':
        options.execute = true
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  return options
}

/** Contiguous [from, to) chunks of at most chunkDays covering [start, end), newest first */
export function planBackfillChunks(start: Date, end: Date, chunkDays: number): BackfillChunk[] {
  const chunks: BackfillChunk[] = []
  const step = chunkDays * DAY_MS
  for (let to = end.getTime(); to > start.getTime(); to -= step) {
    chunks.push({ from: new Date(Math.max(to - step, start.getTime())), to: new Date(to) })
  }
  return chunks
}

/** One chunk of api_requests grouped as the table stores it; $1/$2 bound [from, to) */
const CHUNK_GROUPS_SQL = `
  SELECT conversation_id, project_id,
         MIN(timestamp) AS first_activity_at,
         MAX(timestamp) AS last_activity_at,
         COALESCE(ARRAY_AGG(DISTINCT account_id) FILTER (WHERE account_id IS NOT NULL), '{}')
           AS account_ids
  FROM api_requests
  WHERE conversation_id IS NOT NULL
    AND timestamp >= $1
    AND timestamp < $2
  GROUP BY conversation_id, project_id`

const COUNT_CHUNK_SQL = `SELECT COUNT(*)::int AS groups FROM (${CHUNK_GROUPS_SQL}) chunk_groups`

const UPSERT_CHUNK_SQL = `
  WITH grouped AS (${CHUNK_GROUPS_SQL}),
  upserted AS (
    INSERT INTO conversation_summaries AS cs
      (conversation_id, project_id, first_activity_at, last_activity_at, account_ids)
    SELECT conversation_id, project_id, first_activity_at, last_activity_at, account_ids
    FROM grouped
    ${CONVERSATION_SUMMARY_MERGE_SQL}
    RETURNING 1
  )
  SELECT (SELECT COUNT(*) FROM grouped)::int AS groups,
         (SELECT COUNT(*) FROM upserted)::int AS changed`

function maskHost(databaseUrl: string): string {
  const host = new URL(databaseUrl).hostname
  return host.length <= 12 ? host : `${host.slice(0, 6)}…${host.slice(-6)}`
}

async function configureSession(client: PoolClient, execute: boolean): Promise<void> {
  await client.query("SET statement_timeout = '120s'")
  await client.query("SET lock_timeout = '5s'")
  await client.query("SET application_name = 'backfill-conversation-summaries'")

  if (execute) {
    const { rows } = await client.query('SHOW transaction_read_only')
    if (rows[0]?.transaction_read_only === 'on') {
      throw new Error('Refusing --execute: this session is read-only')
    }
  }
}

export async function backfillConversationSummaries(
  pool: Pool,
  options: SummariesBackfillOptions,
  log: (line: string) => void = console.log
): Promise<SummariesBackfillResult> {
  const client = await pool.connect()
  const result: SummariesBackfillResult = { chunks: 0, groups: 0, changed: 0 }

  try {
    await configureSession(client, options.execute)

    const { rows } = await client.query(
      `SELECT MIN(timestamp) AS history_start, MAX(timestamp) AS history_end
       FROM api_requests
       WHERE conversation_id IS NOT NULL`
    )
    const historyStart: Date | null = rows[0]?.history_start ?? null
    const historyEnd: Date | null = rows[0]?.history_end ?? null
    if (!historyStart || !historyEnd) {
      log('No requests with a conversation: nothing to backfill')
      return result
    }

    const since = options.since ? new Date(options.since).getTime() : historyStart.getTime()
    const start = new Date(Math.max(since, historyStart.getTime()))
    // Up to the newest request stored now; later ones are upserted by the proxy itself
    const end = new Date(historyEnd.getTime() + 1)
    const chunks = planBackfillChunks(start, end, options.chunkDays)
    log(
      `${options.execute ? 'EXECUTE' : 'DRY RUN'}: ${chunks.length} chunks of up to ${options.chunkDays} days from ${start.toISOString()} to ${end.toISOString()}, newest first`
    )

    for (const chunk of chunks) {
      const range = `[${chunk.from.toISOString()}, ${chunk.to.toISOString()})`
      if (options.execute) {
        const { rows: upserted } = await client.query(UPSERT_CHUNK_SQL, [chunk.from, chunk.to])
        result.groups += upserted[0].groups
        result.changed += upserted[0].changed
        log(
          `chunk ${result.chunks + 1}/${chunks.length} ${range}: ${upserted[0].groups} groups, ${upserted[0].changed} inserted or changed`
        )
      } else {
        const { rows: counted } = await client.query(COUNT_CHUNK_SQL, [chunk.from, chunk.to])
        result.groups += counted[0].groups
        log(`chunk ${result.chunks + 1}/${chunks.length} ${range}: ${counted[0].groups} groups`)
      }
      result.chunks++
    }

    log(`Done: ${JSON.stringify(result)}`)
    return result
  } finally {
    client.release()
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL environment variable is required')
    process.exit(1)
  }

  let options: SummariesBackfillOptions
  try {
    options = parseSummariesBackfillArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`)
    process.exit(1)
  }

  console.log(`Target database host: ${maskHost(databaseUrl)}`)
  if (!options.execute) {
    console.log('Dry run - no rows will be written. Re-run with --execute to write.')
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  try {
    await backfillConversationSummaries(pool, options)
  } catch (error) {
    console.error('❌ Backfill failed:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

// Run if executed directly
if (import.meta.main) {
  main()
}
```

In `package.json`, after line 71 (`"db:backfill:last-message-summary": …,`) add:

```json
    "db:backfill:conversation-summaries": "bun run scripts/db/backfill-conversation-summaries.ts",
```

In `scripts/README.md`, insert before `### backup-database.ts` (line 101):

````markdown
### backfill-conversation-summaries.ts

Derives `conversation_summaries` (ADR-039) from `api_requests`: one grouped upsert per chunk of
history (7 days by default, newest first) with the proxy's merge rules (earliest first activity,
latest last activity, union of accounts). Safe to run while the proxy is writing and safe to
re-run: rows that would not change are not rewritten. Dry-run by default (reports the groups per
chunk); writes only with `--execute`.

```bash
bun run db:backfill:conversation-summaries                     # dry run, whole history
bun run db:backfill:conversation-summaries --execute           # write, whole history
bun run db:backfill:conversation-summaries --since 2026-09-01T00:00:00Z --execute  # reconcile
```

Run after migration 027 and after deploying the proxy that maintains the table (requests stored
after the run starts are the proxy's to upsert). It only adds and widens rows: after re-keying or
deleting requests outside the proxy (for example with `rebuild-conversations.ts`), turn
`CONVERSATION_SUMMARIES_ENABLED` off, `TRUNCATE conversation_summaries`, re-run with `--execute`
and verify before turning it back on.
````

- [ ] **Step 4: Run test to verify it passes**

```bash
bun --no-env-file test scripts/db/__tests__/backfill-conversation-summaries.test.ts
```

Expected: PASS — 12 tests, `0 fail`.

Then exercise the CLI against the local database (dry run, then execute):

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test bun --no-env-file scripts/db/backfill-conversation-summaries.ts
DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test bun --no-env-file scripts/db/backfill-conversation-summaries.ts --execute
DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test bun --no-env-file scripts/db/backfill-conversation-summaries.ts --execute
docker exec perf03-pg psql -U postgres -d perf03_test -Atc "SELECT (SELECT COUNT(*) FROM conversation_summaries) = (SELECT COUNT(*) FROM (SELECT 1 FROM api_requests WHERE conversation_id IS NOT NULL GROUP BY conversation_id, project_id) g)"
DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test bun --no-env-file scripts/db/backfill-conversation-summaries.ts --chunk-days 0
```

Expected: `Target database host: localhost`, `Dry run - no rows will be written…`, `DRY RUN: N chunks…` and one line per chunk; the first `--execute` ends with `Done: {"chunks":N,"groups":G,"changed":C}` where `C` is the number of rows it inserted (1 on the table Task 1 left empty: `perf03_test` holds the single seeded E2E conversation); the second ends with `"changed":0`; psql prints `t`; `--chunk-days 0` prints `❌ --chunk-days must be an integer between 1 and 366` and exits 1.

Gates:

```bash
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run typecheck
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run test:ci
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bunx prettier --check scripts/db/backfill-conversation-summaries.ts scripts/db/__tests__/backfill-conversation-summaries.test.ts package.json scripts/README.md
grep -nP '[\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]' scripts/db/backfill-conversation-summaries.ts scripts/db/__tests__/backfill-conversation-summaries.test.ts package.json scripts/README.md
```

Expected: typecheck exit 0; `test:ci` passes (lists `backfill-conversation-summaries.test.ts`); prettier clean; grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add scripts/db/backfill-conversation-summaries.ts scripts/db/__tests__/backfill-conversation-summaries.test.ts package.json scripts/README.md
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= git commit \
  -m "feat(db): add conversation summaries backfill and reconcile script" \
  -m "Dry-run by default; --execute upserts one grouped statement per 7-day chunk (or since --since) with the writer's merge rules (ADR-039)." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Flag-gated read path in `listConversations`

**Files:**

- Modify: `services/proxy/src/services/conversation-list.ts:153-167` (options, flag, accessible-projects SQL), `:244-290` (`listConversations`), `:466` (new functions after `countRecentPlusOlder`, before `toConversationListItem`)
- Modify: `docs/06-Reference/environment-vars.md:45` (Feature Flags row)
- Modify: `docs/02-User-Guide/api-reference.md:377` (List Conversations paragraph)
- Test: `services/proxy/tests/conversation-list-summaries.test.ts`

**Interfaces:**

- Consumes: table `conversation_summaries` (Task 1), maintained by Task 2.
- Produces (from `services/proxy/src/services/conversation-list.ts`):
  - `conversationSummariesEnabled(): boolean` — `process.env.CONVERSATION_SUMMARIES_ENABLED === 'true'`, read per call
  - `SUMMARY_SCAN_SLACK = 32`
  - `ListConversationsOptions { olderCountCache?: OlderConversationCountCache; summaries?: boolean }` — `summaries` overrides the flag (used by Task 7)
  - `listConversations(pool, params, principal?, options?)` unchanged signature and result shape.

- [ ] **Step 1: Write the failing test**

Create `services/proxy/tests/conversation-list-summaries.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  conversationSummariesEnabled,
  listConversations,
  OlderConversationCountCache,
  SUMMARY_SCAN_SLACK,
  type ConversationListParams,
  type ConversationListPool,
} from '../src/services/conversation-list'

const FLAG = 'CONVERSATION_SUMMARIES_ENABLED'

type QueryKind =
  | 'projects'
  | 'summary-ids'
  | 'summary-total'
  | 'details'
  | 'ids'
  | 'recent'
  | 'older'
  | 'exact'

interface RecordedQuery {
  kind: QueryKind
  sql: string
  values: unknown[]
}

interface SummaryRow {
  conversation_id: string
  project_id: string
  last_activity_at: Date
  account_ids: string[]
}

interface PoolState {
  /** Projects the principal may see */
  accessible: string[]
  /** conversation_summaries rows, newest first as the index returns them */
  summaries: SummaryRow[]
  /** IDs returned by the request-level page-ID query */
  requestIds: string[]
}

function classify(sql: string): QueryKind {
  if (sql.includes('FROM conversation_summaries')) {
    return sql.includes('COUNT(DISTINCT cs.conversation_id)') ? 'summary-total' : 'summary-ids'
  }
  if (sql.includes('conversation_rollups')) {
    return 'details'
  }
  if (sql.includes('AS older_total')) {
    return 'older'
  }
  if (sql.includes('AS recent_total')) {
    return 'recent'
  }
  if (sql.includes('COUNT(DISTINCT ar.conversation_id) AS total')) {
    return 'exact'
  }
  if (sql.includes('FROM api_requests')) {
    return 'ids'
  }
  if (sql.includes('FROM projects p')) {
    return 'projects'
  }
  throw new Error(`Unexpected query: ${sql}`)
}

/** Applies the project and account conditions of a conversation_summaries query */
function matching(sql: string, values: unknown[], rows: SummaryRow[]): SummaryRow[] {
  const valueOf = (match: RegExpMatchArray | null) =>
    match ? values[Number(match[1]) - 1] : undefined
  const anyProject = valueOf(sql.match(/cs\.project_id = ANY\(\$(\d+)::text\[\]\)/)) as
    | string[]
    | undefined
  const oneProject = valueOf(sql.match(/cs\.project_id = \$(\d+)/)) as string | undefined
  const account = valueOf(sql.match(/cs\.account_ids @> ARRAY\[\$(\d+)::text\]/)) as
    | string
    | undefined
  return rows.filter(
    row =>
      (anyProject === undefined || anyProject.includes(row.project_id)) &&
      (oneProject === undefined || row.project_id === oneProject) &&
      (account === undefined || row.account_ids.includes(account))
  )
}

function detailRow(conversationId: string) {
  return {
    conversation_id: conversationId,
    train_ids: ['project-a'],
    account_ids: ['acc-1'],
    first_message_time: new Date('2026-01-01T00:00:00Z'),
    last_message_time: new Date('2026-09-20T00:00:00Z'),
    message_count: '12',
    total_tokens: '345',
    branch_count: '3',
    subtask_branch_count: '1',
    compact_branch_count: '1',
    user_branch_count: '0',
    models_used: ['claude-test'],
    is_subtask: false,
    subtask_message_count: '2',
    latest_request_id: `req-${conversationId}`,
    latest_model: 'claude-test',
    latest_response_body: { usage: { input_tokens: 10 } },
    parent_task_request_id: null,
    parent_conversation_id: null,
  }
}

const idsFrom = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}-${i}`)

const summary = (
  conversationId: string,
  projectId: string,
  minutesAgo: number,
  accountIds: string[] = ['acc-1']
): SummaryRow => ({
  conversation_id: conversationId,
  project_id: projectId,
  last_activity_at: new Date(Date.UTC(2026, 8, 20) - minutesAgo * 60_000),
  account_ids: accountIds,
})

const summariesFor = (count: number, projectId = 'project-a') =>
  Array.from({ length: count }, (_, i) => summary(`conv-${i}`, projectId, i))

function createPool(overrides: Partial<PoolState> = {}) {
  const state: PoolState = {
    accessible: ['project-a'],
    summaries: summariesFor(75),
    requestIds: idsFrom('conv', 50),
    ...overrides,
  }
  const calls: RecordedQuery[] = []

  const pool = {
    async query(sql: string, values: unknown[] = []) {
      const kind = classify(sql)
      calls.push({ kind, sql, values })

      switch (kind) {
        case 'projects':
          return { rows: state.accessible.map(project_id => ({ project_id })) }
        case 'summary-ids': {
          const limit = Number(values[values.length - 1])
          return {
            rows: matching(sql, values, state.summaries)
              .slice(0, limit)
              .map(({ conversation_id, last_activity_at }) => ({
                conversation_id,
                last_activity_at,
              })),
          }
        }
        case 'summary-total': {
          const ids = new Set(
            matching(sql, values, state.summaries).map(row => row.conversation_id)
          )
          return { rows: [{ total: String(ids.size) }] }
        }
        case 'details': {
          const ids = values.find(Array.isArray) as string[]
          return { rows: ids.map(detailRow) }
        }
        case 'ids': {
          const match = sql.match(/LIMIT \$(\d+)\s+OFFSET \$(\d+)/)
          if (!match) {
            throw new Error('page ID query without LIMIT/OFFSET placeholders')
          }
          const limit = Number(values[Number(match[1]) - 1])
          const offset = Number(values[Number(match[2]) - 1])
          return {
            rows: state.requestIds
              .slice(offset, offset + limit)
              .map(conversation_id => ({ conversation_id })),
          }
        }
        case 'recent':
          return { rows: [{ recent_total: '30' }] }
        case 'older':
          return { rows: [{ older_total: '45' }] }
        case 'exact':
          return { rows: [{ total: '99' }] }
      }
    },
  }

  return {
    pool: pool as unknown as ConversationListPool,
    calls,
    of: (kind: QueryKind) => calls.filter(call => call.kind === kind),
  }
}

const page = (overrides: Partial<ConversationListParams> = {}): ConversationListParams => ({
  limit: 50,
  offset: 0,
  ...overrides,
})

let savedFlag: string | undefined

beforeEach(() => {
  savedFlag = process.env[FLAG]
  process.env[FLAG] = 'true'
})

afterEach(() => {
  if (savedFlag === undefined) {
    delete process.env[FLAG]
  } else {
    process.env[FLAG] = savedFlag
  }
})

describe('listConversations with CONVERSATION_SUMMARIES_ENABLED=true', () => {
  it('selects page IDs and the exact total from conversation_summaries only', async () => {
    const { pool, calls, of } = createPool()

    const result = await listConversations(pool, page(), undefined)

    expect(SUMMARY_SCAN_SLACK).toBe(32)
    expect(of('summary-ids')).toHaveLength(1)
    const [ids] = of('summary-ids')
    expect(ids.sql).toContain('ORDER BY cs.last_activity_at DESC, cs.conversation_id DESC')
    expect(ids.sql).not.toContain('WHERE')
    expect(ids.values).toEqual([50 + SUMMARY_SCAN_SLACK])
    expect(of('summary-total')).toHaveLength(1)
    expect(of('summary-total')[0].values).toEqual([])
    expect(of('projects')).toHaveLength(0)
    // api_requests is only read for the details of the selected page
    expect(calls.filter(call => call.sql.includes('api_requests')).map(call => call.kind)).toEqual([
      'details',
    ])
    expect(of('details')[0].values).toContainEqual(idsFrom('conv', 50))
    expect(result.conversations.map(c => c.conversationId)).toEqual(idsFrom('conv', 50))
    expect(result.pagination).toEqual({
      total: 75,
      limit: 50,
      offset: 0,
      hasMore: true,
      page: 1,
      totalPages: 2,
    })
  })

  it('restricts a principal to the accessible projects in both queries', async () => {
    const { pool, of } = createPool({
      accessible: ['project-a', 'project-b'],
      summaries: [summary('conv-hidden', 'project-c', 0), ...summariesFor(3)],
    })

    const result = await listConversations(pool, page(), ' Alice@Example.com ')

    expect(of('projects')).toHaveLength(1)
    expect(of('projects')[0].values).toEqual(['alice@example.com'])
    expect(of('projects')[0].sql).toContain('LOWER(pm.user_email) = $1')
    for (const query of [...of('summary-ids'), ...of('summary-total')]) {
      expect(query.sql).toContain('cs.project_id = ANY($1::text[])')
      expect(query.values[0]).toEqual(['project-a', 'project-b'])
    }
    expect(of('details')[0].sql).toContain('accessible_projects')
    expect(of('details')[0].values).toContain('alice@example.com')
    expect(result.conversations.map(c => c.conversationId)).toEqual(idsFrom('conv', 3))
    expect(result.pagination.total).toBe(3)
  })

  it('intersects projectId with the accessible projects', async () => {
    const { pool, of } = createPool({
      accessible: ['project-a', 'project-b'],
      summaries: [summary('conv-a', 'project-a', 0), summary('conv-b', 'project-b', 1)],
    })

    const result = await listConversations(
      pool,
      page({ projectId: 'project-b' }),
      'alice@example.com'
    )

    for (const query of [...of('summary-ids'), ...of('summary-total')]) {
      expect(query.sql).toContain('cs.project_id = $1')
      expect(query.values[0]).toBe('project-b')
    }
    expect(of('details')[0].values).toEqual(
      expect.arrayContaining(['alice@example.com', 'project-b'])
    )
    expect(result.conversations.map(c => c.conversationId)).toEqual(['conv-b'])
    expect(result.pagination.total).toBe(1)
  })

  it('returns nothing when no project is accessible', async () => {
    const cases: Array<[string[], ConversationListParams]> = [
      [[], page()],
      [['project-a'], page({ projectId: 'project-private' })],
      [[], page({ accountId: 'acc-1' })],
    ]
    for (const [accessible, params] of cases) {
      const { pool, calls } = createPool({ accessible })

      const result = await listConversations(pool, params, 'alice@example.com')

      // An empty project list must never widen to every project
      expect(calls.map(call => call.kind)).toEqual(['projects'])
      expect(result.conversations).toEqual([])
      expect(result.pagination).toEqual({
        total: 0,
        limit: 50,
        offset: 0,
        hasMore: false,
        page: 1,
        totalPages: 0,
      })
    }
  })

  it('filters an anonymous projectId directly on the table', async () => {
    const { pool, of } = createPool({
      summaries: [summary('conv-a', 'project-a', 0), summary('conv-b', 'project-b', 1)],
    })

    const result = await listConversations(pool, page({ projectId: 'project-a' }), undefined)

    expect(of('projects')).toHaveLength(0)
    expect(of('summary-ids')[0].sql).toContain('cs.project_id = $1')
    expect(of('summary-ids')[0].values).toEqual(['project-a', 50 + SUMMARY_SCAN_SLACK])
    expect(result.conversations.map(c => c.conversationId)).toEqual(['conv-a'])
    expect(result.pagination.total).toBe(1)
  })

  it('de-duplicates conversations listed under several projects, keeping the newest row', async () => {
    const { pool, of } = createPool({
      summaries: [
        summary('conv-0', 'project-a', 0),
        summary('conv-1', 'project-b', 1),
        summary('conv-0', 'project-b', 2),
        summary('conv-2', 'project-a', 3),
        summary('conv-1', 'project-a', 4),
        summary('conv-3', 'project-a', 5),
      ],
    })

    const first = await listConversations(pool, page({ limit: 2 }), undefined)
    const second = await listConversations(pool, page({ limit: 2, offset: 2 }), undefined)

    expect(first.conversations.map(c => c.conversationId)).toEqual(['conv-0', 'conv-1'])
    expect(second.conversations.map(c => c.conversationId)).toEqual(['conv-2', 'conv-3'])
    expect(of('details')[1].values).toContainEqual(['conv-2', 'conv-3'])
    expect([first.pagination.total, second.pagination.total]).toEqual([4, 4])
    expect(of('summary-ids').map(query => query.values.at(-1))).toEqual([
      2 + SUMMARY_SCAN_SLACK,
      4 + SUMMARY_SCAN_SLACK,
    ])
  })

  it('scans again with a doubled limit when duplicates exceed the slack', async () => {
    const scanLimit = 2 + SUMMARY_SCAN_SLACK
    const { pool, of } = createPool({
      summaries: [
        ...Array.from({ length: scanLimit }, (_, i) => summary('conv-dup', `project-${i}`, i)),
        summary('conv-a', 'project-a', 100),
        summary('conv-b', 'project-a', 101),
      ],
    })

    const result = await listConversations(pool, page({ limit: 2 }), undefined)

    expect(of('summary-ids').map(query => query.values.at(-1))).toEqual([scanLimit, 2 * scanLimit])
    expect(result.conversations.map(c => c.conversationId)).toEqual(['conv-dup', 'conv-a'])
    expect(result.pagination.total).toBe(3)
  })

  it('stops scanning at the end of the table', async () => {
    const { pool, of } = createPool({ summaries: summariesFor(5) })

    const result = await listConversations(pool, page({ offset: 100 }), undefined)

    expect(of('summary-ids')).toHaveLength(1)
    expect(of('details')).toHaveLength(0)
    expect(result.conversations).toEqual([])
    expect(result.pagination).toEqual({
      total: 5,
      limit: 50,
      offset: 100,
      hasMore: false,
      page: 3,
      totalPages: 1,
    })
  })

  it('keeps the request-level page selection for accountId and counts from the table', async () => {
    // conv-1's row is newer, but its activity with acc-1 can be older than conv-0's
    const { pool, of } = createPool({
      summaries: [
        summary('conv-1', 'project-a', 0, ['acc-1', 'acc-2']),
        summary('conv-0', 'project-a', 1, ['acc-1']),
        summary('conv-2', 'project-a', 2, ['acc-2']),
      ],
      requestIds: ['conv-0', 'conv-1'],
    })

    const result = await listConversations(pool, page({ accountId: 'acc-1' }), 'alice@example.com')

    expect(of('summary-ids')).toHaveLength(0)
    const ids = of('ids')
    expect(ids[0].sql).toContain("INTERVAL '7 days'")
    expect(ids[0].values).toEqual(expect.arrayContaining(['alice@example.com', 'acc-1']))
    const [total] = of('summary-total')
    expect(total.sql).toContain('cs.account_ids @> ARRAY[$2::text]')
    expect(total.values).toEqual(['project-a', 'acc-1'])
    expect([...of('recent'), ...of('older'), ...of('exact')]).toHaveLength(0)
    expect(result.conversations.map(c => c.conversationId)).toEqual(['conv-0', 'conv-1'])
    expect(result.pagination.total).toBe(2)
  })

  it('keeps the #213 paths unless the flag is exactly "true", and for explicit dates', async () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1', ' true']) {
      if (value === undefined) {
        delete process.env[FLAG]
      } else {
        process.env[FLAG] = value
      }
      const { pool, of } = createPool()

      await listConversations(pool, page(), 'alice@example.com', {
        olderCountCache: new OlderConversationCountCache(),
      })

      expect(conversationSummariesEnabled()).toBe(false)
      expect([...of('projects'), ...of('summary-ids'), ...of('summary-total')]).toHaveLength(0)
      expect(of('recent')).toHaveLength(1)
      expect(of('older')).toHaveLength(1)
    }

    process.env[FLAG] = 'true'
    const dated = createPool()
    await listConversations(dated.pool, page({ dateFrom: '2026-01-01' }), 'alice@example.com', {
      olderCountCache: new OlderConversationCountCache(),
    })
    expect(dated.of('exact')).toHaveLength(1)
    expect([
      ...dated.of('projects'),
      ...dated.of('summary-ids'),
      ...dated.of('summary-total'),
    ]).toHaveLength(0)
  })

  it('reads the flag on every call and honours the summaries option', async () => {
    const { pool, of } = createPool()
    const olderCountCache = new OlderConversationCountCache()

    await listConversations(pool, page(), undefined)
    delete process.env[FLAG]
    await listConversations(pool, page(), undefined, { olderCountCache })
    expect(of('summary-ids')).toHaveLength(1)
    expect(of('recent')).toHaveLength(1)

    await listConversations(pool, page(), undefined, { summaries: true })
    expect(of('summary-ids')).toHaveLength(2)

    process.env[FLAG] = 'true'
    await listConversations(pool, page(), undefined, { summaries: false, olderCountCache })
    expect(of('recent')).toHaveLength(2)
    expect(of('summary-ids')).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun --no-env-file test services/proxy/tests/conversation-list-summaries.test.ts
```

Expected: FAIL — the file does not load: `SyntaxError: Export named 'conversationSummariesEnabled' not found in module`.

- [ ] **Step 3: Write minimal implementation**

In `services/proxy/src/services/conversation-list.ts`:

1. Replace lines 153–167 — from `export interface ListConversationsOptions {` through the end of the `ACCESSIBLE_PROJECTS_CTE` constant — with (the CTE text stays byte-identical):

```ts
export interface ListConversationsOptions {
  olderCountCache?: OlderConversationCountCache
  /** Overrides CONVERSATION_SUMMARIES_ENABLED (the verify script forces the table path) */
  summaries?: boolean
}

/**
 * Whether GET /api/conversations reads pages and totals from conversation_summaries
 * (ADR-039). Read on every call; only the exact value 'true' enables it.
 */
export function conversationSummariesEnabled(): boolean {
  return process.env.CONVERSATION_SUMMARIES_ENABLED === 'true'
}

/** Rows read beyond offset + limit, absorbing conversations listed under several projects */
export const SUMMARY_SCAN_SLACK = 32

/** Conversations active here sort before every conversation that is not */
const RECENT_WINDOW = `ar.timestamp >= NOW() - INTERVAL '7 days'`

/** Projects the principal ($1) may see: public ones and private ones they are a member of */
const ACCESSIBLE_PROJECTS_SELECT = `
        SELECT DISTINCT p.project_id
        FROM projects p
        LEFT JOIN project_members pm
          ON p.id = pm.project_id
          AND LOWER(pm.user_email) = $1
        WHERE (p.is_private = false OR pm.user_email IS NOT NULL)
      `

const ACCESSIBLE_PROJECTS_CTE = `accessible_projects AS (${ACCESSIBLE_PROJECTS_SELECT})`
```

2. Replace lines 244–290 — the doc comment and body of `listConversations` — with:

```ts
/**
 * Lists one page of conversations visible to `principal` (an authenticated
 * user email; anonymous callers see every project).
 *
 * With CONVERSATION_SUMMARIES_ENABLED=true and no explicit dates, page IDs and
 * an exact total come from conversation_summaries (ADR-039). Otherwise, without
 * explicit dates, the page is selected from the last 7 days first: every
 * conversation active there sorts before every one that is not, so a full
 * windowed page equals the same page over full history. Only a short windowed
 * page falls back to scanning full history (ADR-038). Per-conversation details
 * are always computed over full history for the selected IDs.
 */
export async function listConversations(
  pool: ConversationListPool,
  params: ConversationListParams,
  principal?: string,
  options: ListConversationsOptions = {}
): Promise<ConversationListResult> {
  const normalizedPrincipal = normalizePrincipal(principal)
  const filter = buildFilter(params, normalizedPrincipal)

  if ((options.summaries ?? conversationSummariesEnabled()) && !hasExplicitDates(params)) {
    return listFromSummaries(pool, filter, params, normalizedPrincipal)
  }

  const olderCountCache = options.olderCountCache ?? olderConversationCountCache

  const [rows, counted] = await Promise.all([
    selectPage(pool, filter, params).then(ids => fetchDetails(pool, filter, ids)),
    hasExplicitDates(params)
      ? countExact(pool, filter)
      : countRecentPlusOlder(pool, filter, olderCountCache, [
          normalizedPrincipal ?? null,
          params.projectId || null,
          params.accountId || null,
        ]),
  ])

  return buildResult(rows, counted, params)
}

function buildResult(
  rows: ConversationRow[],
  counted: number,
  params: ConversationListParams
): ConversationListResult {
  // Rows on this page prove at least offset + rows.length conversations, so a
  // stale estimate must not hide them; an empty page proves nothing
  const total = rows.length > 0 ? Math.max(counted, params.offset + rows.length) : counted

  return {
    conversations: rows.map(toConversationListItem),
    pagination: {
      total,
      limit: params.limit,
      offset: params.offset,
      hasMore: params.offset + params.limit < total,
      page: Math.floor(params.offset / params.limit) + 1,
      totalPages: Math.ceil(total / params.limit),
    },
  }
}
```

3. After the closing `}` of `countRecentPlusOlder` (line 466, before `function toConversationListItem`), insert:

```ts
/**
 * Page IDs and the exact total from conversation_summaries (ADR-039); details
 * still come from api_requests with the same filters and privacy.
 */
async function listFromSummaries(
  pool: ConversationListPool,
  filter: ConversationFilter,
  params: ConversationListParams,
  principal?: string
): Promise<ConversationListResult> {
  const projects = await summaryProjects(pool, params, principal)
  if (projects?.length === 0) {
    // Nothing is accessible: an empty list must never widen to every project
    return buildResult([], 0, params)
  }

  const accountId = params.accountId || undefined
  const summaryFilter = buildSummaryFilter(projects, accountId)
  // A row's last_activity_at covers every account, but an account-filtered list
  // orders by that account's own activity: keep the request-level selection
  const pageIds = accountId
    ? selectPage(pool, filter, params)
    : selectSummaryPageIds(pool, summaryFilter, params)

  const [rows, counted] = await Promise.all([
    pageIds.then(ids => fetchDetails(pool, filter, ids)),
    countSummaries(pool, summaryFilter),
  ])

  return buildResult(rows, counted, params)
}

/**
 * Projects whose summaries the caller may list: undefined (no restriction) for
 * an anonymous caller without projectId, otherwise the accessible projects
 * (the accessible_projects rule) intersected with projectId.
 */
async function summaryProjects(
  pool: ConversationListPool,
  params: ConversationListParams,
  principal?: string
): Promise<string[] | undefined> {
  if (!principal) {
    return params.projectId ? [params.projectId] : undefined
  }
  const result = await pool.query(ACCESSIBLE_PROJECTS_SELECT, [principal])
  const accessible: string[] = result.rows.map((row: { project_id: string }) => row.project_id)
  return params.projectId ? accessible.filter(project => project === params.projectId) : accessible
}

/** Project/account conditions on conversation_summaries (alias cs) */
interface SummaryFilter {
  values: unknown[]
  where: string
}

function buildSummaryFilter(projects?: string[], accountId?: string): SummaryFilter {
  const values: unknown[] = []
  const conditions: string[] = []
  if (projects) {
    // A single project compares with = so its index can be walked in order
    values.push(projects.length === 1 ? projects[0] : projects)
    conditions.push(
      projects.length === 1
        ? `cs.project_id = $${values.length}`
        : `cs.project_id = ANY($${values.length}::text[])`
    )
  }
  if (accountId) {
    // @> rather than = ANY, so the GIN index on account_ids applies
    values.push(accountId)
    conditions.push(`cs.account_ids @> ARRAY[$${values.length}::text]`)
  }
  return { values, where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '' }
}

/**
 * Newest conversations first, ordered like the request-level list. Each
 * conversation has one row per project, so the scan reads SUMMARY_SCAN_SLACK
 * extra rows and keeps each conversation's first (newest) row; when duplicates
 * exceed the slack it scans again with a doubled limit, until the page is full
 * or the table is exhausted.
 */
async function selectSummaryPageIds(
  pool: ConversationListPool,
  summaryFilter: SummaryFilter,
  params: ConversationListParams
): Promise<string[]> {
  const needed = params.offset + params.limit
  let scanLimit = needed + SUMMARY_SCAN_SLACK

  for (;;) {
    const values = [...summaryFilter.values, scanLimit]
    const result = await pool.query(
      `
      SELECT cs.conversation_id, cs.last_activity_at
      FROM conversation_summaries cs
      ${summaryFilter.where}
      ORDER BY cs.last_activity_at DESC, cs.conversation_id DESC
      LIMIT $${values.length}
    `,
      values
    )
    const ids = [
      ...new Set<string>(
        result.rows.map((row: { conversation_id: string }) => row.conversation_id)
      ),
    ]
    if (ids.length >= needed || result.rows.length < scanLimit) {
      return ids.slice(params.offset, needed)
    }
    scanLimit *= 2
  }
}

async function countSummaries(
  pool: ConversationListPool,
  summaryFilter: SummaryFilter
): Promise<number> {
  const result = await pool.query(
    `
      SELECT COUNT(DISTINCT cs.conversation_id) AS total
      FROM conversation_summaries cs
      ${summaryFilter.where}
    `,
    summaryFilter.values
  )
  return parseInt(result.rows[0]?.total || '0')
}
```

In `docs/06-Reference/environment-vars.md`, add this row to the Feature Flags table after `COLLECT_TEST_SAMPLES` (line 45):

```markdown
| `CONVERSATION_SUMMARIES_ENABLED` | Serve `GET /api/conversations` pages and exact totals from `conversation_summaries` (ADR-039) when no date bounds are given; only the exact value `true` enables it. Apply migration 027 and run the backfill first | `false` |
```

In `docs/02-User-Guide/api-reference.md`, replace the paragraph at line 377 (starting `Conversations are ordered by last message time`) with:

```markdown
Conversations are ordered by last message time (newest first, ties broken by conversation ID). Per-conversation aggregates cover all of the conversation's requests that match the filters (project, account, date bounds and project access), not just the last 7 days. By default, without `dateFrom`/`dateTo`, `pagination.total` adds a live count of conversations active in the last 7 days to a count of older conversations cached for up to one hour, so it may be off, over or under, by up to an hour of activity. When a page returns conversations, the total is at least `offset` plus their number. With either date bound the total is an exact count. When the proxy runs with `CONVERSATION_SUMMARIES_ENABLED=true` (ADR-039), requests without date bounds are paged from the `conversation_summaries` table and the total is exact as well.
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun --no-env-file test services/proxy/tests/conversation-list-summaries.test.ts services/proxy/tests/conversation-list.test.ts
```

Expected: PASS — 11 new tests plus every existing `conversation-list.test.ts` test (unchanged file), `0 fail`.

Gates:

```bash
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run typecheck
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run lint 2>&1 | grep -oE '[0-9]+ errors, [0-9]+ warnings' | awk '{e+=$1; w+=$3} END {print e" errors, "w" warnings"}'
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run test:ci
CONVERSATION_LIST_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run test:db:conversations
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bunx prettier --check services/proxy/src/services/conversation-list.ts services/proxy/tests/conversation-list-summaries.test.ts docs/06-Reference/environment-vars.md docs/02-User-Guide/api-reference.md
grep -nP '[\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]' services/proxy/src/services/conversation-list.ts services/proxy/tests/conversation-list-summaries.test.ts docs/06-Reference/environment-vars.md docs/02-User-Guide/api-reference.md
```

Expected: typecheck exit 0; `0 errors, 245 warnings` or fewer; `test:ci` passes; `test:db:conversations` passes unchanged (flag unset: #213 path); prettier clean (the environment-vars table is realigned by `prettier --write` if needed); grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add services/proxy/src/services/conversation-list.ts services/proxy/tests/conversation-list-summaries.test.ts docs/06-Reference/environment-vars.md docs/02-User-Guide/api-reference.md
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= git commit \
  -m "perf(proxy): serve conversation pages and totals from conversation_summaries behind a flag" \
  -m "With CONVERSATION_SUMMARIES_ENABLED=true and no date bounds, page IDs (de-duplicated, re-scanned when short) and an exact total come from the summary table; account-filtered pages keep the request-level selection; details are unchanged (ADR-039)." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: DB integration test seeded through the real writer

**Files:**

- Create: `tests/integration/conversation-summaries.db.test.ts`
- Modify: `package.json:52` (script after `test:db:conversations`)
- Test: `tests/integration/conversation-summaries.db.test.ts`

**Interfaces:**

- Consumes: migration 027 CLI (Task 1), `StorageWriter.storeRequest` (Task 2), `backfillConversationSummaries(pool, { chunkDays, execute }, log)` (Task 3), `listConversations` with the flag (Task 4).
- Produces: package script `test:db:conversation-summaries`; environment variable `CONVERSATION_SUMMARIES_TEST_DATABASE_URL` (must name a database ending in `_test`, otherwise the suite is skipped); ID prefixes `c5ab0000-` (conversations) and `c5ab0001-` (requests), projects `convsum-test-*`.

- [ ] **Step 1: Write the test**

Create `tests/integration/conversation-summaries.db.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Pool } from 'pg'
import { join } from 'node:path'
import {
  listConversations,
  type ConversationListParams,
  type ConversationListPool,
} from '../../services/proxy/src/services/conversation-list'
import { StorageWriter } from '../../services/proxy/src/storage/writer'
import { backfillConversationSummaries } from '../../scripts/db/backfill-conversation-summaries'

// Only ever runs against an explicitly named local *_test database
const databaseUrl = process.env.CONVERSATION_SUMMARIES_TEST_DATABASE_URL
const enabled = !!databaseUrl && new URL(databaseUrl).pathname.endsWith('_test')
const root = join(import.meta.dir, '../..')

const PUBLIC_A = 'convsum-test-public-a'
const PUBLIC_B = 'convsum-test-public-b'
const PRIVATE = 'convsum-test-private' // the viewer is not a member
const MEMBER = 'convsum-test-member' // private, the viewer is a member
const VIEWER = 'Viewer@ConvSum.test'
const OTHER_MEMBER = 'other@convsum.test' // member of PRIVATE only
const NON_MEMBER = 'nobody@convsum.test'
const ACC_A = 'convsum-acc-a'
const ACC_B = 'convsum-acc-b'
const ACC_C = 'convsum-acc-c'
const FLAG = 'CONVERSATION_SUMMARIES_ENABLED'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const conv = (n: number) => `c5ab0000-0000-4000-8000-${String(n).padStart(12, '0')}`
const req = (n: number) => `c5ab0001-0000-4000-8000-${String(n).padStart(12, '0')}`
const isSeeded = (conversationId: string) => conversationId.startsWith('c5ab0000-')

type Filters = Omit<ConversationListParams, 'limit' | 'offset'>

interface Seed {
  conversation?: number
  project: string
  account?: string
  at: number
}

describe.skipIf(!enabled)('conversation summaries against PostgreSQL', () => {
  let pool: Pool
  let writer: StorageWriter
  let savedFlag: string | undefined
  let nextRequest = 0
  const now = Date.now()
  const quiet = () => {}
  const base = (c: number) => now - c * 7 * HOUR - 30 * MINUTE

  const seeds = (): Seed[] => {
    const list: Seed[] = []
    // 70 public conversations over ~20 days; every third one used ACC_C last
    for (let c = 0; c < 70; c++) {
      const last = c === 19 ? base(20) : base(c) // 19 and 20 tie on last activity
      const account = c % 2 === 0 ? ACC_A : ACC_B
      list.push({ conversation: c, project: PUBLIC_A, account, at: last - 2 * DAY })
      if (c % 3 === 0) {
        list.push({ conversation: c, project: PUBLIC_A, account, at: last - DAY })
        list.push({ conversation: c, project: PUBLIC_A, account: ACC_C, at: last })
      } else {
        list.push({ conversation: c, project: PUBLIC_A, account, at: last })
      }
    }
    // Conversations in two public projects, newest in either one
    for (let c = 70; c < 75; c++) {
      const offset = (c - 70) * 5 * HOUR
      list.push({
        conversation: c,
        project: PUBLIC_A,
        account: ACC_A,
        at: now - offset - (c % 2 ? HOUR : 3 * HOUR),
      })
      list.push({
        conversation: c,
        project: PUBLIC_B,
        account: ACC_B,
        at: now - offset - (c % 2 ? 3 * HOUR : HOUR),
      })
    }
    // Public conversations whose newest request is in the private project
    for (let c = 75; c < 80; c++) {
      list.push({
        conversation: c,
        project: PUBLIC_A,
        account: ACC_A,
        at: now - 2 * DAY - (c - 75) * HOUR,
      })
      list.push({ conversation: c, project: PRIVATE, account: ACC_A, at: now - 10 * MINUTE })
    }
    for (let c = 80; c < 85; c++) {
      list.push({
        conversation: c,
        project: PRIVATE,
        account: ACC_B,
        at: now - (c - 80) * 3 * HOUR - 20 * MINUTE,
      })
    }
    for (let c = 85; c < 90; c++) {
      list.push({
        conversation: c,
        project: MEMBER,
        account: ACC_B,
        at: now - (c - 85) * 4 * HOUR - 40 * MINUTE,
      })
    }
    // Long-idle conversations spanning several chunks; 90 starts without an account
    for (let c = 90; c < 100; c++) {
      list.push({
        conversation: c,
        project: PUBLIC_A,
        account: c === 90 ? undefined : ACC_A,
        at: now - 40 * DAY - c * HOUR,
      })
      list.push({
        conversation: c,
        project: PUBLIC_A,
        account: ACC_B,
        at: now - 30 * DAY - c * HOUR,
      })
    }
    // A conversation without any account, and requests outside any conversation
    list.push({ conversation: 100, project: PUBLIC_A, at: now - 35 * DAY })
    list.push({ conversation: 100, project: PUBLIC_A, at: now - 34 * DAY })
    for (let i = 0; i < 3; i++) {
      list.push({ project: PUBLIC_A, account: ACC_A, at: now - i * HOUR })
    }
    return list
  }
  const SEED_GROUPS = 111

  const store = (seed: Seed) =>
    writer.storeRequest({
      requestId: req(nextRequest++),
      projectId: seed.project,
      accountId: seed.account,
      timestamp: new Date(seed.at),
      method: 'POST',
      path: '/v1/messages',
      headers: {},
      body: { messages: [{ role: 'user', content: 'seeded request' }] },
      apiKey: '',
      model: 'claude-test',
      requestType: 'inference',
      conversationId: seed.conversation === undefined ? undefined : conv(seed.conversation),
      parentMessageHash: 'convsum-parent',
    })

  const cleanUp = async () => {
    await pool.query(`DELETE FROM api_requests WHERE request_id::text LIKE 'c5ab0001-%'`)
    await pool.query(
      `DELETE FROM conversation_summaries WHERE conversation_id::text LIKE 'c5ab0000-%'`
    )
    await pool.query(`DELETE FROM projects WHERE project_id LIKE 'convsum-test-%'`)
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl })
    savedFlag = process.env[FLAG]
    process.env[FLAG] = 'true'
    await cleanUp()
    // Other suites store requests without StorageWriter or delete them afterwards:
    // start from a table derived from api_requests
    await pool.query('DELETE FROM conversation_summaries')
    await backfillConversationSummaries(pool, { chunkDays: 7, execute: true }, quiet)

    for (const [projectId, isPrivate] of [
      [PUBLIC_A, false],
      [PUBLIC_B, false],
      [PRIVATE, true],
      [MEMBER, true],
    ] as const) {
      await pool.query(
        `INSERT INTO projects (project_id, name, is_private, api_key) VALUES ($1, $1, $2, $3)`,
        [projectId, isPrivate, `${projectId}-key`]
      )
    }
    for (const [projectId, email] of [
      [PRIVATE, OTHER_MEMBER],
      [MEMBER, VIEWER],
    ]) {
      await pool.query(
        `INSERT INTO project_members (project_id, user_email, role, added_by)
         SELECT id, $2, 'member', 'conversation-summaries-test' FROM projects WHERE project_id = $1`,
        [projectId, email]
      )
    }

    writer = new StorageWriter(pool)
    // Out of chronological order, so first/last activity rely on LEAST/GREATEST
    const ordered = seeds()
      .map((seed, index) => ({ seed, key: (index * 7919) % 1009 }))
      .sort((a, b) => a.key - b.key)
      .map(entry => entry.seed)
    for (const seed of ordered) {
      await store(seed)
    }
  })

  afterAll(async () => {
    await cleanUp()
    await pool.end()
    if (savedFlag === undefined) {
      delete process.env[FLAG]
    } else {
      process.env[FLAG] = savedFlag
    }
  })

  const tableRows = async () =>
    (
      await pool.query(
        `SELECT conversation_id, project_id, first_activity_at, last_activity_at,
                ARRAY(SELECT unnest(account_ids) ORDER BY 1) AS account_ids
         FROM conversation_summaries
         WHERE conversation_id::text LIKE 'c5ab0000-%'
         ORDER BY conversation_id, project_id`
      )
    ).rows

  /** Grouped from api_requests, independently of the code under test */
  const groupedReference = async () =>
    (
      await pool.query(
        `SELECT conversation_id, project_id,
                MIN(timestamp) AS first_activity_at,
                MAX(timestamp) AS last_activity_at,
                COALESCE(ARRAY_AGG(DISTINCT account_id::text ORDER BY account_id::text)
                  FILTER (WHERE account_id IS NOT NULL), '{}') AS account_ids
         FROM api_requests
         WHERE conversation_id::text LIKE 'c5ab0000-%'
         GROUP BY conversation_id, project_id
         ORDER BY conversation_id, project_id`
      )
    ).rows

  const visibility = `
         ar.conversation_id IS NOT NULL
         AND ($1::text IS NULL OR ar.project_id IN (
           SELECT p.project_id FROM projects p
           WHERE NOT p.is_private
              OR EXISTS (
                SELECT 1 FROM project_members pm
                WHERE pm.project_id = p.id AND LOWER(pm.user_email) = LOWER($1)
              )
         ))
         AND ($2::text IS NULL OR ar.project_id = $2)
         AND ($3::text IS NULL OR ar.account_id = $3)`

  /** Request-level reference over the whole database, written independently of the code under test */
  const reference = async (
    principal: string | undefined,
    filters: Filters,
    limit: number,
    offset: number
  ) => {
    const values = [principal?.trim() || null, filters.projectId ?? null, filters.accountId ?? null]
    const ids = await pool.query(
      `SELECT ar.conversation_id
       FROM api_requests ar
       WHERE ${visibility}
       GROUP BY ar.conversation_id
       ORDER BY MAX(ar.timestamp) DESC, ar.conversation_id DESC
       LIMIT $4 OFFSET $5`,
      [...values, limit, offset]
    )
    const total = await pool.query(
      `SELECT COUNT(DISTINCT ar.conversation_id)::int AS total
       FROM api_requests ar
       WHERE ${visibility}`,
      values
    )
    return {
      ids: ids.rows.map((row: { conversation_id: string }) => row.conversation_id),
      total: total.rows[0].total as number,
    }
  }

  const listed = async (principal: string | undefined, params: ConversationListParams) => {
    const statements: string[] = []
    const spy = {
      query: (sql: string, values?: unknown[]) => {
        statements.push(sql)
        return pool.query(sql, values)
      },
    } as unknown as ConversationListPool
    const result = await listConversations(spy, params, principal)
    return {
      ids: result.conversations.map(item => item.conversationId),
      conversations: result.conversations,
      total: result.pagination.total,
      statements,
    }
  }

  it('migration 027 is idempotent', async () => {
    for (let run = 0; run < 2; run++) {
      const child = Bun.spawn(
        [
          'bun',
          '--no-env-file',
          join(root, 'scripts/db/migrations/027-add-conversation-summaries.ts'),
          'up',
        ],
        {
          cwd: root,
          env: { ...process.env, DATABASE_URL: databaseUrl },
          stdout: 'ignore',
          stderr: 'inherit',
        }
      )
      expect(await child.exited).toBe(0)
    }
  })

  it('the writer keeps one row per conversation and project', async () => {
    const stored = await pool.query(
      `SELECT COUNT(*)::int AS requests,
              COUNT(*) FILTER (WHERE conversation_id IS NULL)::int AS without_conversation
       FROM api_requests WHERE request_id::text LIKE 'c5ab0001-%'`
    )
    expect(stored.rows[0]).toEqual({ requests: seeds().length, without_conversation: 3 })

    const expected = await groupedReference()
    expect(expected).toHaveLength(SEED_GROUPS)
    expect(await tableRows()).toEqual(expected)
  })

  const cases: Array<{ name: string; principal?: string; filters: Filters }> = [
    { name: 'anonymous', filters: {} },
    { name: 'anonymous with projectId', filters: { projectId: PUBLIC_A } },
    { name: 'member', principal: VIEWER, filters: {} },
    {
      name: 'member with their private project',
      principal: VIEWER,
      filters: { projectId: MEMBER },
    },
    { name: 'member of the private project', principal: OTHER_MEMBER, filters: {} },
    { name: 'non-member', principal: NON_MEMBER, filters: {} },
    {
      name: 'non-member with a private projectId',
      principal: NON_MEMBER,
      filters: { projectId: PRIVATE },
    },
    { name: 'anonymous with accountId', filters: { accountId: ACC_A } },
    {
      name: 'member with projectId and accountId',
      principal: VIEWER,
      filters: { projectId: PUBLIC_A, accountId: ACC_C },
    },
  ]

  for (const testCase of cases) {
    it(`pages 1-3 and the total match the request-level reference: ${testCase.name}`, async () => {
      for (const offset of [0, 20, 40]) {
        const expected = await reference(testCase.principal, testCase.filters, 20, offset)
        const result = await listed(testCase.principal, { ...testCase.filters, limit: 20, offset })

        expect(result.ids).toEqual(expected.ids)
        expect(result.total).toBe(expected.total)
        if (!testCase.filters.accountId) {
          // Page IDs and totals never scan api_requests; only the details query does
          expect(
            result.statements.filter(
              sql => sql.includes('FROM api_requests') && !sql.includes('conversation_rollups')
            )
          ).toEqual([])
        }
      }
    })
  }

  it('orders a cross-project conversation by its accessible activity only', async () => {
    // Their newest requests are in the private project, tied, so by id descending
    const anonymous = await listed(undefined, { limit: 20, offset: 0 })
    expect(anonymous.ids.filter(isSeeded).slice(0, 5)).toEqual([79, 78, 77, 76, 75].map(conv))

    const expected = await reference(VIEWER, {}, 60, 0)
    const viewer = await listed(VIEWER, { limit: 60, offset: 0 })
    expect(viewer.ids).toEqual(expected.ids)
    expect(viewer.ids.filter(isSeeded).slice(0, 5)).not.toContain(conv(75))
    const item = viewer.conversations.find(c => c.conversationId === conv(75))
    expect(item?.trainIds).toEqual([PUBLIC_A])
  })

  it("orders accountId pages by that account's own activity", async () => {
    const filters = { projectId: PUBLIC_A, accountId: ACC_A }
    const byRowActivity = await pool.query(
      `SELECT conversation_id FROM conversation_summaries
       WHERE project_id = $1 AND account_ids @> ARRAY[$2::text]
       ORDER BY last_activity_at DESC, conversation_id DESC
       LIMIT 20`,
      [PUBLIC_A, ACC_A]
    )
    const expected = await reference(undefined, filters, 20, 0)
    // Only meaningful while the account's own order differs from the rows' order
    expect(byRowActivity.rows.map(row => row.conversation_id)).not.toEqual(expected.ids)

    const result = await listed(undefined, { ...filters, limit: 20, offset: 0 })
    expect(result.ids).toEqual(expected.ids)
    expect(result.total).toBe(expected.total)
  })

  it('explicit dates keep the request-level path', async () => {
    const result = await listed(VIEWER, {
      dateFrom: new Date(now - 10 * DAY).toISOString(),
      dateTo: new Date(now).toISOString(),
      limit: 20,
      offset: 0,
    })

    expect(result.statements.some(sql => sql.includes('conversation_summaries'))).toBe(false)
    expect(
      result.statements.some(sql => sql.includes('COUNT(DISTINCT ar.conversation_id) AS total'))
    ).toBe(true)
  })

  it('a backfill after live writes changes nothing', async () => {
    const result = await backfillConversationSummaries(pool, { chunkDays: 7, execute: true }, quiet)

    expect(result.changed).toBe(0)
    expect(result.groups).toBeGreaterThanOrEqual(SEED_GROUPS)
    expect(await tableRows()).toEqual(await groupedReference())
  })

  it('a backfill alone rebuilds the rows across chunk boundaries and is idempotent', async () => {
    await pool.query(
      `DELETE FROM conversation_summaries WHERE conversation_id::text LIKE 'c5ab0000-%'`
    )

    const first = await backfillConversationSummaries(pool, { chunkDays: 1, execute: true }, quiet)
    expect(first.changed).toBeGreaterThanOrEqual(SEED_GROUPS)
    expect(await tableRows()).toEqual(await groupedReference())

    const again = await backfillConversationSummaries(pool, { chunkDays: 1, execute: true }, quiet)
    expect(again.changed).toBe(0)
  })

  it('live writes after a backfill converge', async () => {
    await pool.query(
      `DELETE FROM conversation_summaries WHERE conversation_id::text LIKE 'c5ab0000-%'`
    )
    await backfillConversationSummaries(pool, { chunkDays: 7, execute: true }, quiet)

    await store({ conversation: 5, project: PUBLIC_A, account: ACC_B, at: now - 60 * DAY }) // before its first activity
    await store({ conversation: 6, project: PUBLIC_A, account: ACC_A, at: base(6) + 5 * MINUTE }) // after its last
    await store({ conversation: 7, project: PUBLIC_A, account: ACC_C, at: base(7) - HOUR }) // a new account
    await store({ conversation: 8, project: PUBLIC_B, account: ACC_A, at: base(8) - HOUR }) // a new project

    expect(await tableRows()).toEqual(await groupedReference())
  })

  it('converges when the backfill runs concurrently with live writes', async () => {
    await pool.query(
      `DELETE FROM conversation_summaries WHERE conversation_id::text LIKE 'c5ab0000-%'`
    )

    await Promise.all([
      backfillConversationSummaries(pool, { chunkDays: 1, execute: true }, quiet),
      ...[10, 11, 12, 13, 14, 15].map((c, i) =>
        store({
          conversation: c,
          project: i % 2 ? PUBLIC_B : PUBLIC_A,
          account: ACC_C,
          at: base(c) - i * DAY,
        })
      ),
    ])

    expect(await tableRows()).toEqual(await groupedReference())
  })
})
```

In `package.json`, after line 52 (`"test:db:conversations": …,`) add:

```json
    "test:db:conversation-summaries": "bun test tests/integration/conversation-summaries.db.test.ts",
```

- [ ] **Step 2: Run test to verify it fails on a known defect**

The suite exercises Tasks 1–4, so first prove its account pin catches the ordering defect it exists for. Temporarily route account-filtered pages through the table, run, and restore:

```bash
sed -i 's/const pageIds = accountId$/const pageIds = false \&\& accountId/' services/proxy/src/services/conversation-list.ts
grep -n 'const pageIds = false && accountId' services/proxy/src/services/conversation-list.ts
CONVERSATION_SUMMARIES_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run test:db:conversation-summaries
git checkout -- services/proxy/src/services/conversation-list.ts
git diff --quiet services/proxy/src/services/conversation-list.ts && echo restored
```

Expected: the `grep` prints one line (the mutation applied); the run FAILS in "orders accountId pages by that account's own activity" and in "pages 1-3 and the total match the request-level reference: anonymous with accountId" (`expect(received).toEqual(expected)` on the ID lists); every other test passes; the last command prints `restored`.

- [ ] **Step 3: Write minimal implementation**

No production code: the suite covers Tasks 1–4 as written. If any test other than the two pinned by the mutation failed in Step 2, fix the defect in the owning task's file with a unit test that reproduces it before continuing.

- [ ] **Step 4: Run test to verify it passes**

```bash
CONVERSATION_SUMMARIES_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run test:db:conversation-summaries
CONVERSATION_SUMMARIES_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run test:db:conversation-summaries
```

Expected: both runs PASS — 18 tests, `0 fail` (the second run proves the suite cleans up after itself).

Gates:

```bash
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run typecheck
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run test:ci
SUMMARY_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run test:db:summary
CONVERSATION_LIST_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run test:db:conversations
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bunx prettier --check tests/integration/conversation-summaries.db.test.ts package.json
grep -nP '[\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]' tests/integration/conversation-summaries.db.test.ts package.json
```

Expected: all pass; `test:db:summary` now also exercises the upsert through its writer tests (its pre-026 schema test logs the one "conversation_summaries is missing" error and still passes); prettier clean; grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/conversation-summaries.db.test.ts package.json
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= git commit \
  -m "test(db): cover conversation summaries against PostgreSQL" \
  -m "Seeds through StorageWriter; checks rows against a grouped reference, pages 1-3 and totals against the request-level listing, and backfill convergence in either order and concurrently." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: E2E with the flag off and on

**Files:**

- Modify: `scripts/e2e/setup-database.ts:3` (import) and `:70` (backfill before the final log)
- Modify: `playwright.config.ts:16` (managed-server env)
- Test: existing `e2e/` specs tagged `@smoke` and `@journey`

**Interfaces:**

- Consumes: `backfillConversationSummaries(pool, { chunkDays: 7, execute: true })` (Task 3); the flag-gated reader (Task 4).
- Produces: E2E databases whose seed has its `conversation_summaries` rows; managed proxy/dashboard servers always receive `CONVERSATION_SUMMARIES_ENABLED` (the caller's value, else `'false'`).

- [ ] **Step 1: Write the failing test**

The test is the existing `@journey` suite run with the flag on; make the managed servers receive the flag explicitly. In `playwright.config.ts`, after line 16 (`PROXY_API_URL: proxyURL,`) add:

```ts
  // Explicit, so a value in .env can never switch the managed proxy's read path (ADR-039)
  CONVERSATION_SUMMARIES_ENABLED: process.env.CONVERSATION_SUMMARIES_ENABLED || 'false',
```

- [ ] **Step 2: Run test to verify it fails**

Fresh E2E database with the current setup (no backfill yet), then the journeys with the flag on:

```bash
docker exec perf03-pg dropdb -U postgres --if-exists perf03_e2e_test
docker exec perf03-pg createdb -U postgres perf03_e2e_test
E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_e2e_test bun --no-env-file scripts/e2e/setup-database.ts
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run build
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= CONVERSATION_SUMMARIES_ENABLED=true TEST_START_SERVERS=true \
  E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_e2e_test DASHBOARD_API_KEY=e2e-local-key \
  bunx playwright test --grep "@journey" --project=chromium
```

Expected: setup prints `Applying 027-add-conversation-summaries.ts` among the migrations and exits 0; the Playwright run FAILS — "Journey 3: Navigate conversation tree" times out waiting for `getByTestId('conversation-link')` (the seed bypassed the writer, so the table is empty and the landing page lists nothing); the later journeys of the serial block do not run.

- [ ] **Step 3: Write minimal implementation**

In `scripts/e2e/setup-database.ts`, after line 3 (`import { up as addProjectApiKeys } …`) add:

```ts
import { backfillConversationSummaries } from '../db/backfill-conversation-summaries'
```

and immediately before line 70 add the first two lines below (the last two are the existing context lines, unchanged):

```ts
  // The seed bypasses the proxy writer, so derive its conversation summaries (ADR-039)
  await backfillConversationSummaries(pool, { chunkDays: 7, execute: true })
  console.log('E2E database initialized with synthetic data')
} finally {
```

- [ ] **Step 4: Run test to verify it passes**

Flag on, fresh database:

```bash
docker exec perf03-pg dropdb -U postgres --if-exists perf03_e2e_test
docker exec perf03-pg createdb -U postgres perf03_e2e_test
E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_e2e_test bun --no-env-file scripts/e2e/setup-database.ts
docker exec perf03-pg psql -U postgres -d perf03_e2e_test -Atc "SELECT conversation_id, project_id, account_ids FROM conversation_summaries"
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= CONVERSATION_SUMMARIES_ENABLED=true TEST_START_SERVERS=true \
  E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_e2e_test DASHBOARD_API_KEY=e2e-local-key \
  bunx playwright test --grep "@smoke|@journey" --project=chromium
```

Expected: setup logs `EXECUTE: 1 chunks …` and `Done: {"chunks":1,"groups":1,"changed":1}`; psql prints `00000000-0000-4000-8000-000000000003|project-e2e|{e2e-account}`; Playwright: all tests pass, `0 failed`.

Flag off (unset), fresh database:

```bash
docker exec perf03-pg dropdb -U postgres --if-exists perf03_e2e_test
docker exec perf03-pg createdb -U postgres perf03_e2e_test
E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_e2e_test bun --no-env-file scripts/e2e/setup-database.ts
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= TEST_START_SERVERS=true \
  E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_e2e_test DASHBOARD_API_KEY=e2e-local-key \
  bunx playwright test --grep "@smoke|@journey" --project=chromium
```

Expected: all tests pass, `0 failed`.

Gates:

```bash
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run typecheck
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bunx prettier --check scripts/e2e/setup-database.ts playwright.config.ts
grep -nP '[\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]' scripts/e2e/setup-database.ts playwright.config.ts
```

Expected: typecheck exit 0; prettier clean; grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e/setup-database.ts playwright.config.ts
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= git commit \
  -m "test(e2e): backfill conversation summaries in the E2E database" \
  -m "The E2E seed bypasses the proxy writer; derive its summary rows after seeding and pass CONVERSATION_SUMMARIES_ENABLED to managed servers explicitly (default false)." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Read-only verify script

**Files:**

- Create: `scripts/db/verify-conversation-summaries.ts`
- Create: `scripts/db/__tests__/verify-conversation-summaries.test.ts`
- Create: `tests/integration/verify-conversation-summaries.db.test.ts`
- Modify: `package.json` (the `test:db:conversation-summaries` line from Task 5)
- Modify: `scripts/README.md` (section after `### backfill-conversation-summaries.ts` from Task 3)
- Test: `scripts/db/__tests__/verify-conversation-summaries.test.ts`, `tests/integration/verify-conversation-summaries.db.test.ts`

**Interfaces:**

- Consumes: `listConversations(pool, params, principal, { summaries: true })` (Task 4); `StorageWriter.storeRequest` (Task 2); `backfillConversationSummaries` (Task 3).
- Produces (from `scripts/db/verify-conversation-summaries.ts`):
  - `interface VerifyOptions { principals: number; pageSize: number; settleSeconds: number }` (defaults 3, 50, 60)
  - `parseVerifyArgs(argv: string[]): VerifyOptions`
  - `verifyConversationSummaries(pool: Pool, options: VerifyOptions, log?: (line: string) => void): Promise<string[]>` — mismatches as `missing:<id>`, `stale:<id>`, `different:<id>`, `pages:<case>:<position>:<expected>:<served>`, `length:<case>:<expected>:<served>`, `total:<case>:<expected>:<served>`; cases are `anonymous`, `principal-N`, `busiest-project`, `busiest-account`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/db/__tests__/verify-conversation-summaries.test.ts`:

```ts
import { describe, it, expect } from 'bun:test'
import { parseVerifyArgs } from '../verify-conversation-summaries'

describe('parseVerifyArgs', () => {
  it('defaults to 3 principals, 50 per page and a 60 s settle margin', () => {
    expect(parseVerifyArgs([])).toEqual({ principals: 3, pageSize: 50, settleSeconds: 60 })
  })

  it('parses every flag', () => {
    expect(
      parseVerifyArgs(['--principals', '0', '--page-size', '20', '--settle-seconds', '0'])
    ).toEqual({ principals: 0, pageSize: 20, settleSeconds: 0 })
  })

  it('rejects invalid values', () => {
    expect(() => parseVerifyArgs(['--principals', '-1'])).toThrow('--principals')
    expect(() => parseVerifyArgs(['--page-size', '0'])).toThrow('--page-size')
    expect(() => parseVerifyArgs(['--settle-seconds', 'x'])).toThrow('--settle-seconds')
    expect(() => parseVerifyArgs(['--settle-seconds'])).toThrow('--settle-seconds')
    expect(() => parseVerifyArgs(['--execute'])).toThrow('Unknown option')
  })
})
```

Create `tests/integration/verify-conversation-summaries.db.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Pool } from 'pg'
import { StorageWriter } from '../../services/proxy/src/storage/writer'
import { backfillConversationSummaries } from '../../scripts/db/backfill-conversation-summaries'
import { verifyConversationSummaries } from '../../scripts/db/verify-conversation-summaries'

// Only ever runs against an explicitly named local *_test database
const databaseUrl = process.env.CONVERSATION_SUMMARIES_TEST_DATABASE_URL
const enabled = !!databaseUrl && new URL(databaseUrl).pathname.endsWith('_test')

const PROJECT = 'convsum-verify-public'
const PRIVATE_PROJECT = 'convsum-verify-private'
const MEMBER = 'member@convsum-verify.test'
const conv = (n: number) => `c5ab0010-0000-4000-8000-${String(n).padStart(12, '0')}`
const req = (n: number) => `c5ab0011-0000-4000-8000-${String(n).padStart(12, '0')}`
const PHANTOM = conv(999)

describe.skipIf(!enabled)('verify-conversation-summaries against PostgreSQL', () => {
  let pool: Pool
  const quiet = () => {}
  const options = { principals: 5, pageSize: 5, settleSeconds: 0 }
  const refill = () => backfillConversationSummaries(pool, { chunkDays: 7, execute: true }, quiet)

  const cleanUp = async () => {
    await pool.query(`DELETE FROM api_requests WHERE request_id::text LIKE 'c5ab0011-%'`)
    await pool.query(
      `DELETE FROM conversation_summaries WHERE conversation_id::text LIKE 'c5ab0010-%'`
    )
    await pool.query(`DELETE FROM projects WHERE project_id LIKE 'convsum-verify-%'`)
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl })
    await cleanUp()
    for (const [projectId, isPrivate] of [
      [PROJECT, false],
      [PRIVATE_PROJECT, true],
    ] as const) {
      await pool.query(
        `INSERT INTO projects (project_id, name, is_private, api_key) VALUES ($1, $1, $2, $3)`,
        [projectId, isPrivate, `${projectId}-key`]
      )
    }
    await pool.query(
      `INSERT INTO project_members (project_id, user_email, role, added_by)
       SELECT id, $2, 'member', 'verify-conversation-summaries-test' FROM projects WHERE project_id = $1`,
      [PRIVATE_PROJECT, MEMBER]
    )

    const writer = new StorageWriter(pool)
    const now = Date.now()
    // 8 conversations over 12 requests; 0, 1 and 3 span both projects
    for (let n = 0; n < 12; n++) {
      await writer.storeRequest({
        requestId: req(n),
        projectId: n % 3 === 0 ? PRIVATE_PROJECT : PROJECT,
        accountId: n % 2 === 0 ? 'convsum-verify-acc-a' : 'convsum-verify-acc-b',
        timestamp: new Date(now - n * 3_600_000),
        method: 'POST',
        path: '/v1/messages',
        headers: {},
        body: { messages: [{ role: 'user', content: 'verify request' }] },
        apiKey: '',
        model: 'claude-test',
        requestType: 'inference',
        conversationId: conv(n % 8),
        parentMessageHash: 'verify-parent',
      })
    }

    // Other suites store requests without StorageWriter or delete them afterwards
    await pool.query('DELETE FROM conversation_summaries')
    await refill()
  })

  afterAll(async () => {
    await cleanUp()
    await pool.end()
  })

  it('finds no mismatch on a consistent table', async () => {
    const lines: string[] = []

    const mismatches = await verifyConversationSummaries(pool, options, line => lines.push(line))

    expect(mismatches).toEqual([])
    expect(lines.some(line => line.startsWith('principal-1:'))).toBe(true)
    expect(lines.some(line => line.startsWith('busiest-project:'))).toBe(true)
    expect(lines.some(line => line.startsWith('busiest-account:'))).toBe(true)
  })

  it('reports a stale row, a missing row and the page they disturb', async () => {
    await pool.query(
      `INSERT INTO conversation_summaries (conversation_id, project_id, first_activity_at, last_activity_at)
       VALUES ($1, $2, now(), now())`,
      [PHANTOM, PROJECT]
    )
    await pool.query('DELETE FROM conversation_summaries WHERE conversation_id = $1', [conv(1)])
    try {
      const mismatches = await verifyConversationSummaries(pool, options, quiet)

      expect(mismatches).toContain(`stale:${PHANTOM}`)
      expect(mismatches).toContain(`missing:${conv(1)}`)
      expect(mismatches.some(mismatch => mismatch.startsWith('pages:anonymous:'))).toBe(true)
    } finally {
      await pool.query('DELETE FROM conversation_summaries WHERE conversation_id = $1', [PHANTOM])
      await refill()
    }
    expect(await verifyConversationSummaries(pool, options, quiet)).toEqual([])
  })

  it('reports a row whose activity differs', async () => {
    await pool.query(
      `UPDATE conversation_summaries SET last_activity_at = last_activity_at - interval '1 day'
       WHERE conversation_id = $1`,
      [conv(2)]
    )
    try {
      expect(await verifyConversationSummaries(pool, options, quiet)).toContain(
        `different:${conv(2)}`
      )
    } finally {
      await refill()
    }
    expect(await verifyConversationSummaries(pool, options, quiet)).toEqual([])
  })

  it('never hands its read-only session back to the pool', async () => {
    const single = new Pool({ connectionString: databaseUrl, max: 1 })
    try {
      expect(await verifyConversationSummaries(single, options, quiet)).toEqual([])
      const { rows } = await single.query('SHOW transaction_read_only')
      expect(rows[0].transaction_read_only).toBe('off')
    } finally {
      await single.end()
    }
  })
})
```

In `package.json`, change the Task 5 line to:

```json
    "test:db:conversation-summaries": "bun test tests/integration/conversation-summaries.db.test.ts tests/integration/verify-conversation-summaries.db.test.ts",
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun --no-env-file test scripts/db/__tests__/verify-conversation-summaries.test.ts
CONVERSATION_SUMMARIES_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run test:db:conversation-summaries
```

Expected: both FAIL — `Cannot find module '../verify-conversation-summaries'` and `Cannot find module '../../scripts/db/verify-conversation-summaries'` (the Task 5 file still passes).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/db/verify-conversation-summaries.ts`:

```ts
#!/usr/bin/env bun

/**
 * Read-only parity check for conversation_summaries (ADR-039) against a real database.
 *
 * In one REPEATABLE READ snapshot of a session it makes read-only, checks that
 * - every (conversation_id, project_id) group of api_requests has a summary row with the same
 *   first and last activity and accounts, and that no summary row lacks requests;
 * - pages 1-3 and the total served from the table equal the request-level listing for anonymous
 *   callers, sampled principals, the busiest project and the busiest account.
 * Conversations with a request stored within --settle-seconds before the snapshot are skipped:
 * their upsert may still be in flight. Prints conversation ids and counts only; exits 1 on any
 * mismatch.
 *
 * Usage: bun scripts/db/verify-conversation-summaries.ts [--principals 3] [--page-size 50]
 *   [--settle-seconds 60]
 */

import { Pool } from 'pg'
import {
  listConversations,
  type ConversationListPool,
} from '../../services/proxy/src/services/conversation-list.js'

export interface VerifyOptions {
  principals: number
  pageSize: number
  settleSeconds: number
}

interface VerifyCase {
  label: string
  principal?: string
  projectId?: string
  accountId?: string
}

/** Pages compared per case */
const PAGES = 3

function parseIntegerOption(
  name: string,
  raw: string | undefined,
  min: number,
  max: number
): number {
  const value = Number(raw)
  if (raw === undefined || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

export function parseVerifyArgs(argv: string[]): VerifyOptions {
  const options: VerifyOptions = { principals: 3, pageSize: 50, settleSeconds: 60 }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--principals':
        options.principals = parseIntegerOption('--principals', argv[++i], 0, 100)
        break
      case '--page-size':
        options.pageSize = parseIntegerOption('--page-size', argv[++i], 1, 500)
        break
      case '--settle-seconds':
        options.settleSeconds = parseIntegerOption('--settle-seconds', argv[++i], 0, 3600)
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  return options
}

/** Groups whose summary row is missing, stale (no requests) or different; $1 snapshot, $2 settle seconds */
const GROUP_MISMATCHES_SQL = `
  WITH grouped AS (
    SELECT conversation_id, project_id,
           MIN(timestamp) AS first_activity_at,
           MAX(timestamp) AS last_activity_at,
           COALESCE(ARRAY_AGG(DISTINCT account_id::text) FILTER (WHERE account_id IS NOT NULL), '{}')
             AS account_ids,
           MAX(created_at) AS stored_at
    FROM api_requests
    WHERE conversation_id IS NOT NULL
    GROUP BY conversation_id, project_id
  )
  SELECT COALESCE(g.conversation_id, cs.conversation_id) AS conversation_id,
         CASE WHEN cs.conversation_id IS NULL THEN 'missing'
              WHEN g.conversation_id IS NULL THEN 'stale'
              ELSE 'different' END AS kind
  FROM grouped g
  FULL JOIN conversation_summaries cs
    ON cs.conversation_id = g.conversation_id AND cs.project_id = g.project_id
  WHERE (g.stored_at IS NULL OR g.stored_at < $1::timestamptz - make_interval(secs => $2::float8))
    AND (cs.conversation_id IS NULL
         OR g.conversation_id IS NULL
         OR cs.first_activity_at <> g.first_activity_at
         OR cs.last_activity_at <> g.last_activity_at
         OR NOT (cs.account_ids @> g.account_ids AND cs.account_ids <@ g.account_ids))
  ORDER BY kind, conversation_id`

/** Conversations with a request stored within the settle margin before the snapshot */
const RECENT_CONVERSATIONS_SQL = `
  SELECT DISTINCT conversation_id
  FROM api_requests
  WHERE conversation_id IS NOT NULL
    AND timestamp >= $1::timestamptz - interval '1 day'
    AND created_at >= $1::timestamptz - make_interval(secs => $2::float8)`

/** Request-level visibility: $1 principal (lower case) or NULL, $2 projectId, $3 accountId */
const REFERENCE_FILTER = `
  ar.conversation_id IS NOT NULL
  AND ($1::text IS NULL OR ar.project_id IN (
    SELECT p.project_id FROM projects p
    WHERE NOT p.is_private
       OR EXISTS (
         SELECT 1 FROM project_members pm
         WHERE pm.project_id = p.id AND LOWER(pm.user_email) = $1
       )
  ))
  AND ($2::text IS NULL OR ar.project_id = $2)
  AND ($3::text IS NULL OR ar.account_id = $3)`

const REFERENCE_IDS_SQL = `
  SELECT ar.conversation_id
  FROM api_requests ar
  WHERE ${REFERENCE_FILTER}
  GROUP BY ar.conversation_id
  ORDER BY MAX(ar.timestamp) DESC, ar.conversation_id DESC
  LIMIT $4`

const REFERENCE_TOTAL_SQL = `
  SELECT COUNT(DISTINCT ar.conversation_id)::int AS total
  FROM api_requests ar
  WHERE ${REFERENCE_FILTER}`

function maskHost(databaseUrl: string): string {
  const host = new URL(databaseUrl).hostname
  return host.length <= 12 ? host : `${host.slice(0, 6)}…${host.slice(-6)}`
}

/** First position where two newest-first ID lists disagree, ignoring in-flight conversations */
function firstDifference(expected: string[], served: string[], recent: Set<string>) {
  const settledExpected = expected.filter(id => !recent.has(id))
  const settledServed = served.filter(id => !recent.has(id))
  const length = Math.min(settledExpected.length, settledServed.length)
  for (let i = 0; i < length; i++) {
    if (settledExpected[i] !== settledServed[i]) {
      return { position: i + 1, expected: settledExpected[i], served: settledServed[i] }
    }
  }
  return undefined
}

export async function verifyConversationSummaries(
  pool: Pool,
  options: VerifyOptions,
  log: (line: string) => void = console.log
): Promise<string[]> {
  const client = await pool.connect()
  const mismatches: string[] = []

  try {
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
    await client.query("SET statement_timeout = '120s'")
    await client.query("SET application_name = 'verify-conversation-summaries'")
    // One snapshot for both tables: only writes committed before it are compared
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    const snapshot: Date = (await client.query('SELECT now() AS snapshot')).rows[0].snapshot
    log(`Snapshot ${snapshot.toISOString()}, settle margin ${options.settleSeconds}s`)

    const counts = (
      await client.query(`
        SELECT (SELECT COUNT(*) FROM conversation_summaries)::int AS summary_rows,
               (SELECT COUNT(DISTINCT conversation_id) FROM conversation_summaries)::int
                 AS summary_conversations,
               (SELECT COUNT(DISTINCT conversation_id) FROM api_requests
                 WHERE conversation_id IS NOT NULL)::int AS request_conversations`)
    ).rows[0]
    log(
      `conversation_summaries: ${counts.summary_rows} rows, ${counts.summary_conversations} conversations; api_requests: ${counts.request_conversations} conversations`
    )

    const groups = await client.query(GROUP_MISMATCHES_SQL, [snapshot, options.settleSeconds])
    for (const row of groups.rows) {
      mismatches.push(`${row.kind}:${row.conversation_id}`)
    }
    const kindCount = (kind: string) => groups.rows.filter(row => row.kind === kind).length
    log(
      `Groups: ${kindCount('missing')} missing, ${kindCount('stale')} stale, ${kindCount('different')} different`
    )

    const recent = new Set<string>(
      (await client.query(RECENT_CONVERSATIONS_SQL, [snapshot, options.settleSeconds])).rows.map(
        (row: { conversation_id: string }) => row.conversation_id
      )
    )

    const principals: string[] = (
      await client.query(
        `SELECT email
         FROM (SELECT DISTINCT LOWER(user_email) AS email FROM project_members) members
         ORDER BY md5(email)
         LIMIT $1`,
        [options.principals]
      )
    ).rows.map((row: { email: string }) => row.email)
    const busiestProject: string | undefined = (
      await client.query(
        `SELECT project_id FROM conversation_summaries
         GROUP BY project_id ORDER BY COUNT(*) DESC, project_id LIMIT 1`
      )
    ).rows[0]?.project_id
    const busiestAccount: string | undefined = (
      await client.query(
        `SELECT account_id
         FROM conversation_summaries CROSS JOIN LATERAL unnest(account_ids) AS account_id
         GROUP BY account_id ORDER BY COUNT(*) DESC, account_id LIMIT 1`
      )
    ).rows[0]?.account_id

    const cases: VerifyCase[] = [
      { label: 'anonymous' },
      ...principals.map((principal, index) => ({ label: `principal-${index + 1}`, principal })),
      ...(busiestProject ? [{ label: 'busiest-project', projectId: busiestProject }] : []),
      ...(busiestAccount ? [{ label: 'busiest-account', accountId: busiestAccount }] : []),
    ]

    for (const testCase of cases) {
      const values = [
        testCase.principal ?? null,
        testCase.projectId ?? null,
        testCase.accountId ?? null,
      ]
      const expected: string[] = (
        await client.query(REFERENCE_IDS_SQL, [...values, PAGES * options.pageSize])
      ).rows.map((row: { conversation_id: string }) => row.conversation_id)
      const expectedTotal: number = (await client.query(REFERENCE_TOTAL_SQL, values)).rows[0].total

      const served: string[] = []
      let servedTotal = 0
      for (let page = 0; page < PAGES; page++) {
        const result = await listConversations(
          client as unknown as ConversationListPool,
          {
            projectId: testCase.projectId,
            accountId: testCase.accountId,
            limit: options.pageSize,
            offset: page * options.pageSize,
          },
          testCase.principal,
          { summaries: true }
        )
        served.push(...result.conversations.map(item => item.conversationId))
        servedTotal = result.pagination.total
      }

      const difference = firstDifference(expected, served, recent)
      if (difference) {
        mismatches.push(
          `pages:${testCase.label}:${difference.position}:${difference.expected}:${difference.served}`
        )
      }
      if (Math.abs(served.length - expected.length) > recent.size) {
        mismatches.push(`length:${testCase.label}:${expected.length}:${served.length}`)
      }
      if (Math.abs(servedTotal - expectedTotal) > recent.size) {
        mismatches.push(`total:${testCase.label}:${expectedTotal}:${servedTotal}`)
      }
      log(
        `${testCase.label}: ${served.length} ids on ${PAGES} pages, total ${servedTotal} (reference ${expectedTotal})`
      )
    }

    await client.query('COMMIT')
  } finally {
    // The session is read-only: never hand it back to a pool
    client.release(true)
  }

  return mismatches
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL environment variable is required')
    process.exit(1)
  }

  let options: VerifyOptions
  try {
    options = parseVerifyArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`)
    process.exit(1)
  }

  console.log(`Target database host: ${maskHost(databaseUrl)}`)
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  let mismatches: string[]
  try {
    mismatches = await verifyConversationSummaries(pool, options)
  } catch (error) {
    console.error('❌ Verification failed:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }

  if (mismatches.length > 0) {
    console.error(
      `❌ ${mismatches.length} mismatches (first 10): ${mismatches.slice(0, 10).join(', ')}`
    )
    process.exit(1)
  }
  console.log('✅ conversation_summaries matches api_requests')
}

if (import.meta.main) {
  main()
}
```

In `scripts/README.md`, insert after the `### backfill-conversation-summaries.ts` section (before `### backup-database.ts`):

```markdown
### verify-conversation-summaries.ts

Read-only parity check for ADR-039, run in one `REPEATABLE READ` snapshot of a session it makes
read-only: every `(conversation_id, project_id)` group of `api_requests` must match its
`conversation_summaries` row (none missing, stale or different), and pages 1-3 and the total
served from the table must equal the request-level listing for anonymous callers, sampled
principals (`--principals`, default 3), the busiest project and the busiest account.
Conversations with a request stored within `--settle-seconds` (default 60) before the snapshot are
skipped, as their upsert may still be in flight. Prints conversation ids and counts only; exits 1
on any mismatch. `bun scripts/db/verify-conversation-summaries.ts --principals 3 --page-size 50`
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun --no-env-file test scripts/db/__tests__/verify-conversation-summaries.test.ts
CONVERSATION_SUMMARIES_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run test:db:conversation-summaries
DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test bun --no-env-file scripts/db/verify-conversation-summaries.ts --principals 3 --page-size 20 --settle-seconds 0
```

Expected: 3 unit tests pass; the DB suites pass — 22 tests, `0 fail`; the CLI (run right after the suites, which leave the table consistent) prints `Target database host: localhost`, the snapshot, counts, `Groups: 0 missing, 0 stale, 0 different`, one line per case, then `✅ conversation_summaries matches api_requests`, exit 0.

Gates:

```bash
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run typecheck
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run test:ci
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bunx prettier --check scripts/db/verify-conversation-summaries.ts scripts/db/__tests__/verify-conversation-summaries.test.ts tests/integration/verify-conversation-summaries.db.test.ts package.json scripts/README.md
grep -nP '[\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]' scripts/db/verify-conversation-summaries.ts scripts/db/__tests__/verify-conversation-summaries.test.ts tests/integration/verify-conversation-summaries.db.test.ts package.json scripts/README.md
```

Expected: typecheck exit 0; `test:ci` passes (lists `verify-conversation-summaries.test.ts`); prettier clean; grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add scripts/db/verify-conversation-summaries.ts scripts/db/__tests__/verify-conversation-summaries.test.ts tests/integration/verify-conversation-summaries.db.test.ts package.json scripts/README.md
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= git commit \
  -m "feat(db): add read-only conversation summaries parity check" \
  -m "Compares every conversation/project group with its summary row and pages 1-3 and totals with the request-level listing in one read-only snapshot; prints ids and counts only (ADR-039)." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: ADR-039 and ADR-038 superseded

**Files:**

- Create: `docs/04-Architecture/ADRs/adr-039-conversation-summaries-table.md`
- Modify: `docs/04-Architecture/ADRs/adr-038-conversation-list-recent-window.md:3-5` (Status)
- Modify: `docs/04-Architecture/ADRs/README.md:72` (ADR-038 row, new ADR-039 row)
- Test: link and status check (shell)

**Interfaces:**

- Consumes: the decisions implemented in Tasks 1–7.
- Produces: ADR-039 (Accepted, 2026-09-25); ADR-038 marked superseded.

- [ ] **Step 1: Write the failing check**

```bash
test -f docs/04-Architecture/ADRs/adr-039-conversation-summaries-table.md \
  && grep -q 'Superseded by \[ADR-039\]' docs/04-Architecture/ADRs/adr-038-conversation-list-recent-window.md \
  && grep -q 'adr-039-conversation-summaries-table.md' docs/04-Architecture/ADRs/README.md \
  && echo OK
```

- [ ] **Step 2: Run it to verify it fails**

Run the Step 1 command.

Expected: prints nothing and exits 1 (ADR-039 does not exist).

- [ ] **Step 3: Write the ADRs**

Create `docs/04-Architecture/ADRs/adr-039-conversation-summaries-table.md`:

```markdown
# ADR-039: Conversation Summaries Table

## Status

Accepted (2026-09-25). Supersedes [ADR-038](./adr-038-conversation-list-recent-window.md).

## Context

`GET /api/conversations` serves the dashboard landing page. ADR-038 selects page IDs from a 7-day
window and totals a live 7-day count plus an older-conversation count cached for one hour per
principal and filters. Uncached loads dropped from 1.6-6.9 s to 0.4-0.6 s, but the first load per
key each hour, and every load after a proxy restart, still runs an exact
`COUNT(DISTINCT conversation_id)` over the full history (about 1.7 s warm, 6-7 s cold), and the
total can drift by up to an hour of activity. Production holds about 283,000 conversations over
1.5 million requests; 15 conversations span more than one project and 8.6% use more than one
account.

## Decision Drivers

- Every call without explicit dates under 0.5 s, cold or warm
- Page IDs, their order and the total identical to the request-level listing
- Maintaining the summary never costs or delays storing a request beyond one round trip
- Explicit `dateFrom`/`dateTo` requests and the flag-off path unchanged

## Considered Options

1. **Write-maintained `conversation_summaries` table**, one row per conversation and project.
   - Pros: page selection and totals are index lookups; exact.
   - Cons: an upsert per stored request, a migration and a backfill.
2. **Keep ADR-038 with a longer or pre-warmed older-count cache.**
   - Cons: still a full-history count per key and per restart; more drift.
3. **Materialized view refreshed on a schedule.**
   - Cons: a full recompute per refresh (grouping the history takes about 6 s); stale in between.
4. **Per-conversation rollups (counts, tokens, branches) in the table as well.**
   - Pros: would also remove the details query.
   - Cons: far more write-path logic for a query already bounded to one page.

## Decision

Option 1.

- **Schema** (migration 027): `conversation_summaries (conversation_id, project_id, first_activity_at, last_activity_at, account_ids)` with primary key `(conversation_id, project_id)`, btree indexes on `(last_activity_at DESC, conversation_id DESC)` and `(project_id, last_activity_at DESC, conversation_id DESC)`, and a GIN index on `account_ids`. One row per project keeps the privacy rule of ADR-029: a conversation is listed when any of its projects is accessible, ordered by its activity in those projects, and its details still come only from accessible requests.
- **Write path**: after `StorageWriter.storeRequest` has stored a request row with a `conversation_id`, one awaited upsert keeps the earliest first activity, the latest last activity (the request's own `timestamp`) and the union of accounts; updates that would change nothing are skipped. The merge is order-independent and idempotent, so live writes, retries and the backfill converge in any order. Upsert errors are logged and never fail the request; a missing table is detected once per writer and logged once.
- **Backfill and reconcile**: `scripts/db/backfill-conversation-summaries.ts` upserts one grouped statement per 7-day chunk of `api_requests` (or since `--since`) with the same merge rules. Dry-run by default, safe while the proxy writes and safe to re-run.
- **Read path**: with `CONVERSATION_SUMMARIES_ENABLED=true` and no `dateFrom`/`dateTo`, the caller's accessible projects are resolved first and intersected with `projectId`. Page IDs are read newest first with `LIMIT offset + limit + 32`, de-duplicated per conversation (keeping its newest row) and re-read with a doubled limit when duplicates exceed that slack; the total is an exact `COUNT(DISTINCT conversation_id)` over the same rows. With an `accountId` filter the page IDs keep ADR-038's request-level selection, because a row's `last_activity_at` covers every account while the list orders by the filtered account's own last request; the total still comes from the table. Details, the response shape and the 15 s response cache are unchanged.
- **Rollout**: apply the migration, deploy with the flag off (the table starts being maintained), run the backfill, check with `scripts/db/verify-conversation-summaries.ts` (read-only), then enable the flag. Rollback: set it back to `false`.

## Consequences

- Positive: every call without explicit dates selects its page and counts its total with index lookups on a small table, cold or warm, and the total is exact.
- Negative: one extra round trip per stored request with a conversation; concurrent requests in one conversation (parallel sub-agents) briefly serialize on its row; about 30-50 MB of table and indexes.
- Account-filtered pages still select their IDs from `api_requests` (the ADR-038 cost).
- The table only gains and widens rows. Requests inserted outside the proxy (SQL seeds, `copy-conversation.ts`) are missing until the backfill runs again; requests re-keyed or deleted outside it (for example by `rebuild-conversations.ts`) leave stale rows that only a rebuild removes: turn the flag off, `TRUNCATE conversation_summaries`, re-run the backfill with `--execute` and verify before turning it back on.
- The ADR-038 window path and the flag stay until a follow-up removes them, once production has run with the flag on.

## Links

- [ADR-038: Conversation List Recent Window](./adr-038-conversation-list-recent-window.md)
- [ADR-029: Project Privacy Model](./adr-029-project-privacy-model.md)
- [Database Schema: conversation_summaries](../../03-Operations/database.md#conversation_summaries)
- [API Reference: List Conversations](../../02-User-Guide/api-reference.md#list-conversations)
- [Environment Variables](../../06-Reference/environment-vars.md)
- [Scripts: backfill and verify](../../../scripts/README.md)
```

In `docs/04-Architecture/ADRs/adr-038-conversation-list-recent-window.md`, replace the Status body (line 5, `Accepted (2026-09-25)`) with:

```markdown
Superseded by [ADR-039](./adr-039-conversation-summaries-table.md) (2026-09-25); originally Accepted (2026-09-25). The recent-window path remains the default until `CONVERSATION_SUMMARIES_ENABLED` is removed.
```

In `docs/04-Architecture/ADRs/README.md`, change the ADR-038 row's status to `Superseded` and add a row after it:

```markdown
| [ADR-038](./adr-038-conversation-list-recent-window.md) | Conversation List Recent Window | Superseded | 2026-09-25 |
| [ADR-039](./adr-039-conversation-summaries-table.md) | Conversation Summaries Table | Accepted | 2026-09-25 |
```

- [ ] **Step 4: Run the check to verify it passes**

```bash
test -f docs/04-Architecture/ADRs/adr-039-conversation-summaries-table.md \
  && grep -q 'Superseded by \[ADR-039\]' docs/04-Architecture/ADRs/adr-038-conversation-list-recent-window.md \
  && grep -q 'adr-039-conversation-summaries-table.md' docs/04-Architecture/ADRs/README.md \
  && echo OK
(cd docs/04-Architecture/ADRs && grep -oE '\]\(\.{1,2}/[^)#]+' adr-039-conversation-summaries-table.md adr-038-conversation-list-recent-window.md | sed 's/^[^:]*:](//' | while read -r target; do test -e "$target" || echo "broken: $target"; done)
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bunx prettier --check docs/04-Architecture/ADRs/adr-039-conversation-summaries-table.md docs/04-Architecture/ADRs/adr-038-conversation-list-recent-window.md docs/04-Architecture/ADRs/README.md
grep -nP '[\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]' docs/04-Architecture/ADRs/adr-039-conversation-summaries-table.md docs/04-Architecture/ADRs/adr-038-conversation-list-recent-window.md docs/04-Architecture/ADRs/README.md
```

Expected: `OK`; the link loop prints nothing (every relative link resolves); prettier clean (run `bunx prettier --write` with the same prefix if the README table needs realigning); grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add docs/04-Architecture/ADRs/adr-039-conversation-summaries-table.md docs/04-Architecture/ADRs/adr-038-conversation-list-recent-window.md docs/04-Architecture/ADRs/README.md
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= git commit \
  -m "docs(adr): add ADR-039 conversation summaries table, supersede ADR-038" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Final gates (no production)

**Files:** none new (fixes only if a gate fails).

**Interfaces:**

- Consumes: the whole branch (`origin/main...HEAD`).
- Produces: a green branch ready for the controller to finish (push, PR and every production rollout step are outside this plan).

- [ ] **Step 1: Static gates**

```bash
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run typecheck
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run lint 2>&1 | grep -oE '[0-9]+ errors, [0-9]+ warnings' | awk '{e+=$1; w+=$3} END {print e" errors, "w" warnings"}'
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bunx prettier --check $(git diff --name-only origin/main...HEAD)
grep -nP '[\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]' $(git diff --name-only origin/main...HEAD)
git diff --stat origin/main...HEAD -- services/proxy/src/routes/api.ts services/proxy/tests/conversation-list.test.ts services/proxy/tests/storage-writer-summary.test.ts tests/integration/conversation-list.db.test.ts
```

Expected: typecheck exit 0; `0 errors, 245 warnings` or fewer; prettier `All matched files use Prettier code style!`; the grep prints nothing; the last command prints nothing (route and #213 tests untouched).

- [ ] **Step 2: Unit and integration suites (local database only)**

```bash
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run test:ci
SUMMARY_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run test:db:summary
CONVERSATION_LIST_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run test:db:conversations
CONVERSATION_SUMMARIES_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run test:db:conversation-summaries
```

Expected: all pass. The `test:ci` output lists `storage-writer-conversation-summary.test.ts`, `conversation-list-summaries.test.ts`, `backfill-conversation-summaries.test.ts` and `verify-conversation-summaries.test.ts`; `test:db:conversation-summaries` reports 22 tests, `0 fail`.

- [ ] **Step 3: E2E smoke and journeys, flag on and off, fresh database each**

```bash
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= bun run build
docker exec perf03-pg dropdb -U postgres --if-exists perf03_e2e_test
docker exec perf03-pg createdb -U postgres perf03_e2e_test
E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_e2e_test bun --no-env-file scripts/e2e/setup-database.ts
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= CONVERSATION_SUMMARIES_ENABLED=true TEST_START_SERVERS=true \
  E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_e2e_test DASHBOARD_API_KEY=e2e-local-key \
  bunx playwright test --grep "@smoke|@journey" --project=chromium
docker exec perf03-pg dropdb -U postgres --if-exists perf03_e2e_test
docker exec perf03-pg createdb -U postgres perf03_e2e_test
E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_e2e_test bun --no-env-file scripts/e2e/setup-database.ts
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= TEST_START_SERVERS=true \
  E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_e2e_test DASHBOARD_API_KEY=e2e-local-key \
  bunx playwright test --grep "@smoke|@journey" --project=chromium
```

Expected: both Playwright runs pass, `0 failed`.

- [ ] **Step 4: Independent code review**

Use superpowers:requesting-code-review on `origin/main...HEAD`, giving the reviewer the spec, this plan and the Review Focus list. Fix every Critical and Important finding in the owning file, each with a test that fails before the fix, then re-run Steps 1–2 (and Step 3 when a fix touches the reader, the writer or the E2E setup). Expected: no unresolved Critical or Important findings.

- [ ] **Step 5: Commit fixes**

Only if Step 4 changed files:

```bash
git status --short
git add <each fixed file, listed explicitly>
DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked_test DB_HOST= git commit \
  -m "fix(proxy): address review findings for conversation summaries" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git status --short
```

Expected: the final `git status --short` shows only the pre-existing untracked files (`.agents/`, `output-pre-compact.json`, `output.json`, `scripts/export-compaction-requests.sh`, `services/proxy/sync-info.json`, `skills-lock.json`, `sync-info.json`). Hand the branch back to the controller; no push, PR or production step happens in this plan.
