# Conversation Detail Performance (PERF-03) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/dashboard/conversation/:id` fast for long conversations by precomputing a small last-message summary at write time, removing full-body transfers from the read path, batching sub-task lookups and lazy-loading the timeline.

**Architecture:** A shared pure module (`packages/shared/src/utils/message-summary.ts`) produces a truncated copy of a request's last message and a user-text-message count. The proxy stores both in two new nullable `api_requests` columns at INSERT time. The dashboard reader prefers the stored columns and falls back to today's body extraction only for legacy rows; a throttled backfill script fills the last 90 days. The conversation route batches sub-task lookups and renders the timeline only when it is the active tab (otherwise htmx lazy-loads it from the existing `/messages` route, which shares one builder with the page).

**Tech Stack:** Bun 1.3, TypeScript, Hono + `hono/html`, htmx 1.9, node-postgres (`pg`), PostgreSQL 16 (Aurora in production), `bun:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-24-perf-03-conversation-detail-design.md`

## Global Constraints

- Branch: `perf/conversation-detail-summary` (already created; the spec is committed on it).
- Bun only — never Node/npm. New files use `kebab-case`; code uses `camelCase`; DB columns and JSON fields use `snake_case`.
- Columns: `last_message_summary JSONB` and `user_text_message_count INTEGER`, nullable, no default, no index.
- Migration file: `scripts/db/migrations/026-add-last-message-summary.ts`; idempotent (`ADD COLUMN IF NOT EXISTS`); `lock_timeout = '5s'`.
- Truncation: `SUMMARY_TEXT_LIMIT = 200` characters per text-like field; text is trimmed **before** slicing; non-empty whitespace-only text becomes a single space `' '`.
- Backfill defaults: dry-run unless `--execute`; `--days 90`; `--batch-size 200`; `--sleep-ms 250`; session `statement_timeout = '120s'`, `lock_timeout = '5s'`, `application_name = 'backfill-last-message-summary'`.
- ADR number: `adr-037-precomputed-last-message-summary.md`.
- **Never write to the production database.** The only production access allowed is read-only through the sandbox in Task 9 (`default_transaction_read_only=on`). Never run the backfill with `--execute` against production — that is a human step after deploy.
- Local database for integration/E2E: Docker `postgres:16`, databases whose names end in `_test`.
- The repository is public: commit messages, docs and the PR description must not contain security findings.
- Commits follow Conventional Commits and end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Rendered output (tree node types, metrics, previews, timeline) must stay identical for the same data.
- Source files must contain Unicode whitespace only as `\uXXXX` escapes, never as raw characters (some editing tools decode escapes on write). After writing any file that uses such escapes, this must print nothing: `grep -nP '[\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]' <file>`.

## Review Focus

1. **Conversations that mix summarised and legacy rows** (started before deploy, continued after) must render the same node types, previews and metrics as if every row were legacy → pinned by Task 8 "mixed conversation parity".
2. **Last messages carrying huge or binary payloads** (base64 images, 1 MB tool results, 20 parallel tool results) must produce small summaries and never copy the payload → pinned by Task 1 "stays small for huge messages" and "drops payloads".
3. **Whitespace-only and Unicode-whitespace text** (NBSP, ideographic space, BOM) must give the same visible-text decision in JS (writer), SQL (reader fallback/backfill) and the dashboard → pinned by Task 1 `hasVisibleText` cases and Task 8 "SQL count equals JS count".
4. **Branch names needing URL encoding** (`&`, `"`) in the lazy timeline URL must be encoded, not break the attribute → pinned by Task 6 "encodes the selected branch".
5. **Malformed or hostile request bodies** (missing `messages`, non-array content, throwing getters) must never block or fail the request INSERT → pinned by Task 3 "never throws on hostile input" and the writer INSERT test.

---

### Task 1: Shared message-summary module

**Files:**

- Create: `packages/shared/src/utils/message-summary.ts`
- Modify: `packages/shared/src/index.ts` (add one export line after line 11)
- Test: `packages/shared/src/utils/__tests__/message-summary.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces (exported from `@agent-prompttrain/shared`):
  - `SUMMARY_TEXT_LIMIT: 200`
  - `interface SummaryBlock { type: string; text?: string; id?: string; name?: string; input?: { prompt: string }; tool_use_id?: string; is_error?: boolean; content?: string }`
  - `interface LastMessageSummary { role: string; content?: string | SummaryBlock[] | null }`
  - `summarizeLastMessage(message: unknown): LastMessageSummary | null`
  - `hasVisibleText(message: any): boolean`
  - `countUserTextMessages(messages: unknown): number | null`
  - `userTextMessageCountSql(bodyExpr?: string): string` — SQL expression yielding `int` or `NULL` when `bodyExpr -> 'messages'` is not an array.

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/utils/__tests__/message-summary.test.ts`:

```ts
import { describe, it, expect } from 'bun:test'
import {
  SUMMARY_TEXT_LIMIT,
  summarizeLastMessage,
  hasVisibleText,
  countUserTextMessages,
  userTextMessageCountSql,
} from '../message-summary'

describe('summarizeLastMessage', () => {
  it('returns null for missing or non-object messages', () => {
    expect(summarizeLastMessage(undefined)).toBeNull()
    expect(summarizeLastMessage(null)).toBeNull()
    expect(summarizeLastMessage('hello')).toBeNull()
  })

  it('trims then clips string content', () => {
    const long = '  ' + 'a'.repeat(500) + '  '
    expect(summarizeLastMessage({ role: 'user', content: long })).toEqual({
      role: 'user',
      content: 'a'.repeat(SUMMARY_TEXT_LIMIT),
    })
  })

  it('keeps whitespace-only content truthy but blank', () => {
    expect(summarizeLastMessage({ role: 'user', content: ' \n\t ' })).toEqual({
      role: 'user',
      content: ' ',
    })
    expect(summarizeLastMessage({ role: 'user', content: '' })).toEqual({
      role: 'user',
      content: '',
    })
  })

  it('summarizes text blocks with the same trimming rule', () => {
    expect(
      summarizeLastMessage({
        role: 'user',
        content: [
          { type: 'text', text: '  hello  ' },
          { type: 'text', text: '   ' },
          { type: 'text', text: 'x'.repeat(300) },
          { type: 'text' },
        ],
      })
    ).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'x'.repeat(SUMMARY_TEXT_LIMIT) },
        { type: 'text' },
      ],
    })
  })

  it('keeps tool_result identity, error flag and a clipped content preview', () => {
    const arrayContent = [{ type: 'text', text: 'y'.repeat(400) }]
    expect(
      summarizeLastMessage({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'z'.repeat(1000) },
          { type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: arrayContent },
          { type: 'tool_result', tool_use_id: 'toolu_3', content: '' },
        ],
      })
    ).toStrictEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'z'.repeat(SUMMARY_TEXT_LIMIT) },
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          is_error: true,
          content: JSON.stringify(arrayContent).slice(0, SUMMARY_TEXT_LIMIT),
        },
        { type: 'tool_result', tool_use_id: 'toolu_3' },
      ],
    })
  })

  it('keeps tool_use name and a clipped prompt only', () => {
    expect(
      summarizeLastMessage({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_9',
            name: 'Task',
            input: { prompt: 'p'.repeat(300), description: 'd' },
          },
          { type: 'tool_use', id: 'toolu_8', name: 'Bash', input: { command: 'ls' } },
        ],
      })
    ).toStrictEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_9',
          name: 'Task',
          input: { prompt: 'p'.repeat(SUMMARY_TEXT_LIMIT) },
        },
        { type: 'tool_use', id: 'toolu_8', name: 'Bash' },
      ],
    })
  })

  it('drops payloads of images, documents and unknown blocks', () => {
    expect(
      summarizeLastMessage({
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', data: 'A'.repeat(2_000_000) } },
          { type: 'document', source: { data: 'B'.repeat(10) } },
          { type: 'thinking', thinking: 'internal' },
          null,
          42,
        ],
      })
    ).toStrictEqual({
      role: 'user',
      content: [{ type: 'image' }, { type: 'document' }, { type: 'thinking' }],
    })
  })

  it('stays small for huge messages', () => {
    const blocks = Array.from({ length: 20 }, (_, i) => ({
      type: 'tool_result',
      tool_use_id: `toolu_${i}`,
      content: 'q'.repeat(1_000_000),
    }))
    const json = JSON.stringify(summarizeLastMessage({ role: 'user', content: blocks }))
    expect(json.length).toBeLessThan(20 * 300)
  })

  it('maps non-string, non-array content to null and keeps missing content missing', () => {
    expect(summarizeLastMessage({ role: 'user', content: 12345 })).toEqual({
      role: 'user',
      content: null,
    })
    expect(summarizeLastMessage({ role: 'user' })).toStrictEqual({ role: 'user' })
  })
})

describe('hasVisibleText', () => {
  it('matches the dashboard visible-text rule', () => {
    expect(hasVisibleText({ role: 'user', content: 'hi' })).toBe(true)
    expect(hasVisibleText({ role: 'user', content: '   ' })).toBe(false)
    expect(hasVisibleText({ role: 'user', content: [{ type: 'tool_result', content: 'x' }] })).toBe(
      false
    )
    expect(hasVisibleText({ role: 'user', content: [{ type: 'text', text: ' ok ' }] })).toBe(true)
    expect(
      hasVisibleText({
        role: 'user',
        content: [{ type: 'text', text: '\u00a0\u3000\ufeff\u2028' }],
      })
    ).toBe(false)
    expect(hasVisibleText(null)).toBe(false)
  })
})

describe('countUserTextMessages', () => {
  it('counts user messages with visible text', () => {
    expect(
      countUserTextMessages([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' }] },
        { role: 'user', content: [{ type: 'text', text: 'c' }] },
        null,
      ])
    ).toBe(2)
    expect(countUserTextMessages([])).toBe(0)
  })

  it('returns null when messages is not an array', () => {
    expect(countUserTextMessages(undefined)).toBeNull()
    expect(countUserTextMessages({})).toBeNull()
  })
})

describe('userTextMessageCountSql', () => {
  it('uses the given body expression and guards non-array messages', () => {
    const sql = userTextMessageCountSql('ar.body')
    expect(sql).toContain("jsonb_typeof(ar.body -> 'messages') = 'array'")
    expect(sql).toContain("jsonb_array_elements(ar.body -> 'messages')")
    expect(userTextMessageCountSql()).toContain("jsonb_typeof(body -> 'messages') = 'array'")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/shared/src/utils/__tests__/message-summary.test.ts`
Expected: FAIL — `Cannot find module '../message-summary'`.

- [ ] **Step 3: Implement the module**

Create `packages/shared/src/utils/message-summary.ts`:

```ts
/**
 * Compact summaries of Claude messages, computed when a request is stored so
 * read paths never decompress full request bodies (ADR-037).
 */

/** Characters kept per text-like field. Must stay above 81 so every downstream length decision is unchanged. */
export const SUMMARY_TEXT_LIMIT = 200

export interface SummaryBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: { prompt: string }
  tool_use_id?: string
  is_error?: boolean
  content?: string
}

export interface LastMessageSummary {
  role: string
  content?: string | SummaryBlock[] | null
}

/**
 * Trim, then clip. Non-empty whitespace-only text becomes a single space so
 * truthiness checks downstream see the same value as with the original text.
 */
function clipText(value: string): string {
  const clipped = value.trim().slice(0, SUMMARY_TEXT_LIMIT)
  return clipped.length > 0 || value.length === 0 ? clipped : ' '
}

function summarizeBlock(block: any): SummaryBlock | null {
  if (!block || typeof block !== 'object' || typeof block.type !== 'string') {
    return null
  }

  switch (block.type) {
    case 'text':
      return typeof block.text === 'string'
        ? { type: 'text', text: clipText(block.text) }
        : { type: 'text' }
    case 'tool_result': {
      const summary: SummaryBlock = { type: 'tool_result' }
      if (block.tool_use_id !== undefined) {
        summary.tool_use_id = block.tool_use_id
      }
      if (block.is_error !== undefined) {
        summary.is_error = block.is_error
      }
      if (block.content) {
        const source =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
        summary.content = source.slice(0, SUMMARY_TEXT_LIMIT)
      }
      return summary
    }
    case 'tool_use': {
      const summary: SummaryBlock = { type: 'tool_use', id: block.id, name: block.name }
      const prompt = block.input?.prompt
      if (typeof prompt === 'string' && prompt.length > 0) {
        summary.input = { prompt: prompt.slice(0, SUMMARY_TEXT_LIMIT) }
      }
      return summary
    }
    default:
      // Images, documents and unknown blocks keep only their type - never their payload
      return { type: block.type }
  }
}

/**
 * Truncated copy of a message in the same shape as the original, so existing
 * consumers (tree node types, previews, tool metrics) work unchanged.
 */
export function summarizeLastMessage(message: unknown): LastMessageSummary | null {
  if (!message || typeof message !== 'object') {
    return null
  }

  const { role, content } = message as { role?: string; content?: unknown }
  const summary: LastMessageSummary = { role: role as string }

  if (typeof content === 'string') {
    summary.content = clipText(content)
  } else if (Array.isArray(content)) {
    summary.content = content
      .map(summarizeBlock)
      .filter((block): block is SummaryBlock => block !== null)
  } else if (content !== undefined) {
    summary.content = null
  }

  return summary
}

/** A message has visible text when it carries non-whitespace string content or text blocks. */
export function hasVisibleText(message: any): boolean {
  if (!message?.content) {
    return false
  }

  if (typeof message.content === 'string') {
    return message.content.trim().length > 0
  }

  return (
    Array.isArray(message.content) &&
    message.content.some(
      (item: any) =>
        item?.type === 'text' && typeof item.text === 'string' && item.text.trim().length > 0
    )
  )
}

/** Number of user messages with visible text, or null when there is no messages array. */
export function countUserTextMessages(messages: unknown): number | null {
  if (!Array.isArray(messages)) {
    return null
  }

  let count = 0
  for (const message of messages) {
    if (message?.role === 'user' && hasVisibleText(message)) {
      count++
    }
  }
  return count
}

/** Characters removed by String.prototype.trim(), as a regex bracket body. */
const JS_TRIM_WHITESPACE = String.raw`\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff`

/**
 * SQL equivalent of countUserTextMessages over `<bodyExpr> -> 'messages'`.
 * Yields NULL when messages is not an array. Requires standard_conforming_strings (the default).
 */
export function userTextMessageCountSql(bodyExpr = 'body'): string {
  const visible = `'[^${JS_TRIM_WHITESPACE}]'`
  return `(CASE WHEN jsonb_typeof(${bodyExpr} -> 'messages') = 'array' THEN (
    SELECT count(*)::int
    FROM jsonb_array_elements(${bodyExpr} -> 'messages') AS m(msg)
    WHERE msg ->> 'role' = 'user'
      AND (
        (jsonb_typeof(msg -> 'content') = 'string' AND (msg ->> 'content') ~ ${visible})
        OR (
          jsonb_typeof(msg -> 'content') = 'array'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(msg -> 'content') AS b(block)
            WHERE block ->> 'type' = 'text'
              AND jsonb_typeof(block -> 'text') = 'string'
              AND (block ->> 'text') ~ ${visible}
          )
        )
      )
  ) END)`
}
```

