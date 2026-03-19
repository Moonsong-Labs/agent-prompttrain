# Project System Prompt Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-level system prompt that replaces the `system` field in Claude API requests, configurable via dashboard UI, disabled by default.

**Architecture:** Two new columns on `projects` table (`system_prompt_enabled`, `system_prompt`). Proxy mutates `rawRequest.system` after conversation tracking but before API forwarding. Dedicated dashboard API endpoint with membership auth. Dashboard UI section with JSON textarea.

**Tech Stack:** Bun, Hono, PostgreSQL (JSONB), HTMX, bun:test

**Spec:** `docs/superpowers/specs/2026-03-19-project-system-prompt-override-design.md`

---

## File Map

| Action | File                                                                   | Responsibility                                       |
| ------ | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| Modify | `packages/shared/src/types/claude.ts`                                  | Extract `SystemContentBlock` named type              |
| Modify | `packages/shared/src/types/credentials.ts`                             | Add fields to `Project`, `UpdateProjectRequest`      |
| Create | `scripts/db/migrations/020-add-system-prompt-to-projects.ts`           | DB migration                                         |
| Modify | `packages/shared/src/database/queries/project-queries.ts`              | Add `getProjectSystemPrompt`, update `updateProject` |
| Create | `packages/shared/src/utils/validate-system-prompt.ts`                  | Validation function                                  |
| Modify | `services/proxy/src/services/ProxyService.ts`                          | System prompt override logic                         |
| Modify | `services/dashboard/src/routes/projects.ts`                            | New API endpoint                                     |
| Modify | `services/dashboard/src/routes/projects-ui.ts`                         | Dashboard UI section + HTMX handler                  |
| Create | `services/proxy/src/services/__tests__/system-prompt-override.test.ts` | Unit tests                                           |
| Create | `packages/shared/src/utils/__tests__/validate-system-prompt.test.ts`   | Validation tests                                     |

---

### Task 1: Database Migration

**Files:**

- Create: `scripts/db/migrations/020-add-system-prompt-to-projects.ts`

- [ ] **Step 1: Create migration file**

```typescript
#!/usr/bin/env bun

/**
 * Migration: Add system prompt override columns to projects table
 *
 * Adds system_prompt_enabled (boolean, default false) and system_prompt (JSONB)
 * to allow projects to define a system prompt that replaces the one in incoming
 * Claude API requests.
 */

import { Pool } from 'pg'

async function up(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log('Adding system prompt columns to projects table...')

    // Add system_prompt_enabled column (idempotent)
    await client.query(`
      ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS system_prompt_enabled BOOLEAN NOT NULL DEFAULT false
    `)
    console.log('✓ Added system_prompt_enabled column')

    // Add system_prompt JSONB column (idempotent)
    await client.query(`
      ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS system_prompt JSONB DEFAULT NULL
    `)
    console.log('✓ Added system_prompt column')

    await client.query('COMMIT')
    console.log('✅ System prompt columns added successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to add system prompt columns:', error)
    throw error
  } finally {
    client.release()
  }
}

async function down(pool: Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    console.log('Removing system prompt columns from projects table...')

    await client.query('ALTER TABLE projects DROP COLUMN IF EXISTS system_prompt')
    console.log('✓ Dropped system_prompt column')

    await client.query('ALTER TABLE projects DROP COLUMN IF EXISTS system_prompt_enabled')
    console.log('✓ Dropped system_prompt_enabled column')

    await client.query('COMMIT')
    console.log('✅ System prompt columns removed successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Failed to remove system prompt columns:', error)
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
```

- [ ] **Step 2: Verify migration compiles**

Run: `bunx tsc --noEmit scripts/db/migrations/020-add-system-prompt-to-projects.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add scripts/db/migrations/020-add-system-prompt-to-projects.ts
git commit -m "feat(db): add migration 020 for project system prompt columns"
```

---

### Task 2: Type Definitions

**Files:**

- Modify: `packages/shared/src/types/claude.ts:41-49`
- Modify: `packages/shared/src/types/credentials.ts:56-69,143-151`

- [ ] **Step 1: Extract `SystemContentBlock` type in claude.ts**

In `packages/shared/src/types/claude.ts`, add the named interface before `ClaudeMessagesRequest` and update the inline type reference:

```typescript
// Add before ClaudeMessagesRequest (around line 38):
export interface SystemContentBlock {
  type: 'text'
  text: string
  cache_control?: {
    type: 'ephemeral'
  }
}

// Update ClaudeMessagesRequest.system to use the new type (lines 41-49):
system?: string | SystemContentBlock[]
```

- [ ] **Step 2: Add fields to Project and UpdateProjectRequest in credentials.ts**

In `packages/shared/src/types/credentials.ts`:

1. Add import at top:

```typescript
import type { SystemContentBlock } from './claude.js'
```

2. Add to `Project` interface (after `is_private` field, line ~66):

```typescript
system_prompt_enabled: boolean
system_prompt: SystemContentBlock[] | null
```

3. Add to `UpdateProjectRequest` interface (after `is_private` field, line ~150):

```typescript
system_prompt_enabled?: boolean
system_prompt?: SystemContentBlock[] | null
```

- [ ] **Step 3: Verify types compile**

Run: `bun run --cwd packages/shared tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/claude.ts packages/shared/src/types/credentials.ts
git commit -m "feat(shared): add SystemContentBlock type and project system prompt fields"
```

---

### Task 3: Validation Function

**Files:**

- Create: `packages/shared/src/utils/validate-system-prompt.ts`
- Create: `packages/shared/src/utils/__tests__/validate-system-prompt.test.ts`

- [ ] **Step 1: Write validation tests**

Create `packages/shared/src/utils/__tests__/validate-system-prompt.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test'
import { validateSystemPrompt } from '../validate-system-prompt'

describe('validateSystemPrompt', () => {
  test('returns valid for a correct system prompt array', () => {
    const result = validateSystemPrompt([
      { type: 'text', text: 'Hello world' },
      { type: 'text', text: 'Second block', cache_control: { type: 'ephemeral' } },
    ])
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  test('returns valid for null (no prompt configured)', () => {
    const result = validateSystemPrompt(null)
    expect(result.valid).toBe(true)
  })

  test('returns valid for empty array (treated as no override)', () => {
    const result = validateSystemPrompt([])
    expect(result.valid).toBe(true)
  })

  test('rejects non-array input', () => {
    const result = validateSystemPrompt('not an array' as any)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('array')
  })

  test('rejects block without type field', () => {
    const result = validateSystemPrompt([{ text: 'missing type' } as any])
    expect(result.valid).toBe(false)
    expect(result.error).toContain('type')
  })

  test('rejects block with wrong type value', () => {
    const result = validateSystemPrompt([{ type: 'image', text: 'wrong type' } as any])
    expect(result.valid).toBe(false)
    expect(result.error).toContain('text')
  })

  test('rejects block without text field', () => {
    const result = validateSystemPrompt([{ type: 'text' } as any])
    expect(result.valid).toBe(false)
    expect(result.error).toContain('text')
  })

  test('rejects block with non-string text', () => {
    const result = validateSystemPrompt([{ type: 'text', text: 123 } as any])
    expect(result.valid).toBe(false)
    expect(result.error).toContain('string')
  })

  test('rejects invalid cache_control structure', () => {
    const result = validateSystemPrompt([
      { type: 'text', text: 'hello', cache_control: { type: 'permanent' } } as any,
    ])
    expect(result.valid).toBe(false)
    expect(result.error).toContain('cache_control')
  })

  test('rejects payload exceeding 1MB', () => {
    const largeText = 'x'.repeat(1024 * 1024 + 1)
    const result = validateSystemPrompt([{ type: 'text', text: largeText }])
    expect(result.valid).toBe(false)
    expect(result.error).toContain('1MB')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/shared/src/utils/__tests__/validate-system-prompt.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write validation implementation**

Create `packages/shared/src/utils/validate-system-prompt.ts`:

```typescript
import type { SystemContentBlock } from '../types/claude.js'

const MAX_SYSTEM_PROMPT_SIZE = 1024 * 1024 // 1MB

interface ValidationResult {
  valid: boolean
  error?: string
}

/**
 * Validate a system prompt array for storage and use in Claude API requests.
 * Accepts null (no prompt) and empty array (treated as no override).
 */