Add to `packages/shared/src/index.ts` after `export * from './utils/auth.js'` (line 11):

```ts
export * from './utils/message-summary.js'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/shared/src/utils/__tests__/message-summary.test.ts`
Expected: PASS (all tests).

Run: `grep -rn "hasVisibleText\|summarizeLastMessage" packages/shared/src --include=*.ts | grep -v __tests__`
Expected: only `packages/shared/src/utils/message-summary.ts` (no name collision in the shared barrel).

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/utils/message-summary.ts packages/shared/src/utils/__tests__/message-summary.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add last-message summary helpers

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Migration 026, local test database, ADR and schema docs

**Files:**

- Create: `scripts/db/migrations/026-add-last-message-summary.ts`
- Create: `docs/04-Architecture/ADRs/adr-037-precomputed-last-message-summary.md`
- Modify: `docs/04-Architecture/ADRs/README.md` (add a row after the ADR-036 rows, ~line 70)
- Modify: `docs/03-Operations/database.md` (add two rows to the `api_requests` table after `task_tool_invocation`, ~line 47)

**Interfaces:**

- Consumes: nothing.
- Produces: columns `api_requests.last_message_summary JSONB`, `api_requests.user_text_message_count INTEGER`; a local Docker database `perf03_test` (URL `postgresql://postgres:postgres@localhost:55432/perf03_test`) with the full schema, used by Tasks 5–8.

- [ ] **Step 1: Start a local Postgres and create the test database**

```bash
docker run -d --name perf03-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16
until docker exec perf03-pg pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
docker exec perf03-pg createdb -U postgres perf03_test
E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test bun scripts/e2e/setup-database.ts
```

Expected: setup prints `Applying 012-…` through `Applying 025-…` and exits 0.

- [ ] **Step 2: Verify the columns do not exist yet (failing check)**

```bash
docker exec perf03-pg psql -U postgres -d perf03_test -Atc \
  "SELECT count(*) FROM information_schema.columns WHERE table_name='api_requests' AND column_name IN ('last_message_summary','user_text_message_count')"
```

Expected: `0`.

- [ ] **Step 3: Write the migration**

Create `scripts/db/migrations/026-add-last-message-summary.ts`:

```ts
#!/usr/bin/env bun

/**
 * Migration: Add precomputed last-message summary columns to api_requests (ADR-037)
 *
 * last_message_summary holds a truncated copy of each request's last message and
 * user_text_message_count the number of user messages with visible text, so the
 * dashboard can render conversations without decompressing full request bodies.
 * Both columns are nullable without defaults, which makes this a metadata-only change.
 */

import { Pool } from 'pg'

async function up(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    // Never queue behind long-running queries on this very large table
    await client.query("SET LOCAL lock_timeout = '5s'")

    console.log('Adding last-message summary columns to api_requests...')

    await client.query(`
      ALTER TABLE api_requests
        ADD COLUMN IF NOT EXISTS last_message_summary JSONB,
        ADD COLUMN IF NOT EXISTS user_text_message_count INTEGER
    `)
    console.log('✓ Added summary columns')

    const result = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'api_requests'
        AND column_name IN ('last_message_summary', 'user_text_message_count')
    `)

    if (result.rows.length !== 2) {
      throw new Error('Verification failed: summary columns not found on api_requests')
    }

    console.log('✓ Verified columns exist')

    await client.query('COMMIT')
    console.log('✅ Last-message summary columns added successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to add last-message summary columns:', error)
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

    console.log('Removing last-message summary columns from api_requests...')

    await client.query(`
      ALTER TABLE api_requests
        DROP COLUMN IF EXISTS last_message_summary,
        DROP COLUMN IF EXISTS user_text_message_count
    `)

    await client.query('COMMIT')
    console.log('✅ Last-message summary columns removed successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to remove last-message summary columns:', error)
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

- [ ] **Step 4: Apply it twice, then down and up (idempotency)**

```bash
export LOCAL_TEST_DB=postgresql://postgres:postgres@localhost:55432/perf03_test
DATABASE_URL=$LOCAL_TEST_DB bun scripts/db/migrations/026-add-last-message-summary.ts up
DATABASE_URL=$LOCAL_TEST_DB bun scripts/db/migrations/026-add-last-message-summary.ts up
DATABASE_URL=$LOCAL_TEST_DB bun scripts/db/migrations/026-add-last-message-summary.ts down
DATABASE_URL=$LOCAL_TEST_DB bun scripts/db/migrations/026-add-last-message-summary.ts up
docker exec perf03-pg psql -U postgres -d perf03_test -Atc \
  "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name='api_requests' AND column_name IN ('last_message_summary','user_text_message_count') ORDER BY 1"
```

Expected: every run prints `✅`; final query prints
`last_message_summary|jsonb|YES|` and `user_text_message_count|integer|YES|`.

(Note: DATABASE_URL is set inline for each command, so `.env`'s value is never used.)

- [ ] **Step 5: Write the ADR and docs**

Create `docs/04-Architecture/ADRs/adr-037-precomputed-last-message-summary.md`:

```markdown
# ADR-037: Precomputed Last-Message Summary

## Status

Accepted (2026-09-24)

## Context

The conversation detail page derives node types, previews, tool-execution metrics and a
user-interaction count from each request's last message. It extracted that message with
`body -> 'messages' -> -1`, and PostgreSQL cannot read part of a TOASTed JSONB value, so every
view decompressed every stored body in the conversation (hundreds of MB to GB for long
Claude Code sessions, 8–9 s for a 641-request conversation).

## Decision Drivers

- Page cost must not grow with stored body size
- Rendered output must stay identical
- No table rewrite or long lock on `api_requests`
- History must be fillable without a production outage

## Considered Options

1. **Columns on `api_requests`** — two nullable columns filled at INSERT time.
   - Pros: no join, same shape as the old `last_message` field, metadata-only migration.
   - Cons: backfill updates are mostly non-HOT on a heavily indexed table.
2. **Side table keyed by `request_id`** — cheap backfill inserts.
   - Cons: a second write per request and another table to keep consistent.
3. **Typed scalar columns** (role, preview, tool-result ids/flags, count).
   - Cons: every consumer must change shape; highest risk to identical output.

## Decision

Option 1. The proxy stores `last_message_summary` (a truncated copy of the last message: text
trimmed and clipped to 200 characters per block, tool-result ids/error flags, tool-use names,
no binary payloads) and `user_text_message_count` in the same INSERT. The logic lives in
`packages/shared/src/utils/message-summary.ts`, with a SQL twin (`userTextMessageCountSql`)
used by the dashboard fallback and the backfill. Readers prefer the stored columns and fall
back to body extraction only for rows without a summary. `scripts/db/backfill-last-message-summary.ts`
fills recent history (default 90 days), dry-run by default.

## Consequences

- Positive: the conversation page reads only small columns for summarised rows.
- Negative: summaries duplicate a small, truncated part of each body (~0.2–2 KB per row).
- Deployment order: migration 026 → proxy and dashboard → backfill.
- Summary failures store NULL and never block the request INSERT.
```

Add to the table in `docs/04-Architecture/ADRs/README.md` (after the last ADR-036 row):

```markdown
| [ADR-037](./adr-037-precomputed-last-message-summary.md) | Precomputed Last-Message Summary | Accepted | 2026-09-24 |
```

Add to the `api_requests` table in `docs/03-Operations/database.md`, after the `task_tool_invocation` row:

```markdown
| last_message_summary | JSONB | Truncated copy of the request's last message (ADR-037) |
| user_text_message_count | INTEGER | User messages with visible text in the request (ADR-037) |
```

Run: `bunx prettier --write docs/04-Architecture/ADRs/adr-037-precomputed-last-message-summary.md docs/04-Architecture/ADRs/README.md docs/03-Operations/database.md`

- [ ] **Step 6: Commit**

```bash
git add scripts/db/migrations/026-add-last-message-summary.ts docs/04-Architecture/ADRs/adr-037-precomputed-last-message-summary.md docs/04-Architecture/ADRs/README.md docs/03-Operations/database.md
git commit -m "feat(db): add last-message summary columns to api_requests (ADR-037)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Proxy stores the summary at write time

**Files:**

- Create: `services/proxy/src/storage/summary-columns.ts`
- Modify: `services/proxy/src/storage/writer.ts` (imports at top; INSERT at lines ~128–161)
- Test: `services/proxy/tests/summary-columns.test.ts`
- Test: `services/proxy/tests/storage-writer-summary.test.ts`

**Interfaces:**

- Consumes: `summarizeLastMessage`, `countUserTextMessages`, `getErrorMessage` from `@agent-prompttrain/shared` (Task 1).
- Produces: `buildSummaryColumns(body: unknown): SummaryColumns` with `interface SummaryColumns { lastMessageSummary: string | null; userTextMessageCount: number | null }`; the INSERT in `StorageWriter.storeRequest` writes `$22 = last_message_summary`, `$23 = user_text_message_count`.

- [ ] **Step 1: Write the failing tests**

Create `services/proxy/tests/summary-columns.test.ts`:

```ts
import { describe, it, expect } from 'bun:test'
import { buildSummaryColumns } from '../src/storage/summary-columns'

describe('buildSummaryColumns', () => {
  it('summarizes the last message and counts user text messages', () => {
    const columns = buildSummaryColumns({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }],
        },
      ],
    })

    expect(JSON.parse(columns.lastMessageSummary!)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }],
    })
    expect(columns.userTextMessageCount).toBe(1)
  })

  it('returns nulls when there is nothing to summarize', () => {
    expect(buildSummaryColumns({})).toEqual({
      lastMessageSummary: null,
      userTextMessageCount: null,
    })
    expect(buildSummaryColumns(undefined)).toEqual({
      lastMessageSummary: null,
      userTextMessageCount: null,
    })
    expect(buildSummaryColumns({ messages: [] })).toEqual({
      lastMessageSummary: null,
      userTextMessageCount: 0,
    })
  })

  it('never throws on hostile input', () => {
    const hostile = {
      role: 'user',
      get content(): never {
        throw new Error('boom')
      },
    }

    expect(buildSummaryColumns({ messages: [hostile] })).toEqual({
      lastMessageSummary: null,
      userTextMessageCount: null,
    })
  })
})
```

Create `services/proxy/tests/storage-writer-summary.test.ts`:

```ts
import { describe, it, expect, mock } from 'bun:test'
import { StorageWriter } from '../src/storage/writer'

describe('StorageWriter.storeRequest summary columns', () => {
  it('stores the precomputed summary in the request INSERT', async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const pool = {
      query: mock(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values })
        return { rows: [], rowCount: 0 }
      }),
    }
    const writer = new StorageWriter(pool as any)

    await writer.storeRequest({
      requestId: '11111111-1111-4111-8111-111111111111',
      projectId: 'project-test',
      timestamp: new Date('2026-09-24T00:00:00Z'),
      method: 'POST',
      path: '/v1/messages',
      headers: {},
      apiKey: '',
      model: 'claude-test',
      conversationId: '22222222-2222-4222-8222-222222222222',
      parentMessageHash: 'parent-hash',
      body: {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
          { role: 'user', content: '  continue  ' },
        ],
      },
    })

    const insert = calls.find(call => call.sql.includes('INSERT INTO api_requests'))
    expect(insert).toBeDefined()
    expect(insert!.sql).toContain('last_message_summary, user_text_message_count')
    expect(insert!.values).toHaveLength(23)
    expect(JSON.parse(insert!.values![21] as string)).toEqual({ role: 'user', content: 'continue' })
    expect(insert!.values![22]).toBe(2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test services/proxy/tests/summary-columns.test.ts services/proxy/tests/storage-writer-summary.test.ts`
Expected: FAIL — `Cannot find module '../src/storage/summary-columns'`, and the writer test fails on `toContain('last_message_summary, user_text_message_count')`.

- [ ] **Step 3: Implement**

Create `services/proxy/src/storage/summary-columns.ts`:

```ts
import {
  countUserTextMessages,
  getErrorMessage,
  summarizeLastMessage,
} from '@agent-prompttrain/shared'
import { logger } from '../middleware/logger.js'

export interface SummaryColumns {
  lastMessageSummary: string | null
  userTextMessageCount: number | null
}

/**
 * Precompute the read-path summary columns for api_requests (ADR-037).
 * Never throws: a failed summary must not cost the request row.
 */
export function buildSummaryColumns(body: unknown): SummaryColumns {
  try {
    const messages = (body as { messages?: unknown } | null | undefined)?.messages
    const lastMessage = Array.isArray(messages) ? messages[messages.length - 1] : undefined
    const summary = summarizeLastMessage(lastMessage)

    return {
      lastMessageSummary: summary ? JSON.stringify(summary) : null,
      userTextMessageCount: countUserTextMessages(messages),
    }
  } catch (error) {
    logger.warn('Failed to summarize last message for storage', {
      metadata: { error: getErrorMessage(error) },
    })
    return { lastMessageSummary: null, userTextMessageCount: null }
  }
}
```

In `services/proxy/src/storage/writer.ts`, add after the existing imports:

```ts
import { buildSummaryColumns } from './summary-columns.js'
```

Replace the INSERT block (the `const query = \`INSERT INTO api_requests (...`through the`values` array) with:

```ts
const summaryColumns = buildSummaryColumns(request.body)

const query = `
        INSERT INTO api_requests (
          request_id, project_id, account_id, timestamp, method, path, headers, body, 
          api_key_hash, model, request_type, current_message_hash, 
          parent_message_hash, conversation_id, branch_id, system_hash, message_count,
          parent_task_request_id, is_subtask, task_tool_invocation, parent_request_id,
          last_message_summary, user_text_message_count
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
        ON CONFLICT (request_id) DO NOTHING
      `

const values = [
  request.requestId,
  request.projectId,
  request.accountId || null,
  request.timestamp,
  request.method,
  request.path,
  JSON.stringify(sanitizedHeaders),
  JSON.stringify(request.body),
  this.hashApiKey(request.apiKey),
  request.model,
  request.requestType,
  request.currentMessageHash || null,
  request.parentMessageHash || null,
  request.conversationId || null,
  branchId,
  request.systemHash || null,
  request.messageCount || 0,
  parentTaskRequestId || null,
  isSubtask,
  request.taskToolInvocation ? JSON.stringify(request.taskToolInvocation) : null,
  request.parentRequestId || null,
  summaryColumns.lastMessageSummary,
  summaryColumns.userTextMessageCount,
]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test services/proxy/tests/summary-columns.test.ts services/proxy/tests/storage-writer-summary.test.ts`
Expected: PASS.

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add services/proxy/src/storage/summary-columns.ts services/proxy/src/storage/writer.ts services/proxy/tests/summary-columns.test.ts services/proxy/tests/storage-writer-summary.test.ts
git commit -m "feat(proxy): store last-message summary with each request

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Dashboard helpers, metrics and parity tests

**Files:**

- Create: `services/dashboard/src/utils/last-message.ts`
- Create: `services/dashboard/src/utils/conversation-timeline.ts`
- Modify: `services/dashboard/src/types/conversation.ts` (add a field to `ConversationRequest`; add `SubtaskSummary`)
- Modify: `services/dashboard/src/utils/conversation-metrics.ts` (remove local `hasVisibleText` at lines 49–61, import it from shared; change `countUserInteractions` at lines ~236–275)
- Modify: `package.json` (`test:ci`) and `scripts/run-all-tests.sh` line 16 (add `services/dashboard/src/utils/__tests__`)
- Test: `services/dashboard/src/utils/__tests__/last-message-parity.test.ts`
- Test: `services/dashboard/src/utils/__tests__/conversation-timeline.test.ts`

**Interfaces:**

- Consumes: `summarizeLastMessage`, `countUserTextMessages`, `hasVisibleText` from `@agent-prompttrain/shared` (Task 1).
- Produces:
  - `ConversationRequest.user_text_message_count?: number | null`
  - `interface SubtaskSummary { request_id: string; conversation_id: string | null; is_subtask: boolean | null; parent_task_request_id: string; timestamp: string }`
  - `classifyLastMessage(lastMessage: any): { hasUserMessage: boolean; lastMessageType: 'user' | 'assistant' | 'tool_result'; toolResultStatus?: 'success' | 'error' | 'mixed' }`
  - `getLastMessageContent(req: ConversationRequest): string` (moved verbatim from the route)
  - `hasTaskInvocation(req: { task_tool_invocation?: any }): boolean`
  - `filterRequestsByBranch<T extends { branch_id?: string; timestamp: string | Date }>(requests: T[], selectedBranch?: string): T[]`
  - `buildSubtasksMap(requests: Array<{ request_id: string; task_tool_invocation?: any }>, subtasksByRequest: Map<string, SubtaskSummary[]>): Map<string, any[]>`
  - `countUserInteractions` uses `user_text_message_count` when present on the selected request.

- [ ] **Step 1: Add the test path to the CI suites**

In `package.json`, in the `test:ci` script, insert `services/dashboard/src/utils/__tests__` right after `services/dashboard/src/routes/__tests__`.
In `scripts/run-all-tests.sh` line 16, insert the same path right after `services/dashboard/src/routes/__tests__`.

- [ ] **Step 2: Write the failing tests**

Create `services/dashboard/src/utils/__tests__/last-message-parity.test.ts`:

```ts
import { describe, it, expect } from 'bun:test'
import { countUserTextMessages, summarizeLastMessage } from '@agent-prompttrain/shared'
import { classifyLastMessage, getLastMessageContent } from '../last-message'
import { calculateConversationMetrics } from '../conversation-metrics'
import type { ConversationRequest } from '../../types/conversation'

// Summaries round-trip through JSONB in production
const stored = (message: unknown) => JSON.parse(JSON.stringify(summarizeLastMessage(message)))

const LAST_MESSAGES: Record<string, unknown> = {
  userString: { role: 'user', content: 'Please fix the failing test in src/app.ts' },
  userWhitespace: { role: 'user', content: '   \n  ' },
  userEmptyString: { role: 'user', content: '' },
  userLongText: {
    role: 'user',
    content: [{ type: 'text', text: ' '.repeat(3) + 'w'.repeat(500) }],
  },
  exactly80: { role: 'user', content: 'e'.repeat(80) },
  exactly81: { role: 'user', content: 'f'.repeat(81) },
  toolResults: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_a', content: 'r'.repeat(1000) },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_b',
        is_error: true,
        content: [
          { type: 'text', text: 'Error: ENOENT' },
          { type: 'image', source: { data: 'AAAA' } },
        ],
      },
    ],
  },
  toolResultThenText: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_c', content: 'ok' },
      { type: 'text', text: 'continue please' },
    ],
  },
  blankTextThenError: {
    role: 'user',
    content: [
      { type: 'text', text: '   ' },
      { type: 'tool_result', tool_use_id: 'toolu_d', is_error: true, content: 'failed' },
    ],
  },
  imageQuestion: {
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', data: 'B'.repeat(50_000) } },
      { type: 'text', text: 'What is this?' },
    ],
  },
  assistantToolUse: {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Delegating.' },
      { type: 'tool_use', id: 'toolu_e', name: 'Task', input: { prompt: 'q'.repeat(300) } },
    ],
  },
  unicodeWhitespace: { role: 'user', content: [{ type: 'text', text: '\u00a0\u3000\ufeff' }] },
  emptyArray: { role: 'user', content: [] },
  document: { role: 'user', content: [{ type: 'document', source: { data: 'D' } }] },
  systemRole: { role: 'system', content: [] },
}

describe('last-message summary parity', () => {
  for (const [name, message] of Object.entries(LAST_MESSAGES)) {
    it(`derives identical node classification for ${name}`, () => {
      expect(classifyLastMessage(stored(message))).toEqual(classifyLastMessage(message))
    })

    it(`derives an identical timeline preview for ${name}`, () => {
      const full = { request_id: 'r', last_message: message } as ConversationRequest
      const summary = { request_id: 'r', last_message: stored(message) } as ConversationRequest
      expect(getLastMessageContent(summary)).toBe(getLastMessageContent(full))
    })
  }
})

describe('conversation metrics parity', () => {
  const t = (seconds: number) => new Date(Date.UTC(2026, 8, 24, 10, 0, seconds)).toISOString()
  const history = [
    { role: 'user', content: 'Fix the bug' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: {} }] },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'boom' }],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
    { role: 'user', content: 'thanks, now add tests' },
  ]
  const branchHistory = [...history.slice(0, 6), { role: 'user', content: 'alternative approach' }]

  const base = [
    {
      id: 'r1',
      at: 0,
      branch: 'main',
      last: history[0],
      response: [
        { type: 'text', text: 'Looking' },
        { type: 'tool_use', id: 'tu1', name: 'Read' },
      ],
    },
    {
      id: 'r2',
      at: 5,
      branch: 'main',
      last: history[2],
      response: [{ type: 'tool_use', id: 'tu2', name: 'Bash' }],
    },
    {
      id: 'r3',
      at: 9,
      branch: 'main',
      last: history[4],
      response: [{ type: 'text', text: 'Done' }],
    },
    {
      id: 'r4',
      at: 60,
      branch: 'main',
      last: history[6],
      response: [{ type: 'text', text: 'Sure' }],
      full: history,
    },
    {
      id: 'r5',
      at: 70,
      branch: 'branch_2',
      last: branchHistory[6],
      response: [{ type: 'text', text: 'ok' }],
      full: branchHistory,
    },
  ]

  // Old reader shape: full body only on the latest request per branch
  const legacyRequests = base.map(r => ({
    request_id: r.id,
    timestamp: t(r.at),
    branch_id: r.branch,
    model: 'claude-test',
    total_tokens: 10,
    last_message: r.last,
    response_body: { content: r.response },
    body: r.full ? { messages: r.full } : undefined,
  })) as ConversationRequest[]

  // New reader shape: summaries everywhere, count only on the latest request per branch, no bodies
  const summarizedRequests = base.map(r => ({
    request_id: r.id,
    timestamp: t(r.at),
    branch_id: r.branch,
    model: 'claude-test',
    total_tokens: 10,
    last_message: stored(r.last),
    response_body: { content: r.response },
    user_text_message_count: r.full ? countUserTextMessages(r.full) : null,
  })) as ConversationRequest[]

  it('produces identical metrics from summaries and counts', () => {
    expect(calculateConversationMetrics(summarizedRequests)).toEqual(
      calculateConversationMetrics(legacyRequests)
    )
  })
})
```

Create `services/dashboard/src/utils/__tests__/conversation-timeline.test.ts`:

```ts
import { describe, it, expect } from 'bun:test'
import {
  buildSubtasksMap,
  filterRequestsByBranch,
  hasTaskInvocation,
} from '../conversation-timeline'
import type { SubtaskSummary } from '../../types/conversation'

const requests = [
  { request_id: 'm1', branch_id: 'main', timestamp: '2026-09-24T10:00:00Z' },
  { request_id: 'm2', branch_id: undefined, timestamp: '2026-09-24T10:01:00Z' },
  { request_id: 'b1', branch_id: 'branch_2', timestamp: '2026-09-24T10:02:00Z' },
  { request_id: 'm3', branch_id: 'main', timestamp: '2026-09-24T10:03:00Z' },
  { request_id: 'b2', branch_id: 'branch_2', timestamp: '2026-09-24T10:04:00Z' },
]

describe('filterRequestsByBranch', () => {
  it('returns every request without a selected branch', () => {
    expect(filterRequestsByBranch(requests).map(r => r.request_id)).toEqual([
      'm1',
      'm2',
      'b1',
      'm3',
      'b2',
    ])
  })

  it('returns only main-branch requests for main', () => {
    expect(filterRequestsByBranch(requests, 'main').map(r => r.request_id)).toEqual([
      'm1',
      'm2',
      'm3',
    ])
  })

  it('returns main history before the fork plus the branch', () => {
    expect(filterRequestsByBranch(requests, 'branch_2').map(r => r.request_id)).toEqual([
      'm1',
      'm2',
      'b1',
      'b2',
    ])
  })

  it('returns nothing for an unknown branch', () => {
    expect(filterRequestsByBranch(requests, 'nope')).toEqual([])
  })
})

describe('buildSubtasksMap', () => {
  it('links task invocations to the sub-task conversation they spawned', () => {
    const invocation = { name: 'Task', input: { prompt: 'Explore' } }
    const subtasks: SubtaskSummary[] = [
      {
        request_id: 's1',
        conversation_id: 'conv-sub',
        is_subtask: true,
        parent_task_request_id: 'p1',
        timestamp: 't',
      },
    ]
    const map = buildSubtasksMap(
      [
        { request_id: 'p1', task_tool_invocation: [invocation] },
        { request_id: 'p2', task_tool_invocation: [invocation] },
        { request_id: 'p3' },
      ],
      new Map([['p1', subtasks]])
    )

    expect(map.get('p1')).toEqual([{ ...invocation, linked_conversation_id: 'conv-sub' }])
    expect(map.has('p2')).toBe(false)
    expect(map.has('p3')).toBe(false)
  })

  it('detects task invocations', () => {
    expect(hasTaskInvocation({ task_tool_invocation: [{}] })).toBe(true)
    expect(hasTaskInvocation({ task_tool_invocation: [] })).toBe(false)
    expect(hasTaskInvocation({})).toBe(false)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test services/dashboard/src/utils/__tests__`
Expected: FAIL — `Cannot find module '../last-message'` and `'../conversation-timeline'`.

- [ ] **Step 4: Implement the types and helpers**

In `services/dashboard/src/types/conversation.ts`, add to `ConversationRequest` (after `last_message?: any`):

```ts
  user_text_message_count?: number | null
```

and append:

```ts
export interface SubtaskSummary {
  request_id: string
  conversation_id: string | null
  is_subtask: boolean | null
  parent_task_request_id: string
  timestamp: string
}
```

Create `services/dashboard/src/utils/last-message.ts` — `classifyLastMessage` is the tree-node block from `conversation-detail.ts` (lines ~172–225) and `getLastMessageContent` is moved verbatim from `conversation-detail.ts` (lines ~1203–1283):

```ts
import type { ConversationRequest } from '../types/conversation.js'

export type LastMessageType = 'user' | 'assistant' | 'tool_result'
export type ToolResultStatus = 'success' | 'error' | 'mixed'

export interface LastMessageClassification {
  hasUserMessage: boolean
  lastMessageType: LastMessageType
  toolResultStatus?: ToolResultStatus
}

/**
 * Classify a request's last message for the conversation tree
 * (works on full messages and on ADR-037 summaries alike).
 */
export function classifyLastMessage(lastMessage: any): LastMessageClassification {
  // Check if the last message in the request is a user message with text content
  let hasUserMessage = false
  if (lastMessage?.role === 'user') {
    if (typeof lastMessage.content === 'string') {
      hasUserMessage = lastMessage.content.trim().length > 0
    } else if (Array.isArray(lastMessage.content)) {
      hasUserMessage = lastMessage.content.some(
        (item: any) => item.type === 'text' && item.text && item.text.trim().length > 0
      )
    }
  }

  let lastMessageType: LastMessageType = 'assistant'
  let toolResultStatus: ToolResultStatus | undefined

  // Check if the last message in the request contains tool results
  if (lastMessage && lastMessage.content && Array.isArray(lastMessage.content)) {
    const toolResults = lastMessage.content.filter((item: any) => item.type === 'tool_result')

    if (toolResults.length > 0) {
      lastMessageType = 'tool_result'

      const hasError = toolResults.some((result: any) => result.is_error === true)
      const hasSuccess = toolResults.some((result: any) => result.is_error !== true)

      if (hasError && hasSuccess) {
        toolResultStatus = 'mixed'
      } else if (hasError) {
        toolResultStatus = 'error'
      } else {
        toolResultStatus = 'success'
      }
    }
  }

  // Override if last message is actually a user message
  if (hasUserMessage) {
    lastMessageType = 'user'
    toolResultStatus = undefined
  }

  return { hasUserMessage, lastMessageType, toolResultStatus }
}

/**
 * Helper to extract the last message content from a request
 */
export function getLastMessageContent(req: ConversationRequest): string {
  try {
    // Check if we have the optimized last_message field
    if (req.last_message) {
      const lastMessage = req.last_message

      // Handle the last message directly
      if (typeof lastMessage.content === 'string') {
        const content = lastMessage.content.trim()
        return content.length > 80 ? content.substring(0, 77) + '...' : content
      } else if (Array.isArray(lastMessage.content)) {
        for (const block of lastMessage.content) {
          if (block.type === 'text' && block.text) {
            const content = block.text.trim()
            return content.length > 80 ? content.substring(0, 77) + '...' : content
          } else if (block.type === 'tool_use' && block.name) {
            return `🔧 Tool: ${block.name}${block.input?.prompt ? ' - ' + block.input.prompt.substring(0, 50) + '...' : ''}`
          } else if (block.type === 'tool_result' && block.tool_use_id) {
            return `✅ Tool Result${block.content ? ': ' + (typeof block.content === 'string' ? block.content : JSON.stringify(block.content)).substring(0, 50) + '...' : ''}`
          }
        }
      }

      // Fallback to role-based description
      if (lastMessage.role === 'assistant') {
        return '🤖 Assistant response'
      } else if (lastMessage.role === 'user') {
        return '👤 User message'
      } else if (lastMessage.role === 'system') {
        return '⚙️ System message'
      }
    }

    // Legacy fallback for old data structure
    if (!req.body || !req.body.messages || !Array.isArray(req.body.messages)) {
      return 'Request ID: ' + req.request_id
    }

    const messages = req.body.messages
    if (messages.length === 0) {
      return 'Request ID: ' + req.request_id
    }

    // Get the last message
    const lastMessage = messages[messages.length - 1]

    // Handle different message formats
    if (typeof lastMessage.content === 'string') {
      // Simple string content
      const content = lastMessage.content.trim()
      return content.length > 80 ? content.substring(0, 77) + '...' : content
    } else if (Array.isArray(lastMessage.content)) {
      // Array of content blocks
      for (const block of lastMessage.content) {
        if (block.type === 'text' && block.text) {
          const content = block.text.trim()
          return content.length > 80 ? content.substring(0, 77) + '...' : content
        } else if (block.type === 'tool_use' && block.name) {
          return `🔧 Tool: ${block.name}${block.input?.prompt ? ' - ' + block.input.prompt.substring(0, 50) + '...' : ''}`
        } else if (block.type === 'tool_result' && block.tool_use_id) {
          return `✅ Tool Result${block.content ? ': ' + (typeof block.content === 'string' ? block.content : JSON.stringify(block.content)).substring(0, 50) + '...' : ''}`
        }
      }
    }

    // Fallback to role-based description
    if (lastMessage.role === 'assistant') {
      return '🤖 Assistant response'
    } else if (lastMessage.role === 'user') {
      return '👤 User message'
    } else if (lastMessage.role === 'system') {
      return '⚙️ System message'
    }

    return 'Request ID: ' + req.request_id
  } catch (_error) {
    return 'Request ID: ' + req.request_id
  }
}
```

(Before saving, diff the moved `getLastMessageContent` body against `conversation-detail.ts` lines ~1203–1283 — it must be byte-identical apart from the `export` keyword.)

Create `services/dashboard/src/utils/conversation-timeline.ts`:

```ts
import type { SubtaskSummary } from '../types/conversation.js'

interface BranchScopedRequest {
  branch_id?: string
  timestamp: string | Date
}

export function hasTaskInvocation(req: { task_tool_invocation?: any }): boolean {
  return Array.isArray(req.task_tool_invocation) && req.task_tool_invocation.length > 0
}

/**
 * Requests shown for a branch: main-branch history before the branch diverged plus the branch itself.
 */
export function filterRequestsByBranch<T extends BranchScopedRequest>(
  requests: T[],
  selectedBranch?: string
): T[] {
  if (selectedBranch && selectedBranch !== 'main') {
    // Find the first request in the selected branch
    const branchRequests = requests.filter(r => r.branch_id === selectedBranch)
    if (branchRequests.length === 0) {
      return branchRequests
    }

    // Sort by timestamp to get the first request in the branch
    branchRequests.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    const firstBranchRequest = branchRequests[0]

    // Get all requests from main branch that happened before the branch diverged
    const mainRequestsBeforeBranch = requests.filter(
      r =>
        (r.branch_id === 'main' || !r.branch_id) &&
        new Date(r.timestamp) < new Date(firstBranchRequest.timestamp)
    )

    return [...mainRequestsBeforeBranch, ...branchRequests]
  }

  if (selectedBranch === 'main') {
    return requests.filter(r => r.branch_id === 'main' || !r.branch_id)
  }

  return requests
}

/**
 * Link each task invocation to the sub-task conversation it spawned.
 */
export function buildSubtasksMap(
  requests: Array<{ request_id: string; task_tool_invocation?: any }>,
  subtasksByRequest: Map<string, SubtaskSummary[]>
): Map<string, any[]> {
  const subtasksMap = new Map<string, any[]>()

  for (const req of requests) {
    if (!hasTaskInvocation(req)) {
      continue
    }

    const subtasks = subtasksByRequest.get(req.request_id) ?? []
    if (subtasks.length === 0) {
      continue
    }

    // Group sub-tasks by their conversation ID
    const subtasksByConversation = subtasks.reduce(
      (acc, subtask) => {
        const convId = subtask.conversation_id || 'unknown'
        if (!acc[convId]) {
          acc[convId] = []
        }
        acc[convId].push(subtask)
        return acc
      },
      {} as Record<string, SubtaskSummary[]>
    )

    // Link sub-task conversations to task invocations
    const enrichedInvocations = req.task_tool_invocation.map((invocation: any) => {
      for (const [convId, convSubtasks] of Object.entries(subtasksByConversation)) {
        const matches = convSubtasks.some(
          st => st.is_subtask && st.parent_task_request_id === req.request_id
        )
        if (matches) {
          return { ...invocation, linked_conversation_id: convId }
        }
      }
      return invocation
    })

    subtasksMap.set(req.request_id, enrichedInvocations)
  }

  return subtasksMap
}
```

In `services/dashboard/src/utils/conversation-metrics.ts`:

1. Delete the local `hasVisibleText` function (lines ~46–61, including its doc comment).
2. Add at the top: `import { hasVisibleText } from '@agent-prompttrain/shared'`.
3. Replace the body of `countUserInteractions` up to the "Fallback to old method" comment with:

```ts
// Find the last request per branch that carries either a precomputed count or a full body
const lastRequestPerBranch = new Map<string, ConversationRequest>()

for (const request of requests) {
  const branch = request.branch_id || 'main'
  if (
    (typeof request.user_text_message_count === 'number' || request.body?.messages) &&
    (!lastRequestPerBranch.has(branch) ||
      new Date(request.timestamp) > new Date(lastRequestPerBranch.get(branch)!.timestamp))
  ) {
    lastRequestPerBranch.set(branch, request)
  }
}

// Use the first branch's latest request (unchanged selection rule)
if (lastRequestPerBranch.size > 0) {
  const lastRequest = Array.from(lastRequestPerBranch.values())[0]
  if (typeof lastRequest.user_text_message_count === 'number') {
    return { count: lastRequest.user_text_message_count, requests: [] }
  }
  return countUserInteractionsFromLastRequest(lastRequest)
}
```

(Leave the legacy fallback loop below it unchanged.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test services/dashboard/src/utils/__tests__`
Expected: PASS (every fixture in both parity suites, plus the timeline tests).

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add services/dashboard/src/utils/last-message.ts services/dashboard/src/utils/conversation-timeline.ts services/dashboard/src/types/conversation.ts services/dashboard/src/utils/conversation-metrics.ts services/dashboard/src/utils/__tests__ package.json scripts/run-all-tests.sh
git commit -m "refactor(dashboard): extract last-message and timeline helpers with summary parity tests

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Reader uses summaries and batches sub-task lookups

**Files:**

- Modify: `services/dashboard/src/storage/reader.ts` (imports line 4; `ApiRequest` interface lines ~6–30; requests query and mapping in `getConversationById` lines ~602–659; add `getSubtasksForRequests` after `getSubtasksForRequest` ~line 1000)
- Modify: `package.json` (`test:ci`) and `scripts/run-all-tests.sh` line 16 (add `services/dashboard/src/storage/__tests__`)
- Test: `services/dashboard/src/storage/__tests__/reader-conversation.test.ts`

**Interfaces:**

- Consumes: `userTextMessageCountSql` (Task 1); `SubtaskSummary` (Task 4); columns from Task 2.
- Produces:
  - `getConversationById` requests carry `last_message` (summary or legacy extraction), `user_text_message_count: number | null` (only on the latest request per branch), and **no** `body`.
  - `StorageReader.getSubtasksForRequests(requestIds: string[]): Promise<Map<string, SubtaskSummary[]>>`.

- [ ] **Step 1: Add the test path and write the failing test**

Add `services/dashboard/src/storage/__tests__` after `services/dashboard/src/utils/__tests__` in `package.json` `test:ci` and in `scripts/run-all-tests.sh` line 16.

Create `services/dashboard/src/storage/__tests__/reader-conversation.test.ts`:

```ts
import { describe, it, expect, mock, beforeAll, afterAll } from 'bun:test'
import { userTextMessageCountSql } from '@agent-prompttrain/shared'
import { StorageReader } from '../reader'

const originalTtl = process.env.DASHBOARD_CACHE_TTL
beforeAll(() => {
  process.env.DASHBOARD_CACHE_TTL = '0'
})
afterAll(() => {
  if (originalTtl === undefined) {
    delete process.env.DASHBOARD_CACHE_TTL
  } else {
    process.env.DASHBOARD_CACHE_TTL = originalTtl
  }
})

function createPool(responses: unknown[][]) {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const pool = {
    query: mock(async (sql: string, values: unknown[]) => {
      calls.push({ sql, values })
      return { rows: responses.shift() ?? [], rowCount: 0 }
    }),
  }
  return { pool: pool as any, calls }
}

describe('StorageReader.getConversationById', () => {
  it('reads precomputed summaries and never returns full bodies', async () => {
    const { pool, calls } = createPool([
      [
        {
          conversation_id: 'c1',
          request_count: '1',
          message_count: '3',
          first_message: '2026-09-24T00:00:00Z',
          last_message: '2026-09-24T00:00:00Z',
          total_tokens: '10',
          branches: ['main'],
        },
      ],
      [
        {
          request_id: 'r1',
          project_id: 'p',
          timestamp: '2026-09-24T00:00:00Z',
          model: 'm',
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
          duration_ms: 4,
          branch_id: 'main',
          message_count: 3,
          response_body: { usage: {} },
          account_id: 'a',
          last_message: { role: 'user', content: 'hi' },
          user_text_message_count: 2,
        },
      ],
    ])

    const conversation = await new StorageReader(pool).getConversationById('c1')
    const sql = calls[1].sql

    expect(sql).toContain('last_message_summary')
    expect(sql).toContain(userTextMessageCountSql('body'))
    expect(sql).not.toMatch(/THEN\s+body\s+ELSE/)
    expect(sql).not.toMatch(/SELECT\s+\*/)
    expect(conversation!.requests[0].user_text_message_count).toBe(2)
    expect(conversation!.requests[0].last_message).toEqual({ role: 'user', content: 'hi' })
    expect(conversation!.requests[0].body).toBeUndefined()
  })
})

describe('StorageReader.getSubtasksForRequests', () => {
  it('returns an empty map without querying when there are no ids', async () => {
    const { pool, calls } = createPool([])
    const map = await new StorageReader(pool).getSubtasksForRequests([])
    expect(map.size).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('groups sub-tasks by parent request in a single narrow query', async () => {
    const { pool, calls } = createPool([
      [
        {
          request_id: 's1',
          conversation_id: 'cs',
          is_subtask: true,
          parent_task_request_id: 'p1',
          timestamp: 't1',
        },
        {
          request_id: 's2',
          conversation_id: 'cs',
          is_subtask: true,
          parent_task_request_id: 'p1',
          timestamp: 't2',
        },
        {
          request_id: 's3',
          conversation_id: 'ct',
          is_subtask: true,
          parent_task_request_id: 'p2',
          timestamp: 't3',
        },
      ],
    ])

    const map = await new StorageReader(pool).getSubtasksForRequests(['p1', 'p2', 'p3'])

    expect(calls).toHaveLength(1)
    expect(calls[0].values).toEqual([['p1', 'p2', 'p3']])
    expect(calls[0].sql).not.toMatch(/SELECT\s+\*/)
    expect(map.get('p1')!.map(s => s.request_id)).toEqual(['s1', 's2'])
    expect(map.get('p2')!.map(s => s.request_id)).toEqual(['s3'])
    expect(map.has('p3')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test services/dashboard/src/storage/__tests__/reader-conversation.test.ts`
Expected: FAIL — `expect(sql).toContain('last_message_summary')` fails and `getSubtasksForRequests is not a function`.

- [ ] **Step 3: Implement**

In `services/dashboard/src/storage/reader.ts`:

Replace line 4 with:

```ts
import { getErrorMessage, userTextMessageCountSql } from '@agent-prompttrain/shared'
import type { SubtaskSummary } from '../types/conversation.js'
```

In `interface ApiRequest`, after `last_message?: any`, add:

```ts
  user_text_message_count?: number | null
```

Replace the `requestsQuery` string in `getConversationById` with:

```ts
// Precomputed summaries (ADR-037): only rows without one decompress their body
const requestsQuery = `
        WITH ranked_requests AS (
          SELECT
            request_id, project_id, timestamp, model,
            input_tokens, output_tokens, total_tokens, duration_ms,
            error, request_type, tool_call_count, conversation_id,
            current_message_hash, parent_message_hash, branch_id, message_count,
            parent_task_request_id, is_subtask, task_tool_invocation, parent_request_id,
            response_body, account_id, body, last_message_summary, user_text_message_count,
            ROW_NUMBER() OVER (PARTITION BY COALESCE(branch_id, 'main') ORDER BY timestamp DESC) AS rn
          FROM api_requests
          WHERE conversation_id = $1
        )
        SELECT
          request_id, project_id, timestamp, model,
          input_tokens, output_tokens, total_tokens, duration_ms,
          error, request_type, tool_call_count, conversation_id,
          current_message_hash, parent_message_hash, branch_id, message_count,
          parent_task_request_id, is_subtask, task_tool_invocation, parent_request_id,
          response_body, account_id,
          CASE
            WHEN last_message_summary IS NOT NULL THEN last_message_summary
            WHEN body -> 'messages' IS NOT NULL AND jsonb_array_length(body -> 'messages') > 0 THEN
              body -> 'messages' -> -1
            ELSE NULL
          END AS last_message,
          -- Only the latest request per branch feeds countUserInteractions
          CASE
            WHEN rn = 1 THEN COALESCE(user_text_message_count, ${userTextMessageCountSql('body')})
            ELSE NULL
          END AS user_text_message_count
        FROM ranked_requests
        ORDER BY timestamp ASC
      `
```

In the `requestsRows.map(row => ({ ... }))` mapping, delete the line `body: row.body,` and add after `last_message: row.last_message,`:

```ts
        user_text_message_count: row.user_text_message_count ?? null,
```

After `getSubtasksForRequest`, add:

```ts
  /**
   * Get sub-tasks for many parent requests in one query, grouped by parent request
   */
  async getSubtasksForRequests(requestIds: string[]): Promise<Map<string, SubtaskSummary[]>> {
    const subtasksByRequest = new Map<string, SubtaskSummary[]>()
    if (requestIds.length === 0) {
      return subtasksByRequest
    }

    try {
      const query = `
        SELECT request_id, conversation_id, is_subtask, parent_task_request_id, timestamp
        FROM api_requests
        WHERE parent_task_request_id = ANY($1::uuid[])
        ORDER BY timestamp ASC
      `

      const rows = await this.executeQuery<SubtaskSummary>(
        query,
        [requestIds],
        'getSubtasksForRequests'
      )

      for (const row of rows) {
        const subtasks = subtasksByRequest.get(row.parent_task_request_id) ?? []
        subtasks.push(row)
        subtasksByRequest.set(row.parent_task_request_id, subtasks)
      }

      return subtasksByRequest
    } catch (error) {
      logger.error('Failed to get sub-tasks for requests', {
        metadata: {
          requestCount: requestIds.length,
          error: getErrorMessage(error),
        },
      })
      return subtasksByRequest
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test services/dashboard/src/storage/__tests__/reader-conversation.test.ts services/dashboard/src/utils/__tests__`
Expected: PASS.

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add services/dashboard/src/storage/reader.ts services/dashboard/src/storage/__tests__ package.json scripts/run-all-tests.sh
git commit -m "perf(dashboard): read last-message summaries and batch sub-task lookups

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Conversation route — batched sub-tasks, shared timeline builder, lazy timeline

**Files:**

- Modify: `services/dashboard/src/routes/conversation-detail.ts`
  - imports (lines 1–30)
  - sub-task loop (lines ~70–111)
  - classification block (lines ~172–225)
  - per-request sub-task count (line ~261) and lookup (line ~302)
  - branch filtering (lines ~360–386)
  - timeline panel (lines ~873–880)
  - `switchTab` script (lines ~910–945)
  - `/conversation/:id/messages` route (lines ~1166–1194)
  - remove the moved `getLastMessageContent` (lines ~1203–1283)
  - `renderConversationMessages` root element (line ~1343)
- Modify: `e2e/journeys/critical-journeys.spec.ts` (Journey 3, lines ~39–48)
- Test: `services/dashboard/src/routes/__tests__/conversation-detail.test.ts`

**Interfaces:**

- Consumes: `classifyLastMessage`, `getLastMessageContent` (Task 4, `../utils/last-message.js`); `buildSubtasksMap`, `filterRequestsByBranch`, `hasTaskInvocation` (Task 4, `../utils/conversation-timeline.js`); `StorageReader.getSubtasksForRequests` (Task 5).
- Produces: `GET /dashboard/conversation/:id` renders the timeline only for `view=timeline`, otherwise `<div id="timeline-lazy" data-testid="timeline-lazy" hx-get="/dashboard/conversation/:id/messages[?branch=<encoded>]" hx-trigger="timeline-open once">`; the timeline root carries `data-testid="timeline-content"`; `GET /dashboard/conversation/:id/messages` returns the same timeline HTML (including sub-task info) as the page.

- [ ] **Step 1: Write the failing route test**

Create `services/dashboard/src/routes/__tests__/conversation-detail.test.ts`:

```ts
import { describe, it, expect, mock } from 'bun:test'
import { Hono } from 'hono'

const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333'
const BRANCH = 'branch_a&b"c'
const R1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const R2 = 'aaaaaaaa-0000-4000-8000-000000000002'
const R3 = 'aaaaaaaa-0000-4000-8000-000000000003'

const requests = [
  {
    request_id: R1,
    projectId: 'project-test',
    timestamp: '2026-09-24T10:00:00.000Z',
    model: 'claude-test',
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    duration_ms: 1000,
    tool_call_count: 1,
    conversation_id: CONVERSATION_ID,
    branch_id: 'main',
    message_count: 1,
    current_message_hash: 'h1',
    last_message: { role: 'user', content: 'Please refactor the parser' },
    response_body: {
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Task', input: { prompt: 'Explore the parser' } },
      ],
      usage: { input_tokens: 10 },
    },
    task_tool_invocation: [{ name: 'Task', input: { prompt: 'Explore the parser' } }],
    user_text_message_count: null,
  },
  {
    request_id: R2,
    projectId: 'project-test',
    timestamp: '2026-09-24T10:01:00.000Z',
    model: 'claude-test',
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    duration_ms: 1000,
    tool_call_count: 0,
    conversation_id: CONVERSATION_ID,
    branch_id: 'main',
    message_count: 3,
    current_message_hash: 'h2',
    parent_message_hash: 'h1',
    parent_request_id: R1,
    last_message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Parser explored' }],
    },
    response_body: {
      content: [{ type: 'text', text: 'Refactored.' }],
      usage: { input_tokens: 12 },
    },
    user_text_message_count: 1,
  },
  {
    request_id: R3,
    projectId: 'project-test',
    timestamp: '2026-09-24T10:02:00.000Z',
    model: 'claude-test',
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    duration_ms: 1000,
    tool_call_count: 0,
    conversation_id: CONVERSATION_ID,
    branch_id: BRANCH,
    message_count: 3,
    current_message_hash: 'h3',
    parent_message_hash: 'h1',
    parent_request_id: R1,
    last_message: { role: 'user', content: 'Try another approach' },
    response_body: {
      content: [{ type: 'text', text: 'Alternative.' }],
      usage: { input_tokens: 11 },
    },
    user_text_message_count: 2,
  },
]

const conversation = {
  conversation_id: CONVERSATION_ID,
  message_count: 3,
  first_message: new Date('2026-09-24T10:00:00.000Z'),
  last_message: new Date('2026-09-24T10:02:00.000Z'),
  total_tokens: 45,
  branches: ['main', BRANCH],
  requests,
}

const storage = {
  getConversationById: mock(async () => conversation),
  checkUserProjectAccess: mock(async () => true),
  getSubtasksForRequests: mock(
    async (ids: string[]) =>
      new Map(
        ids.map(id => [
          id,
          [
            {
              request_id: 'bbbbbbbb-0000-4000-8000-000000000001',
              conversation_id: '44444444-4444-4444-8444-444444444444',
              is_subtask: true,
              parent_task_request_id: id,
              timestamp: '2026-09-24T10:00:30.000Z',
            },
          ],
        ])
      )
  ),
  getSubtasksForRequest: mock(async () => {
    throw new Error('per-request sub-task lookup must not be used')
  }),
  countSubtasksForRequests: mock(async (ids: string[]) => ids.length),
}

mock.module('../../container.js', () => ({ container: { getStorageService: () => storage } }))
const { conversationDetailRoutes } = await import('../conversation-detail.js')

const app = new Hono()
app.route('/dashboard', conversationDetailRoutes)

const get = async (path: string) => {
  const res = await app.request(path)
  return { status: res.status, body: await res.text() }
}

const lazyTimelineUrl = (body: string) =>
  body.match(/id="timeline-lazy"[\s\S]*?hx-get="([^"]*)"/)?.[1]

describe('conversation detail route', () => {
  it('lazy-loads the timeline when the tree view is active', async () => {
    const { status, body } = await get(`/dashboard/conversation/${CONVERSATION_ID}`)
    expect(status).toBe(200)
    expect(body).toContain('data-testid="timeline-lazy"')
    expect(lazyTimelineUrl(body)).toBe(`/dashboard/conversation/${CONVERSATION_ID}/messages`)
    expect(body).toContain('hx-trigger="timeline-open once"')
    expect(body).not.toContain('data-testid="timeline-content"')
  })

  it('renders the timeline server-side when it is the active view', async () => {
    const { body } = await get(`/dashboard/conversation/${CONVERSATION_ID}?view=timeline`)
    expect(body).toContain('data-testid="timeline-content"')
    expect(body).not.toContain('data-testid="timeline-lazy"')
  })

  it('serves the same timeline HTML lazily as server-side', async () => {
    const page = await get(`/dashboard/conversation/${CONVERSATION_ID}?view=timeline&branch=main`)
    const lazy = await get(`/dashboard/conversation/${CONVERSATION_ID}/messages?branch=main`)
    expect(lazy.body).toContain('data-testid="timeline-content"')
    expect(page.body).toContain(lazy.body)
  })

  it('encodes the selected branch in the lazy timeline URL', async () => {
    const { body } = await get(
      `/dashboard/conversation/${CONVERSATION_ID}?branch=${encodeURIComponent(BRANCH)}`
    )
    expect(lazyTimelineUrl(body)).toBe(
      `/dashboard/conversation/${CONVERSATION_ID}/messages?branch=${encodeURIComponent(BRANCH)}`
    )
  })

  it('looks up sub-tasks in one batched query', async () => {
    storage.getSubtasksForRequests.mockClear()
    storage.getSubtasksForRequest.mockClear()

    await get(`/dashboard/conversation/${CONVERSATION_ID}`)

    expect(storage.getSubtasksForRequests).toHaveBeenCalledTimes(1)
    expect(storage.getSubtasksForRequests.mock.calls[0][0]).toEqual([R1])
    expect(storage.getSubtasksForRequest).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test services/dashboard/src/routes/__tests__/conversation-detail.test.ts`
Expected: FAIL — no `timeline-lazy` element; `getSubtasksForRequests` never called.

- [ ] **Step 3: Implement the route changes**

In `services/dashboard/src/routes/conversation-detail.ts`:

(a) Add imports:

```ts
import { classifyLastMessage, getLastMessageContent } from '../utils/last-message.js'
import {
  buildSubtasksMap,
  filterRequestsByBranch,
  hasTaskInvocation,
} from '../utils/conversation-timeline.js'
```

(b) Replace the whole "Fetch sub-tasks for requests that have task invocations" block (from `const subtasksMap = new Map<string, any[]>()` through the end of its `for` loop) with:

```ts
// One batched lookup for every request that spawned sub-tasks
const subtasksByRequest = await storageService.getSubtasksForRequests(
  conversation.requests.filter(hasTaskInvocation).map(req => req.request_id)
)
const subtasksMap = buildSubtasksMap(conversation.requests, subtasksByRequest)
```

(c) Replace the block from `// Check if the last message in the request is a user message with text content` through the closing brace of `// Override if last message is actually a user message` with:

```ts
const { hasUserMessage, lastMessageType, toolResultStatus } = classifyLastMessage(req.last_message)
```

(Keep the `contextTokens` computation that sits between those blocks — move it just above this line if it was in between.)

(d) Replace `const actualSubtaskCount = await storageService.countSubtasksForRequests([req.request_id])` with:

```ts
const actualSubtaskCount = (subtasksByRequest.get(req.request_id) ?? []).length
```

(e) Replace the "If we still don't have a linked conversation, try to find it from sub-tasks" lookup with:

```ts
if (!linkedConversationId) {
  const subtasks = subtasksByRequest.get(req.request_id) ?? []
  if (subtasks.length > 0 && subtasks[0].conversation_id) {
    linkedConversationId = subtasks[0].conversation_id
  }
}
```

(f) Replace the "Filter requests by branch if selected" block (`let filteredRequests = …` through the closing `}` of the `else if (selectedBranch === 'main')`) with:

```ts
// Filter requests by branch if selected
const filteredRequests = filterRequestsByBranch(conversation.requests, selectedBranch)
```

(g) Replace the timeline panel content line `${raw(renderConversationMessages(filteredRequests, conversation.branches, subtasksMap))}` with:

```ts
          ${view === 'timeline'
            ? raw(renderConversationMessages(filteredRequests, conversation.branches, subtasksMap))
            : html`<div
                id="timeline-lazy"
                data-testid="timeline-lazy"
                hx-get="/dashboard/conversation/${conversationId}/messages${selectedBranch
                  ? `?branch=${encodeURIComponent(selectedBranch)}`
                  : ''}"
                hx-trigger="timeline-open once"
                hx-swap="outerHTML"
              >
                <div class="section">
                  <div class="section-content">
                    <span class="spinner"></span>
                    <span>Loading timeline...</span>
                  </div>
                </div>
              </div>`}
```

(h) In the `switchTab` script, add right after the three `style.display` assignments:

```js
// Load the timeline on first open
if (tabName === 'timeline') {
  const lazyTimeline = document.getElementById('timeline-lazy')
  if (lazyTimeline && window.htmx) {
    window.htmx.trigger(lazyTimeline, 'timeline-open')
  }
}
```

(i) In the `/conversation/:id/messages` handler, replace everything from `let filteredRequests = conversation.requests` through `return c.html(renderConversationMessages(filteredRequests, conversation.branches))` with:

```ts
const filteredRequests = filterRequestsByBranch(conversation.requests, selectedBranch)
const subtasksByRequest = await storageService.getSubtasksForRequests(
  filteredRequests.filter(hasTaskInvocation).map(req => req.request_id)
)
const subtasksMap = buildSubtasksMap(filteredRequests, subtasksByRequest)

return c.html(renderConversationMessages(filteredRequests, conversation.branches, subtasksMap))
```

(j) Delete the local `getLastMessageContent` function (and its doc comment) from the route file — it is now imported.

(k) In `renderConversationMessages`, change the root `<div style="display: grid; gap: 0.25rem;">` to:

```html
<div data-testid="timeline-content" style="display: grid; gap: 0.25rem;"></div>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test services/dashboard/src/routes/__tests__/conversation-detail.test.ts`
Expected: PASS (5 tests).

Run: `bun test services/dashboard/src/routes/__tests__ services/dashboard/src/utils/__tests__ services/dashboard/src/storage/__tests__`
Expected: PASS (no regressions in other dashboard route tests).

Run: `grep -n "getSubtasksForRequest(\|countSubtasksForRequests(\[req" services/dashboard/src/routes/conversation-detail.ts`
Expected: no output.

Run: `bun run typecheck && bun run lint`
Expected: typecheck exit 0; lint 0 errors.

- [ ] **Step 5: Extend E2E Journey 3**

In `e2e/journeys/critical-journeys.spec.ts`, after `await expect(page.getByTestId('timeline-panel')).toBeVisible()` add:

```ts
await expect(page.getByTestId('timeline-content')).toBeVisible()
```

- [ ] **Step 6: Commit**

```bash
git add services/dashboard/src/routes/conversation-detail.ts services/dashboard/src/routes/__tests__/conversation-detail.test.ts e2e/journeys/critical-journeys.spec.ts
git commit -m "perf(dashboard): lazy-load conversation timeline and batch sub-task queries

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Backfill script

**Files:**

- Create: `scripts/db/backfill-last-message-summary.ts`
- Modify: `package.json` (add script `db:backfill:last-message-summary`; add `scripts/db/__tests__` to `test:ci`)
- Modify: `scripts/run-all-tests.sh` line 16 (add `scripts/db/__tests__`)
- Modify: `scripts/README.md` (new subsection under "Database Scripts (`db/`)", after `### recalculate-message-counts.ts`)
- Test: `scripts/db/__tests__/backfill-last-message-summary.test.ts`

**Interfaces:**

- Consumes: `summarizeLastMessage`, `userTextMessageCountSql` via relative import `../../packages/shared/src/utils/message-summary.js` (scripts do not resolve the shared package's `src` through tsconfig paths).
- Produces:
  - `interface BackfillOptions { days: number; batchSize: number; sleepMs: number; maxBatches?: number; before?: string; execute: boolean }`
  - `parseBackfillArgs(argv: string[]): BackfillOptions` (throws `Error` on invalid values)
  - `interface BackfillResult { batches: number; scanned: number; updated: number; skipped: number; resumeBefore?: string }`
  - `runBackfill(pool: Pool, options: BackfillOptions, log?: (line: string) => void): Promise<BackfillResult>`

- [ ] **Step 1: Write the failing test**

Add `scripts/db/__tests__` to `test:ci` in `package.json` (after `scripts/auth/*.test.ts`) and to `scripts/run-all-tests.sh` line 16.

Create `scripts/db/__tests__/backfill-last-message-summary.test.ts`:

```ts
import { describe, it, expect } from 'bun:test'
import { parseBackfillArgs } from '../backfill-last-message-summary'

describe('parseBackfillArgs', () => {
  it('defaults to a safe dry run over 90 days', () => {
    expect(parseBackfillArgs([])).toEqual({
      days: 90,
      batchSize: 200,
      sleepMs: 250,
      maxBatches: undefined,
      before: undefined,
      execute: false,
    })
  })

  it('parses every flag', () => {
    expect(
      parseBackfillArgs([
        '--days',
        '30',
        '--batch-size',
        '50',
        '--sleep-ms',
        '0',
        '--max-batches',
        '3',
        '--before',
        '2026-09-01T00:00:00.000Z',
        '--execute',
      ])
    ).toEqual({
      days: 30,
      batchSize: 50,
      sleepMs: 0,
      maxBatches: 3,
      before: '2026-09-01T00:00:00.000Z',
      execute: true,
    })
  })

  it('rejects invalid values', () => {
    expect(() => parseBackfillArgs(['--days', '0'])).toThrow('--days')
    expect(() => parseBackfillArgs(['--batch-size', '5000'])).toThrow('--batch-size')
    expect(() => parseBackfillArgs(['--before', 'yesterday'])).toThrow('--before')
    expect(() => parseBackfillArgs(['--bogus'])).toThrow('Unknown option')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test scripts/db/__tests__/backfill-last-message-summary.test.ts`
Expected: FAIL — `Cannot find module '../backfill-last-message-summary'`.

- [ ] **Step 3: Implement the script**

Create `scripts/db/backfill-last-message-summary.ts`:

```ts
#!/usr/bin/env bun

/**
 * Backfill api_requests.last_message_summary and user_text_message_count (ADR-037).
 *
 * Dry-run by default: reads and reports, writes nothing. Pass --execute to write.
 * Walks newest rows first, only touches rows whose summary is still NULL (idempotent,
 * resumable, never overwrites rows the proxy already filled). Bodies are decompressed
 * server-side; only the last message and an integer cross the network.
 *
 * Usage:
 *   bun run db:backfill:last-message-summary [--days 90] [--batch-size 200] [--sleep-ms 250]
 *     [--max-batches N] [--before <ISO timestamp>] [--execute]
 */

import { Pool, type PoolClient } from 'pg'
import {
  summarizeLastMessage,
  userTextMessageCountSql,
} from '../../packages/shared/src/utils/message-summary.js'

export interface BackfillOptions {
  days: number
  batchSize: number
  sleepMs: number
  maxBatches?: number
  before?: string
  execute: boolean
}

export interface BackfillResult {
  batches: number
  scanned: number
  updated: number
  skipped: number
  resumeBefore?: string
}

function parseIntegerOption(
  name: string,
  raw: string | undefined,
  min: number,
  max: number
): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

export function parseBackfillArgs(argv: string[]): BackfillOptions {
  const options: BackfillOptions = {
    days: 90,
    batchSize: 200,
    sleepMs: 250,
    maxBatches: undefined,
    before: undefined,
    execute: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--days':
        options.days = parseIntegerOption('--days', argv[++i], 1, 3650)
        break
      case '--batch-size':
        options.batchSize = parseIntegerOption('--batch-size', argv[++i], 1, 1000)
        break
      case '--sleep-ms':
        options.sleepMs = parseIntegerOption('--sleep-ms', argv[++i], 0, 60000)
        break
      case '--max-batches':
        options.maxBatches = parseIntegerOption('--max-batches', argv[++i], 1, 1_000_000)
        break
      case '--before': {
        const value = argv[++i]
        if (!value || Number.isNaN(Date.parse(value))) {
          throw new Error('--before must be an ISO timestamp')
        }
        options.before = new Date(value).toISOString()
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

function maskHost(databaseUrl: string): string {
  const host = new URL(databaseUrl).hostname
  return host.length <= 12 ? host : `${host.slice(0, 6)}…${host.slice(-6)}`
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function configureSession(client: PoolClient, execute: boolean): Promise<void> {
  await client.query("SET statement_timeout = '120s'")
  await client.query("SET lock_timeout = '5s'")
  await client.query("SET application_name = 'backfill-last-message-summary'")

  if (execute) {
    const { rows } = await client.query('SHOW transaction_read_only')
    if (rows[0]?.transaction_read_only === 'on') {
      throw new Error('Refusing --execute: this session is read-only')
    }
  }
}

export async function runBackfill(
  pool: Pool,
  options: BackfillOptions,
  log: (line: string) => void = console.log
): Promise<BackfillResult> {
  const client = await pool.connect()
  const result: BackfillResult = { batches: 0, scanned: 0, updated: 0, skipped: 0 }
  let stopRequested = false
  const onSignal = () => {
    stopRequested = true
    log('Stop requested - finishing the current batch...')
  }
  process.once('SIGINT', onSignal)

  try {
    await configureSession(client, options.execute)

    const { rows: estimateRows } = await client.query(
      `SELECT count(*)::int AS count
       FROM api_requests
       WHERE timestamp >= now() - make_interval(days => $1)
         AND last_message_summary IS NULL
         AND ($2::timestamptz IS NULL OR timestamp <= $2::timestamptz)`,
      [options.days, options.before ?? null]
    )
    const estimate: number = estimateRows[0].count
    log(
      `${options.execute ? 'EXECUTE' : 'DRY RUN'}: ~${estimate} rows without a summary in the last ${options.days} days`
    )

    let cursor: { timestamp: Date; requestId: string } | undefined
    const startedAt = Date.now()

    while (
      !stopRequested &&
      (options.maxBatches === undefined || result.batches < options.maxBatches)
    ) {
      const params: unknown[] = [options.days, options.batchSize]
      let bound = ''
      if (cursor) {
        params.push(cursor.timestamp, cursor.requestId)
        bound = `AND (timestamp, request_id) < ($3::timestamptz, $4::uuid)`
      } else if (options.before) {
        params.push(options.before)
        bound = `AND timestamp <= $3::timestamptz`
      }

      const { rows } = await client.query(
        `SELECT request_id, timestamp,
                body -> 'messages' -> -1 AS last_message,
                ${userTextMessageCountSql('body')} AS user_text_message_count
         FROM api_requests
         WHERE timestamp >= now() - make_interval(days => $1)
           AND last_message_summary IS NULL
           ${bound}
         ORDER BY timestamp DESC, request_id DESC
         LIMIT $2`,
        params
      )

      if (rows.length === 0) {
        break
      }

      const ids: string[] = []
      const summaries: string[] = []
      const counts: Array<number | null> = []

      for (const row of rows) {
        const summary = summarizeLastMessage(row.last_message)
        if (!summary) {
          result.skipped++
          continue
        }
        ids.push(row.request_id)
        summaries.push(JSON.stringify(summary))
        counts.push(row.user_text_message_count)
      }

      if (options.execute && ids.length > 0) {
        const update = await client.query(
          `UPDATE api_requests AS a
           SET last_message_summary = v.summary::jsonb,
               user_text_message_count = v.user_text_count
           FROM unnest($1::uuid[], $2::text[], $3::int[]) AS v(request_id, summary, user_text_count)
           WHERE a.request_id = v.request_id
             AND a.last_message_summary IS NULL`,
          [ids, summaries, counts]
        )
        result.updated += update.rowCount ?? 0
      }

      const last = rows[rows.length - 1]
      cursor = { timestamp: last.timestamp, requestId: last.request_id }
      result.resumeBefore = new Date(last.timestamp).toISOString()
      result.batches++
      result.scanned += rows.length

      const elapsedSeconds = (Date.now() - startedAt) / 1000
      const rate = result.scanned / Math.max(elapsedSeconds, 0.001)
      const etaMinutes = Math.max(estimate - result.scanned, 0) / Math.max(rate, 0.001) / 60
      log(
        `batch ${result.batches}: scanned ${result.scanned}, ${options.execute ? `updated ${result.updated}` : 'would update ' + (result.scanned - result.skipped)}, skipped ${result.skipped}, ${rate.toFixed(1)} rows/s, ETA ${etaMinutes.toFixed(1)} min, resume --before ${result.resumeBefore}`
      )

      if (options.sleepMs > 0) {
        await sleep(options.sleepMs)
      }
    }

    log(`Done: ${JSON.stringify(result)}`)
    return result
  } finally {
    process.off('SIGINT', onSignal)
    client.release()
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL environment variable is required')
    process.exit(1)
  }

  let options: BackfillOptions
  try {
    options = parseBackfillArgs(process.argv.slice(2))
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
    await runBackfill(pool, options)
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

Add to `package.json` `scripts` (next to the other `db:` scripts):

```json
    "db:backfill:last-message-summary": "bun run scripts/db/backfill-last-message-summary.ts",
```

Add to `scripts/README.md`, after the `### recalculate-message-counts.ts` subsection:

````markdown
### backfill-last-message-summary.ts

Fills `api_requests.last_message_summary` and `user_text_message_count` (ADR-037) for recent rows.
Dry-run by default; writes only with `--execute`. Newest rows first, only rows whose summary is
still NULL, so it is safe to stop (Ctrl-C finishes the current batch) and resume with the printed
`--before` value.

```bash
bun run db:backfill:last-message-summary                     # dry run, last 90 days
bun run db:backfill:last-message-summary --execute           # write, last 90 days
bun run db:backfill:last-message-summary --days 30 --batch-size 100 --sleep-ms 500 --execute
```

Run after migration 026 and after the new proxy is deployed, off-peak. Each row's body is
decompressed once on the database server; expect roughly 1–2 hours for 90 days of production data.
````

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test scripts/db/__tests__/backfill-last-message-summary.test.ts`
Expected: PASS.

Run: `bunx tsc --noEmit --module esnext --target es2022 --moduleResolution bundler --types bun-types --skipLibCheck scripts/db/backfill-last-message-summary.ts`
Expected: exit 0 (root typecheck excludes `scripts/`).

- [ ] **Step 5: Commit**

```bash
git add scripts/db/backfill-last-message-summary.ts scripts/db/__tests__/backfill-last-message-summary.test.ts package.json scripts/run-all-tests.sh scripts/README.md
git commit -m "feat(db): add resumable backfill for last-message summaries

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Database integration test (local Docker Postgres)

**Files:**

- Create: `tests/integration/last-message-summary.db.test.ts`
- Modify: `package.json` (add script `test:db:summary`)

**Interfaces:**

- Consumes: everything from Tasks 1–7; the local `perf03_test` database from Task 2.
- Produces: `bun run test:db:summary` (skips unless `SUMMARY_TEST_DATABASE_URL` names a database ending in `_test`).

- [ ] **Step 1: Write the integration test**

Create `tests/integration/last-message-summary.db.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Pool } from 'pg'
import { join } from 'node:path'
import {
  countUserTextMessages,
  summarizeLastMessage,
  userTextMessageCountSql,
} from '../../packages/shared/src/utils/message-summary'
import { StorageReader } from '../../services/dashboard/src/storage/reader'
import {
  classifyLastMessage,
  getLastMessageContent,
} from '../../services/dashboard/src/utils/last-message'
import { calculateConversationMetrics } from '../../services/dashboard/src/utils/conversation-metrics'
import { runBackfill } from '../../scripts/db/backfill-last-message-summary'

// Only ever runs against an explicitly named local *_test database
const databaseUrl = process.env.SUMMARY_TEST_DATABASE_URL
const enabled = !!databaseUrl && new URL(databaseUrl).pathname.endsWith('_test')
const root = join(import.meta.dir, '../..')

const CONVERSATION = '55555555-5555-4555-8555-555555555555'
const BACKFILL_CONVERSATION = '66666666-6666-4666-8666-666666666666'
const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`

describe.skipIf(!enabled)('last-message summary against PostgreSQL', () => {
  let pool: Pool

  const insert = async (row: {
    requestId: string
    conversationId: string
    timestamp: string
    branchId?: string
    messages: unknown[]
    summarized: boolean
    parentTaskRequestId?: string
  }) => {
    const last = row.messages[row.messages.length - 1]
    await pool.query(
      `INSERT INTO api_requests (
         request_id, project_id, timestamp, method, path, headers, body, model, request_type,
         response_status, response_body, input_tokens, output_tokens, total_tokens, duration_ms,
         conversation_id, branch_id, message_count, parent_task_request_id, is_subtask,
         last_message_summary, user_text_message_count
       ) VALUES ($1, 'project-e2e', $2, 'POST', '/v1/messages', '{}', $3, 'claude-test', 'inference',
         200, $4, 1, 1, 2, 100, $5, $6, $7, $8, $9, $10, $11)`,
      [
        row.requestId,
        row.timestamp,
        JSON.stringify({ messages: row.messages }),
        JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1 } }),
        row.conversationId,
        row.branchId ?? 'main',
        row.messages.length,
        row.parentTaskRequestId ?? null,
        !!row.parentTaskRequestId,
        row.summarized ? JSON.stringify(summarizeLastMessage(last)) : null,
        row.summarized ? countUserTextMessages(row.messages) : null,
      ]
    )
  }

  const history = [
    { role: 'user', content: 'Fix the bug' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'x'.repeat(5000) },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'Fixed' }] },
    { role: 'user', content: [{ type: 'text', text: '\u00a0 thanks \u3000' }] },
  ]

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl })
    process.env.DASHBOARD_CACHE_TTL = '0'
    await pool.query('DELETE FROM api_requests WHERE conversation_id = ANY($1::uuid[])', [
      [CONVERSATION, BACKFILL_CONVERSATION],
    ])
  })

  afterAll(async () => {
    await pool.query('DELETE FROM api_requests WHERE conversation_id = ANY($1::uuid[])', [
      [CONVERSATION, BACKFILL_CONVERSATION],
    ])
    await pool.end()
  })

  it('migration 026 is idempotent', async () => {
    for (let run = 0; run < 2; run++) {
      const child = Bun.spawn(
        ['bun', join(root, 'scripts/db/migrations/026-add-last-message-summary.ts'), 'up'],
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

  it('SQL count equals JS count, including Unicode whitespace', async () => {
    const fixtures: unknown[][] = [
      history,
      [],
      [{ role: 'user', content: '   ' }],
      [
        {
          role: 'user',
          content: '\u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\t\n\v\f\r',
        },
      ],
      [{ role: 'user', content: 'a\u00a0' }],
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: '\u3000' },
            { type: 'tool_result', tool_use_id: 't' },
          ],
        },
      ],
      [
        { role: 'user', content: [{ type: 'text', text: ' x ' }] },
        { role: 'assistant', content: 'y' },
      ],
    ]

    for (const messages of fixtures) {
      const { rows } = await pool.query(`SELECT ${userTextMessageCountSql('$1::jsonb')} AS count`, [
        JSON.stringify({ messages }),
      ])
      expect(rows[0].count).toBe(countUserTextMessages(messages))
    }

    const { rows } = await pool.query(`SELECT ${userTextMessageCountSql('$1::jsonb')} AS count`, [
      JSON.stringify({ other: true }),
    ])
    expect(rows[0].count).toBeNull()
  })

  it('renders a mixed conversation exactly like an all-legacy one', async () => {
    const t = (s: number) => new Date(Date.UTC(2026, 8, 24, 9, 0, s)).toISOString()
    await insert({
      requestId: id(1),
      conversationId: CONVERSATION,
      timestamp: t(0),
      messages: history.slice(0, 1),
      summarized: false,
    })
    await insert({
      requestId: id(2),
      conversationId: CONVERSATION,
      timestamp: t(5),
      messages: history.slice(0, 3),
      summarized: true,
    })
    await insert({
      requestId: id(3),
      conversationId: CONVERSATION,
      timestamp: t(9),
      messages: history,
      summarized: true,
    })
    await insert({
      requestId: id(4),
      conversationId: CONVERSATION,
      timestamp: t(12),
      branchId: 'branch_2',
      messages: history.slice(0, 3),
      summarized: false,
    })

    const reader = new StorageReader(pool)
    const mixed = (await reader.getConversationById(CONVERSATION))!

    await pool.query(
      'UPDATE api_requests SET last_message_summary = NULL, user_text_message_count = NULL WHERE conversation_id = $1',
      [CONVERSATION]
    )
    const legacy = (await reader.getConversationById(CONVERSATION))!

    expect(mixed.requests.map(r => r.request_id)).toEqual(legacy.requests.map(r => r.request_id))
    mixed.requests.forEach((request, i) => {
      expect(classifyLastMessage(request.last_message)).toEqual(
        classifyLastMessage(legacy.requests[i].last_message)
      )
      expect(getLastMessageContent(request as any)).toBe(
        getLastMessageContent(legacy.requests[i] as any)
      )
      expect((request as any).body).toBeUndefined()
    })
    expect(calculateConversationMetrics(mixed.requests as any)).toEqual(
      calculateConversationMetrics(legacy.requests as any)
    )
  })

  it('backfills idempotently and never overwrites stored summaries', async () => {
    const now = Date.now()
    const recent = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
    for (let n = 10; n < 15; n++) {
      await insert({
        requestId: id(n),
        conversationId: BACKFILL_CONVERSATION,
        timestamp: recent(n),
        messages: history,
        summarized: false,
      })
    }
    await insert({
      requestId: id(20),
      conversationId: BACKFILL_CONVERSATION,
      timestamp: recent(1),
      messages: history,
      summarized: false,
    })
    await pool.query(
      `UPDATE api_requests SET last_message_summary = '{"role":"user","content":"sentinel"}', user_text_message_count = 99 WHERE request_id = $1`,
      [id(20)]
    )
    await insert({
      requestId: id(30),
      conversationId: BACKFILL_CONVERSATION,
      timestamp: new Date(now - 200 * 86_400_000).toISOString(),
      messages: history,
      summarized: false,
    })

    const options = { days: 90, batchSize: 2, sleepMs: 0, execute: false }
    const quiet = () => {}
    const countNull = async () =>
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM api_requests WHERE conversation_id = $1 AND last_message_summary IS NULL',
          [BACKFILL_CONVERSATION]
        )
      ).rows[0].n

    await runBackfill(pool, options, quiet)
    expect(await countNull()).toBe(6)

    const executed = await runBackfill(pool, { ...options, execute: true }, quiet)
    expect(executed.updated).toBeGreaterThanOrEqual(5)
    expect(await countNull()).toBe(1) // only the 200-day-old row remains

    const { rows } = await pool.query(
      'SELECT request_id, last_message_summary, user_text_message_count FROM api_requests WHERE request_id = ANY($1::uuid[]) ORDER BY request_id',
      [[id(10), id(20)]]
    )
    expect(rows[0].last_message_summary).toEqual(
      JSON.parse(JSON.stringify(summarizeLastMessage(history[4])))
    )
    expect(rows[0].user_text_message_count).toBe(countUserTextMessages(history))
    expect(rows[1].last_message_summary).toEqual({ role: 'user', content: 'sentinel' })
    expect(rows[1].user_text_message_count).toBe(99)

    const rerun = await runBackfill(pool, { ...options, execute: true }, quiet)
    expect(rerun.updated).toBe(0)
  })

  it('batched sub-task lookup matches per-request lookups', async () => {
    const t = (s: number) => new Date(Date.UTC(2026, 8, 24, 8, 0, s)).toISOString()
    await insert({
      requestId: id(40),
      conversationId: CONVERSATION,
      timestamp: t(0),
      messages: history,
      summarized: true,
      parentTaskRequestId: id(1),
    })
    await insert({
      requestId: id(41),
      conversationId: CONVERSATION,
      timestamp: t(1),
      messages: history,
      summarized: true,
      parentTaskRequestId: id(1),
    })
    await insert({
      requestId: id(42),
      conversationId: CONVERSATION,
      timestamp: t(2),
      messages: history,
      summarized: true,
      parentTaskRequestId: id(2),
    })

    const reader = new StorageReader(pool)
    const batched = await reader.getSubtasksForRequests([id(1), id(2), id(3)])

    for (const parent of [id(1), id(2), id(3)]) {
      const single = await reader.getSubtasksForRequest(parent)
      expect((batched.get(parent) ?? []).map(s => s.request_id)).toEqual(
        single.map(s => s.request_id)
      )
    }
  })
})
```

Add to `package.json` `scripts`:

```json
    "test:db:summary": "bun test tests/integration/last-message-summary.db.test.ts",