export function validateSystemPrompt(
  prompt: SystemContentBlock[] | null | undefined
): ValidationResult {
  if (prompt === null || prompt === undefined) {
    return { valid: true }
  }

  if (!Array.isArray(prompt)) {
    return { valid: false, error: 'System prompt must be an array' }
  }

  if (prompt.length === 0) {
    return { valid: true }
  }

  // Check size limit
  const jsonSize = JSON.stringify(prompt).length
  if (jsonSize > MAX_SYSTEM_PROMPT_SIZE) {
    return { valid: false, error: `System prompt exceeds 1MB limit (${jsonSize} bytes)` }
  }

  // Validate each block
  for (let i = 0; i < prompt.length; i++) {
    const block = prompt[i]

    if (!block || typeof block !== 'object') {
      return { valid: false, error: `Block ${i}: must be an object` }
    }

    if (block.type !== 'text') {
      return { valid: false, error: `Block ${i}: type must be "text"` }
    }

    if (typeof block.text !== 'string') {
      return { valid: false, error: `Block ${i}: text must be a string` }
    }

    if (block.cache_control !== undefined) {
      if (
        !block.cache_control ||
        typeof block.cache_control !== 'object' ||
        block.cache_control.type !== 'ephemeral'
      ) {
        return {
          valid: false,
          error: `Block ${i}: cache_control must be { type: "ephemeral" }`,
        }
      }
    }
  }

  return { valid: true }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/shared/src/utils/__tests__/validate-system-prompt.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Export from shared package**

Add to `packages/shared/src/utils/index.ts` (or the main barrel export):

```typescript
export { validateSystemPrompt } from './validate-system-prompt.js'
```

Check where shared exports are: `packages/shared/src/index.ts` — add the export there if that's the pattern.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/utils/validate-system-prompt.ts packages/shared/src/utils/__tests__/validate-system-prompt.test.ts
git commit -m "feat(shared): add system prompt validation function with tests"
```

---

### Task 4: Database Query Functions

**Files:**

- Modify: `packages/shared/src/database/queries/project-queries.ts`

- [ ] **Step 1: Add `getProjectSystemPrompt` query function**

Add to `packages/shared/src/database/queries/project-queries.ts`:

```typescript
import type { SystemContentBlock } from '../../types/claude.js'

/**
 * Get system prompt configuration for a project.
 * Used by the proxy to determine if system prompt override is enabled.
 */
export async function getProjectSystemPrompt(
  pool: Pool,
  projectId: string
): Promise<{ enabled: boolean; system_prompt: SystemContentBlock[] | null } | null> {
  const result = await pool.query<{
    system_prompt_enabled: boolean
    system_prompt: SystemContentBlock[] | null
  }>('SELECT system_prompt_enabled, system_prompt FROM projects WHERE project_id = $1', [projectId])

  if (result.rows.length === 0) {
    return null
  }

  return {
    enabled: result.rows[0].system_prompt_enabled,
    system_prompt: result.rows[0].system_prompt,
  }
}
```

- [ ] **Step 2: Update `updateProject` to handle system prompt fields**

In `updateProject` function, add two new field handlers after the `is_private` block (around line 167):

```typescript
if (request.system_prompt_enabled !== undefined) {
  updates.push(`system_prompt_enabled = $${paramIndex++}`)
  values.push(request.system_prompt_enabled)
}
if (request.system_prompt !== undefined) {
  updates.push(`system_prompt = $${paramIndex++}`)
  values.push(request.system_prompt ? JSON.stringify(request.system_prompt) : null)
}
```

- [ ] **Step 3: Export `getProjectSystemPrompt` from index**

Add `getProjectSystemPrompt` to the exports in `packages/shared/src/database/queries/index.ts` (already exports from `project-queries` via `export *`).

Verify it's re-exported: check that `packages/shared/src/database/queries/index.ts` has `export * from './project-queries'`.

- [ ] **Step 4: Verify types compile**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/database/queries/project-queries.ts
git commit -m "feat(shared): add getProjectSystemPrompt query and update updateProject"
```

---

### Task 5: Proxy System Prompt Override Logic

**Files:**

- Modify: `services/proxy/src/services/ProxyService.ts:148-151`
- Create: `services/proxy/src/services/__tests__/system-prompt-override.test.ts`

- [ ] **Step 1: Write unit tests for system prompt override**

Create `services/proxy/src/services/__tests__/system-prompt-override.test.ts`:

```typescript
import { describe, test, expect, beforeEach, mock } from 'bun:test'
import type { SystemContentBlock } from '@agent-prompttrain/shared'

// Mock the query module
const mockGetProjectSystemPrompt = mock<
  (
    pool: any,
    projectId: string
  ) => Promise<{
    enabled: boolean
    system_prompt: SystemContentBlock[] | null
  } | null>
>(() => Promise.resolve(null))

mock.module('@agent-prompttrain/shared/database/queries', () => ({
  getProjectSystemPrompt: mockGetProjectSystemPrompt,
  getProjectSlackConfig: mock(() => Promise.resolve(null)),
  getProjectLinkedCredentials: mock(() => Promise.resolve([])),
  getProjectCredentials: mock(() => Promise.resolve([])),
}))

mock.module('../../middleware/logger', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  },
  getRequestLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}))

import { applySystemPromptOverride } from '../system-prompt-override'

describe('applySystemPromptOverride', () => {
  beforeEach(() => {
    mockGetProjectSystemPrompt.mockReset()
  })

  test('replaces system field when override is enabled with non-empty array', async () => {
    const override: SystemContentBlock[] = [{ type: 'text', text: 'Custom prompt' }]
    mockGetProjectSystemPrompt.mockResolvedValueOnce({
      enabled: true,
      system_prompt: override,
    })

    const rawRequest = {
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user' as const, content: 'hi' }],
      max_tokens: 1024,
      system: 'original prompt',
    }

    const pool = {} as any
    await applySystemPromptOverride(rawRequest, 'test-project', pool)

    expect(rawRequest.system).toEqual(override)
  })

  test('adds system field when request has none and override is enabled', async () => {
    const override: SystemContentBlock[] = [{ type: 'text', text: 'Injected prompt' }]
    mockGetProjectSystemPrompt.mockResolvedValueOnce({
      enabled: true,
      system_prompt: override,
    })

    const rawRequest = {
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user' as const, content: 'hi' }],
      max_tokens: 1024,
    } as any

    const pool = {} as any
    await applySystemPromptOverride(rawRequest, 'test-project', pool)

    expect(rawRequest.system).toEqual(override)
  })

  test('does not modify request when override is disabled', async () => {
    mockGetProjectSystemPrompt.mockResolvedValueOnce({
      enabled: false,
      system_prompt: [{ type: 'text', text: 'Unused prompt' }],
    })

    const rawRequest = {
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user' as const, content: 'hi' }],
      max_tokens: 1024,
      system: 'original prompt',
    }

    const pool = {} as any
    await applySystemPromptOverride(rawRequest, 'test-project', pool)

    expect(rawRequest.system).toBe('original prompt')
  })

  test('does not modify request when system_prompt is null', async () => {
    mockGetProjectSystemPrompt.mockResolvedValueOnce({
      enabled: true,
      system_prompt: null,
    })

    const rawRequest = {
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user' as const, content: 'hi' }],
      max_tokens: 1024,
      system: 'original prompt',
    }

    const pool = {} as any
    await applySystemPromptOverride(rawRequest, 'test-project', pool)

    expect(rawRequest.system).toBe('original prompt')
  })

  test('does not modify request when system_prompt is empty array', async () => {
    mockGetProjectSystemPrompt.mockResolvedValueOnce({
      enabled: true,
      system_prompt: [],
    })

    const rawRequest = {
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user' as const, content: 'hi' }],
      max_tokens: 1024,
      system: 'original prompt',
    }

    const pool = {} as any
    await applySystemPromptOverride(rawRequest, 'test-project', pool)

    expect(rawRequest.system).toBe('original prompt')
  })

  test('does not modify request when project not found', async () => {
    mockGetProjectSystemPrompt.mockResolvedValueOnce(null)

    const rawRequest = {
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user' as const, content: 'hi' }],
      max_tokens: 1024,
      system: 'original prompt',
    }

    const pool = {} as any
    await applySystemPromptOverride(rawRequest, 'unknown-project', pool)

    expect(rawRequest.system).toBe('original prompt')
  })

  test('replaces array system field with override', async () => {
    const override: SystemContentBlock[] = [
      { type: 'text', text: 'Override', cache_control: { type: 'ephemeral' } },
    ]
    mockGetProjectSystemPrompt.mockResolvedValueOnce({
      enabled: true,
      system_prompt: override,
    })

    const rawRequest = {
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user' as const, content: 'hi' }],
      max_tokens: 1024,
      system: [{ type: 'text' as const, text: 'Original array prompt' }],
    }

    const pool = {} as any
    await applySystemPromptOverride(rawRequest, 'test-project', pool)

    expect(rawRequest.system).toEqual(override)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test services/proxy/src/services/__tests__/system-prompt-override.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create system prompt override module**

Create `services/proxy/src/services/system-prompt-override.ts`:

```typescript
import type { Pool } from 'pg'
import type { ClaudeMessagesRequest } from '@agent-prompttrain/shared'
import { getProjectSystemPrompt } from '@agent-prompttrain/shared/database/queries'
import { logger } from '../middleware/logger'

/**
 * Apply project-level system prompt override to a request.
 * Mutates rawRequest.system if the project has an enabled, non-empty system prompt.
 * Must be called AFTER conversation tracking (which needs the original system)
 * and BEFORE forwarding to Claude API.
 */
export async function applySystemPromptOverride(
  rawRequest: ClaudeMessagesRequest,
  projectId: string,
  pool: Pool
): Promise<void> {
  try {
    const config = await getProjectSystemPrompt(pool, projectId)

    if (!config || !config.enabled) {
      return
    }

    if (!config.system_prompt || config.system_prompt.length === 0) {
      return
    }

    logger.debug('Applying project system prompt override', {
      projectId,
      blockCount: config.system_prompt.length,
      hadOriginalSystem: !!rawRequest.system,
    })

    rawRequest.system = config.system_prompt
  } catch (error) {
    logger.warn('Failed to apply system prompt override, using original', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test services/proxy/src/services/__tests__/system-prompt-override.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Integrate into ProxyService.handleRequest()**

In `services/proxy/src/services/ProxyService.ts`:

1. Add import at top:

```typescript
import { applySystemPromptOverride } from './system-prompt-override'
```

2. After the conversation tracking try/catch block (~line 149, before the `try {` block that starts authentication at ~line 151), add:

```typescript
// Apply project system prompt override (after conversation tracking, before forwarding)
if (this.storageAdapter) {
  const pool = this.storageAdapter.getPool()
  await applySystemPromptOverride(rawRequest, context.projectId, pool)
}
```

- [ ] **Step 6: Verify types compile**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add services/proxy/src/services/system-prompt-override.ts services/proxy/src/services/__tests__/system-prompt-override.test.ts services/proxy/src/services/ProxyService.ts
git commit -m "feat(proxy): add system prompt override logic with tests"
```

---

### Task 6: Dashboard API Endpoint

**Files:**

- Modify: `services/dashboard/src/routes/projects.ts:107-122`

- [ ] **Step 1: Add PUT /api/projects/:id/system-prompt endpoint**

In `services/dashboard/src/routes/projects.ts`, add after the `PUT /:id/default-account` route (line ~122):

```typescript
import { validateSystemPrompt } from '@agent-prompttrain/shared'
// (add to existing imports at top)

// PUT /api/projects/:id/system-prompt - Update system prompt (member only)
projects.put('/:id/system-prompt', requireProjectMembership, async c => {
  try {
    const pool = container.getPool()
    const id = c.req.param('id')
    const body = await c.req.json<{
      system_prompt_enabled?: boolean
      system_prompt?: any[] | null
    }>()

    // Validate system prompt if provided
    if (body.system_prompt !== undefined) {
      const validation = validateSystemPrompt(body.system_prompt)
      if (!validation.valid) {
        return c.json({ error: `Invalid system prompt: ${validation.error}` }, 400)
      }
    }

    const train = await updateProject(pool, id, {
      system_prompt_enabled: body.system_prompt_enabled,
      system_prompt: body.system_prompt,
    })

    return c.json({ train })
  } catch (error: any) {
    console.error('Failed to update system prompt:', error)
    if (error.message.includes('not found')) {
      return c.json({ error: 'Project not found' }, 404)
    }
    return c.json({ error: 'Failed to update system prompt' }, 500)
  }
})
```

- [ ] **Step 2: Ensure `validateSystemPrompt` is exported from shared package**

Verify the export added in Task 3 Step 5 is accessible via `@agent-prompttrain/shared`.

- [ ] **Step 3: Verify types compile**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add services/dashboard/src/routes/projects.ts
git commit -m "feat(dashboard): add PUT /api/projects/:id/system-prompt endpoint"
```

---

### Task 7: Dashboard UI — System Prompt Section

**Files:**

- Modify: `services/dashboard/src/routes/projects-ui.ts`

- [ ] **Step 1: Add System Prompt section to project detail page**

In `services/dashboard/src/routes/projects-ui.ts`, find the project detail view route (GET `/:projectId/view`). After the Privacy Settings section (~line 515) and before the Default Account section (~line 517), add:

```typescript
        <!-- System Prompt Section (Members Only) -->
        ${isMember
          ? html`
              <div
                style="background: white; border: 1px solid #e5e7eb; border-radius: 0.5rem; padding: 1.5rem; margin-bottom: 1.5rem;"
                id="system-prompt-settings"
              >
                <h3 style="font-size: 1.125rem; font-weight: bold; margin-bottom: 0.5rem;">
                  System Prompt Override
                </h3>
                <p style="font-size: 0.75rem; color: #6b7280; margin-bottom: 1rem;">
                  When enabled, replaces the system prompt in all Claude API requests routed through
                  this project. The original system prompt from the request is discarded.
                </p>

                <div style="background: #f3f4f6; padding: 1rem; border-radius: 0.25rem; margin-bottom: 0.75rem;">
                  <form
                    hx-post="/dashboard/projects/${train.id}/toggle-system-prompt"
                    hx-swap="outerHTML"
                    hx-target="#system-prompt-settings"
                    style="display: flex; align-items: center; justify-content: space-between;"
                  >
                    <div>
                      <div style="font-weight: 600; font-size: 0.875rem; margin-bottom: 0.25rem;">
                        Status: ${train.system_prompt_enabled ? '✅ Enabled' : '⏸️ Disabled'}
                      </div>
                      <div style="font-size: 0.75rem; color: #6b7280;">
                        ${train.system_prompt_enabled
                          ? 'System prompt override is active for all requests.'
                          : 'Requests pass through with their original system prompt.'}
                      </div>
                    </div>
                    <button
                      type="submit"
                      style="background: ${train.system_prompt_enabled
                        ? '#f59e0b'
                        : '#10b981'}; color: white; padding: 0.5rem 1rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer; font-size: 0.875rem;"
                    >
                      ${train.system_prompt_enabled ? 'Disable' : 'Enable'}
                    </button>
                  </form>
                </div>

                <div>
                  <label
                    style="display: block; font-weight: 600; font-size: 0.875rem; margin-bottom: 0.5rem;"
                  >
                    System Prompt (JSON array of content blocks):
                    ${train.system_prompt && Array.isArray(train.system_prompt) && train.system_prompt.length > 0
                      ? html`<span style="color: #6b7280; font-weight: 400;"
                          >${train.system_prompt.length} block(s) configured</span
                        >`
                      : html`<span style="color: #9ca3af; font-weight: 400;">not configured</span>`}
                  </label>
                  <form
                    hx-put="/dashboard/projects/${train.id}/system-prompt"
                    hx-swap="outerHTML"
                    hx-target="#system-prompt-settings"
                  >
                    <textarea
                      name="system_prompt"
                      rows="10"
                      style="width: 100%; font-family: monospace; font-size: 0.8125rem; padding: 0.75rem; border: 1px solid #d1d5db; border-radius: 0.25rem; resize: vertical; box-sizing: border-box;"
                      placeholder='[{"type": "text", "text": "Your system prompt here"}]'
                    >${train.system_prompt ? JSON.stringify(train.system_prompt, null, 2) : ''}</textarea>
                    <div style="display: flex; justify-content: flex-end; margin-top: 0.5rem;">
                      <button
                        type="submit"
                        style="background: #3b82f6; color: white; padding: 0.5rem 1rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer; font-size: 0.875rem;"
                      >
                        Save System Prompt
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            `
          : ''}
```

Note: `isMember` needs to be determined. Check the existing view code to see if a membership check variable already exists. If not, add:

```typescript
const isMember = auth.isAuthenticated && (await isProjectMember(pool, train.id, auth.principal))
```

- [ ] **Step 2: Add HTMX handlers for toggle and save**

Add two new POST/PUT handlers in the same file (near the `toggle-privacy` handler at ~line 1571):

**Toggle handler:**

```typescript
trainsUIRoutes.post('/:projectId/toggle-system-prompt', async c => {
  const projectId = c.req.param('projectId')
  const pool = container.getPool()
  const auth = c.get('auth')

  if (!pool) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        Database not configured
      </div>
    `)
  }

  if (!auth.isAuthenticated) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        <strong>Error:</strong> Unauthorized - please log in
      </div>
    `)
  }

  try {
    const isMember = await isProjectMember(pool, projectId, auth.principal)
    if (!isMember) {
      return c.html(html`
        <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
          <strong>Error:</strong> Only project members can change system prompt settings
        </div>
      `)
    }

    const project = await getProjectById(pool, projectId)
    if (!project) {
      return c.html(html`
        <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
          Project not found
        </div>
      `)
    }

    const newEnabled = !project.system_prompt_enabled
    await updateProject(pool, projectId, { system_prompt_enabled: newEnabled })

    // Re-fetch to get updated state and return the full section
    const updatedProject = await getProjectById(pool, projectId)
    // Return a redirect to reload the page (simplest approach for full section re-render)
    return c.redirect(`/dashboard/projects/${updatedProject!.project_id}/view`)
  } catch (error) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        Error: ${getErrorMessage(error)}
      </div>
    `)
  }
})
```

**Save handler:**

```typescript
trainsUIRoutes.put('/:projectId/system-prompt', async c => {
  const projectId = c.req.param('projectId')
  const pool = container.getPool()
  const auth = c.get('auth')

  if (!pool) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        Database not configured
      </div>
    `)
  }

  if (!auth.isAuthenticated) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        <strong>Error:</strong> Unauthorized - please log in
      </div>
    `)
  }

  try {
    const isMember = await isProjectMember(pool, projectId, auth.principal)
    if (!isMember) {
      return c.html(html`
        <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
          <strong>Error:</strong> Only project members can update the system prompt
        </div>
      `)
    }

    const formData = await c.req.parseBody()
    const rawJson = formData['system_prompt'] as string

    let systemPrompt: any[] | null = null
    if (rawJson && rawJson.trim()) {
      try {
        systemPrompt = JSON.parse(rawJson)
      } catch {
        return c.html(html`
          <div
            style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;"
          >
            <strong>Error:</strong> Invalid JSON. Please ensure the system prompt is valid JSON.
          </div>
        `)
      }
    }

    // Validate using shared validation
    const { validateSystemPrompt } = await import('@agent-prompttrain/shared')
    const validation = validateSystemPrompt(systemPrompt)
    if (!validation.valid) {
      return c.html(html`
        <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
          <strong>Error:</strong> ${validation.error}
        </div>
      `)
    }

    await updateProject(pool, projectId, { system_prompt: systemPrompt })

    // Redirect to reload the page with updated data
    const project = await getProjectById(pool, projectId)
    return c.redirect(`/dashboard/projects/${project!.project_id}/view`)
  } catch (error) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        Error: ${getErrorMessage(error)}
      </div>
    `)
  }
})
```