```

- [ ] **Step 2: Run it without the env var (must skip, never touch any database)**

Run: `env -u SUMMARY_TEST_DATABASE_URL bun run test:db:summary`
Expected: all tests reported as skipped, exit 0.

- [ ] **Step 3: Run it against the local test database**

Run: `SUMMARY_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test bun run test:db:summary`
Expected: PASS (5 tests). If "SQL count equals JS count" fails for a specific whitespace character, fix `JS_TRIM_WHITESPACE` in `message-summary.ts` (Task 1) — do not weaken the test — and re-run Tasks 1 and 8 tests.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/last-message-summary.db.test.ts package.json
git commit -m "test: cover summary columns, reader parity and backfill against PostgreSQL

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Read-only verification against production

**Files:**

- Create: `scripts/db/verify-last-message-summary.ts`
- Modify: `scripts/README.md` (subsection after the backfill one)

**Interfaces:**

- Consumes: `summarizeLastMessage`, `countUserTextMessages`, `userTextMessageCountSql` (Task 1); `classifyLastMessage`, `getLastMessageContent` (Task 4).
- Produces: `bun scripts/db/verify-last-message-summary.ts [--sample 2000] [--count-sample 50]` — read-only; exits 1 on any mismatch; prints request ids only (never content).

- [ ] **Step 1: Write the verification script**

Create `scripts/db/verify-last-message-summary.ts`:

```ts
#!/usr/bin/env bun

/**
 * Read-only parity check for ADR-037 summaries against a real database.
 * Samples recent requests and verifies that the dashboard derives the same node
 * classification and timeline preview from the summary as from the full last message,
 * and that the SQL user-text count matches the JS count.
 *
 * Usage: bun scripts/db/verify-last-message-summary.ts [--sample 2000] [--count-sample 50]
 */

import { Pool } from 'pg'
import {
  countUserTextMessages,
  summarizeLastMessage,
  userTextMessageCountSql,
} from '../../packages/shared/src/utils/message-summary.js'
import {
  classifyLastMessage,
  getLastMessageContent,
} from '../../services/dashboard/src/utils/last-message.js'

function readOption(name: string, fallback: number): number {
  const index = process.argv.indexOf(name)
  if (index === -1) {
    return fallback
  }
  const value = Number(process.argv[index + 1])
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const sample = readOption('--sample', 2000)
  const countSample = readOption('--count-sample', 50)
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  const client = await pool.connect()
  const mismatches: string[] = []

  try {
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
    await client.query("SET statement_timeout = '60s'")

    // Parity of derived fields, in batches of 100 newest-first
    let checked = 0
    let cursor: { timestamp: Date; requestId: string } | undefined
    while (checked < sample) {
      const params: unknown[] = [Math.min(100, sample - checked)]
      const bound = cursor ? 'AND (timestamp, request_id) < ($2::timestamptz, $3::uuid)' : ''
      if (cursor) {
        params.push(cursor.timestamp, cursor.requestId)
      }
      const { rows } = await client.query(
        `SELECT request_id, timestamp, body -> 'messages' -> -1 AS last_message
         FROM api_requests
         WHERE timestamp >= now() - interval '7 days' ${bound}
         ORDER BY timestamp DESC, request_id DESC
         LIMIT $1`,
        params
      )
      if (rows.length === 0) {
        break
      }
      for (const row of rows) {
        if (!row.last_message) {
          continue
        }
        const summary = JSON.parse(JSON.stringify(summarizeLastMessage(row.last_message)))
        const sameClass =
          JSON.stringify(classifyLastMessage(summary)) ===
          JSON.stringify(classifyLastMessage(row.last_message))
        const samePreview =
          getLastMessageContent({ request_id: row.request_id, last_message: summary } as any) ===
          getLastMessageContent({
            request_id: row.request_id,
            last_message: row.last_message,
          } as any)
        if (!sameClass || !samePreview) {
          mismatches.push(`derived:${row.request_id}`)
        }
        checked++
      }
      const last = rows[rows.length - 1]
      cursor = { timestamp: last.timestamp, requestId: last.request_id }
    }
    console.log(`Derived-field parity: ${checked} rows checked`)

    // SQL vs JS user-text count on smaller bodies (full message arrays cross the network)
    const { rows: countRows } = await client.query(
      `SELECT request_id, body -> 'messages' AS messages, ${userTextMessageCountSql('body')} AS sql_count
       FROM api_requests
       WHERE timestamp >= now() - interval '7 days' AND pg_column_size(body) < 1000000
       ORDER BY timestamp DESC
       LIMIT $1`,
      [countSample]
    )
    for (const row of countRows) {
      if (row.sql_count !== countUserTextMessages(row.messages)) {
        mismatches.push(`count:${row.request_id}`)
      }
    }
    console.log(`Count parity: ${countRows.length} rows checked`)
  } finally {
    client.release()
    await pool.end()
  }

  if (mismatches.length > 0) {
    console.error(
      `❌ ${mismatches.length} mismatches (first 5): ${mismatches.slice(0, 5).join(', ')}`
    )
    process.exit(1)
  }
  console.log('✅ All sampled rows match')
}