- [ ] **Step 3: Ensure required imports are added**

At the top of `projects-ui.ts`, ensure these are imported:

- `isProjectMember` from `@agent-prompttrain/shared/database/queries` (may already be imported)
- `getProjectById` from `@agent-prompttrain/shared/database/queries` (may already be imported)

- [ ] **Step 4: Verify types compile**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add services/dashboard/src/routes/projects-ui.ts
git commit -m "feat(dashboard): add system prompt UI section with toggle and JSON editor"
```

---

### Task 8: Integration Verification & Typecheck

**Files:**

- All modified files

- [ ] **Step 1: Run full typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 2: Run all unit tests**

Run: `bun test`
Expected: All tests pass (including new system prompt tests)

- [ ] **Step 3: Build shared package**

Run: `bun run build`
Expected: Build succeeds

- [ ] **Step 4: Fix any issues found**

Address any compilation errors, test failures, or build issues.

- [ ] **Step 5: Final commit if fixes were needed**

```bash
git add -A
git commit -m "fix: address integration issues in system prompt override feature"
```

---

### Task 9: Documentation Updates

**Files:**

- Check and update relevant docs

- [ ] **Step 1: Search for documentation that references project fields or API**

Check these files for needed updates:

- `docs/02-User-Guide/api-reference.md` — add system prompt endpoint
- `docs/06-Reference/environment-vars.md` — no new env vars needed
- `docs/06-Reference/changelog.md` — add entry
- `docs/00-Overview/features.md` — mention system prompt override

- [ ] **Step 2: Update API reference**

Add the new `PUT /api/projects/:id/system-prompt` endpoint to `docs/02-User-Guide/api-reference.md`.

- [ ] **Step 3: Update changelog**

Add entry to `docs/06-Reference/changelog.md`.

- [ ] **Step 4: Commit documentation**

```bash
git add docs/
git commit -m "docs: add system prompt override to API reference and changelog"
```