if (import.meta.main) {
  main()
}
```

Add to `scripts/README.md` after the backfill subsection:

```markdown
### verify-last-message-summary.ts

Read-only parity check for ADR-037: samples recent requests and confirms the dashboard derives the
same node types and previews from summaries as from full messages, and that the SQL and JS user-text
counts agree. Prints request ids only. `bun scripts/db/verify-last-message-summary.ts --sample 2000 --count-sample 50`
```

- [ ] **Step 2: Prepare the read-only production sandbox**

If `/tmp/e2e-explore/sandbox-env.sh` or `/tmp/e2e-explore/rds-global-bundle.pem` is missing, recreate them:

```bash
mkdir -p /tmp/e2e-explore
curl -sfo /tmp/e2e-explore/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
cat > /tmp/e2e-explore/sandbox-env.sh <<'EOF'
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000'
export HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9
export NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1
export AI_WORKER_ENABLED=false SLACK_ENABLED=false SLACK_WEBHOOK_URL= MCP_ENABLED=false MCP_WATCH_FILES=false
export NODE_EXTRA_CA_CERTS=/tmp/e2e-explore/rds-global-bundle.pem
case "$DATABASE_URL" in *sslmode=*) ;; *) export DATABASE_URL="${DATABASE_URL}?sslmode=verify-full&sslrootcert=/tmp/e2e-explore/rds-global-bundle.pem" ;; esac
EOF
```

Verify the guard in the same shell you will use:

```bash
set -a; . ./.env; set +a; . /tmp/e2e-explore/sandbox-env.sh
psql "$DATABASE_URL" -Atc "show default_transaction_read_only"
```

Expected: `on`. If it is not `on`, stop — do not continue with Steps 3–4.

- [ ] **Step 3: Run the parity check (read-only)**

```bash
set -a; . ./.env; set +a; . /tmp/e2e-explore/sandbox-env.sh
bun scripts/db/verify-last-message-summary.ts --sample 2000 --count-sample 50
```

Expected: `Derived-field parity: 2000 rows checked`, `Count parity: 50 rows checked`, `✅ All sampled rows match`, exit 0. Any mismatch: investigate with the printed request id (look only at structure — block types, lengths — never paste content), fix Task 1, and re-run Tasks 1, 4, 8 and this step.

- [ ] **Step 4: Measure the post-backfill query shape (read-only)**

Find the largest recent conversation, then time today's query and the post-backfill shape. The summary columns do not exist in production yet, so the post-backfill shape uses a non-foldable branch that never reads `body`:

The baseline query decompresses every body, so pick the most-requested conversation whose stored bodies stay under 1 GB (`pg_column_size` reads the TOAST pointer only, so this is cheap), and allow 120 s for this step only (still read-only):

```bash
set -a; . ./.env; set +a; . /tmp/e2e-explore/sandbox-env.sh
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=120000'
CONV=$(psql "$DATABASE_URL" -Atc "SELECT conversation_id FROM api_requests WHERE timestamp > now() - interval '30 days' AND conversation_id IS NOT NULL GROUP BY 1 HAVING sum(pg_column_size(body)) < 1000000000 ORDER BY count(*) DESC LIMIT 1")
psql "$DATABASE_URL" -Atc "SELECT count(*), pg_size_pretty(sum(pg_column_size(body))) FROM api_requests WHERE conversation_id = '$CONV'"

psql "$DATABASE_URL" -c "EXPLAIN (ANALYZE, BUFFERS)
WITH ranked_requests AS (
  SELECT request_id, timestamp, branch_id, response_body, body,
         ROW_NUMBER() OVER (PARTITION BY COALESCE(branch_id, 'main') ORDER BY timestamp DESC) AS rn
  FROM api_requests WHERE conversation_id = '$CONV'
)
SELECT request_id, response_body,
       CASE WHEN rn = 1 THEN body ELSE NULL END AS body,
       CASE WHEN body -> 'messages' IS NOT NULL AND jsonb_array_length(body -> 'messages') > 0
            THEN body -> 'messages' -> -1 END AS last_message
FROM ranked_requests ORDER BY timestamp" | tail -3

psql "$DATABASE_URL" -c "EXPLAIN (ANALYZE, BUFFERS)
WITH ranked_requests AS (
  SELECT request_id, timestamp, branch_id, response_body, body,
         ROW_NUMBER() OVER (PARTITION BY COALESCE(branch_id, 'main') ORDER BY timestamp DESC) AS rn
  FROM api_requests WHERE conversation_id = '$CONV'
)
SELECT request_id, response_body,
       CASE WHEN request_id IS NOT NULL THEN '{}'::jsonb ELSE body -> 'messages' -> -1 END AS last_message,
       CASE WHEN rn = 1 THEN 0 END AS user_text_message_count
FROM ranked_requests ORDER BY timestamp" | tail -3
```

Expected: the first (current) query reports several seconds of `Execution Time`; the second (post-backfill shape) reports **< 500 ms**. Record both numbers and the row count for the PR description. If the second exceeds 500 ms, stop and report — do not change the design without discussing it.

- [ ] **Step 5: Commit**

```bash
git add scripts/db/verify-last-message-summary.ts scripts/README.md
git commit -m "feat(db): add read-only parity check for last-message summaries

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Full quality gates, review and pull request

**Files:** none new (fixes only if a gate fails).

**Interfaces:**

- Consumes: the whole branch.
- Produces: a green branch and an open PR against `main`.

- [ ] **Step 1: Static gates**

```bash
bun run typecheck
bun run lint
bunx prettier --check $(git diff --name-only origin/main...HEAD)
grep -nP '[\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]' $(git diff --name-only origin/main...HEAD) || true
```

Expected: typecheck exit 0; lint `0 errors` and no new warnings in touched files (compare `bun run lint 2>&1 | grep -c warning` with the same command on `origin/main`: 255 warnings on 2026-09-23); prettier reports all files formatted; the `grep -nP` line prints nothing (no raw invisible characters).

- [ ] **Step 2: Unit and integration suites (no production access)**

```bash
env -u DATABASE_URL -u DB_HOST bun run test:ci
SUMMARY_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_test bun run test:db:summary
```

Expected: both pass. Confirm the new test files ran: the `test:ci` output lists `message-summary.test.ts`, `summary-columns.test.ts`, `storage-writer-summary.test.ts`, `last-message-parity.test.ts`, `conversation-timeline.test.ts`, `reader-conversation.test.ts`, `conversation-detail.test.ts` and `backfill-last-message-summary.test.ts`.

- [ ] **Step 3: E2E smoke and journeys on a fresh local database**

```bash
docker exec perf03-pg createdb -U postgres perf03_e2e_test
E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_e2e_test bun scripts/e2e/setup-database.ts
bun run build
TEST_START_SERVERS=true \
  E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/perf03_e2e_test \
  DASHBOARD_API_KEY=e2e-local-key \
  bunx playwright test --grep "@smoke|@journey" --project=chromium
bun run docker:validate
```

Expected: all Playwright tests pass (including Journey 3 with `timeline-content` visible); `docker:validate` exits 0.

- [ ] **Step 4: Independent code review**

Use superpowers:requesting-code-review on `origin/main...HEAD`, giving the reviewer the spec path and this plan. Fix every Critical and Important finding (each fix gets its own test where applicable and re-runs Steps 1–2). Expected: no unresolved Critical/Important findings.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin perf/conversation-detail-summary
gh pr create --base main --title "perf(dashboard): precomputed last-message summaries for conversation detail" --body-file - <<'EOF'
## Summary
- Store a truncated last-message summary and a user-text count with each request (ADR-037), so the conversation page no longer decompresses every stored body.
- Reader prefers the stored columns and falls back for legacy rows; no full bodies are sent to the dashboard any more.
- Sub-task lookups are batched; the timeline is lazy-loaded unless it is the active tab (shared builder keeps both paths identical).
- Resumable, dry-run-by-default backfill script and a read-only parity check.

## Measurements (production, read-only)
- Largest 30-day conversation: <ROWS> requests — current query <CURRENT_MS> ms → post-backfill shape <NEW_MS> ms (fill in from Task 9 Step 4).
- Parity check: 2000/2000 derived fields and 50/50 counts matched.

## Deploy order
1. `DATABASE_URL=… bun scripts/db/migrations/026-add-last-message-summary.ts up`
2. Deploy proxy and dashboard together.
3. `bun run db:backfill:last-message-summary` (dry run), then `--execute` off-peak (busiest hour is 20:00 UTC).
4. `bun scripts/db/verify-last-message-summary.ts` and re-measure the conversation page.

## Notes
- `countUserInteractions` keeps its existing selection of the first branch's latest request; unchanged here, worth revisiting separately.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

Before running, replace `<ROWS>`, `<CURRENT_MS>` and `<NEW_MS>` with the Task 9 Step 4 numbers.

Expected: PR URL printed. Then: `gh pr checks --watch` → all checks pass. If the known flaky `truncateConversation` timeout fails in build-and-test, re-run that job once.

- [ ] **Step 6: Clean up local resources**

```bash
docker rm -f perf03-pg
```

Expected: container removed.
