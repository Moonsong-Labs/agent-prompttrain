# Account Pool UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add UI and API support for linking/unlinking accounts to a project's account pool, replacing direct SQL management.

**Architecture:** Extend the existing project detail page with link/unlink buttons per credential. New query functions handle the `project_accounts` junction table. HTMX endpoints return refreshed section partials. The `ProjectWithAccounts` type gains `linked_account_ids` to track pool membership.

**Tech Stack:** Bun, Hono, HTMX, PostgreSQL, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-25-account-pool-ui-design.md`

---

## File Structure

| File                                                             | Action | Responsibility                                                                                                                     |
| ---------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/types/credentials.ts`                       | Modify | Add `linked_account_ids` to `ProjectWithAccounts`                                                                                  |
| `packages/shared/src/database/queries/project-queries.ts`        | Modify | Add `addProjectAccount`, `removeProjectAccount`; update `getProjectWithAccounts`, `listProjectsWithAccounts` to include linked IDs |
| `packages/shared/src/database/queries/project-member-queries.ts` | Modify | Fix stale `anthropic_credentials` table ref; add `linked_account_ids` to `getUserProjectsWithAccounts`                             |
| `services/dashboard/src/routes/projects.ts`                      | Modify | Add `POST /api/projects/:id/accounts` and `DELETE /api/projects/:id/accounts/:credentialId`                                        |
| `services/dashboard/src/routes/projects-ui.ts`                   | Modify | Replace "Default Account" section with "Accounts" section; add HTMX link/unlink handlers                                           |

---

### Task 1: Update `ProjectWithAccounts` Type

**Files:**

- Modify: `packages/shared/src/types/credentials.ts:75-77`

- [ ] **Step 1: Add `linked_account_ids` field**

In `packages/shared/src/types/credentials.ts`, change:

```typescript
export interface ProjectWithAccounts extends Project {
  accounts: CredentialSafe[]
  linked_account_ids: string[]
}
```

- [ ] **Step 2: Run typecheck to see what breaks**

Run: `bun run typecheck`

Expected: Errors in files that construct `ProjectWithAccounts` without `linked_account_ids` — specifically `project-queries.ts` and `project-member-queries.ts`. This confirms the type change propagates correctly.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types/credentials.ts
git commit -m "feat: add linked_account_ids to ProjectWithAccounts type"
```

---

### Task 2: Add Query Functions and Update Existing Queries

**Files:**

- Modify: `packages/shared/src/database/queries/project-queries.ts`
- Modify: `packages/shared/src/database/queries/project-member-queries.ts`

- [ ] **Step 1: Add `addProjectAccount` function**

Append to `project-queries.ts` after the existing `getProjectLinkedCredentials` function:

```typescript
/**
 * Link a credential to a project's account pool.
 * Idempotent — returns true if inserted, false if already linked.
 */
export async function addProjectAccount(
  pool: Pool,
  projectUuid: string,
  credentialId: string
): Promise<boolean> {
  const result = await pool.query(
    `
    INSERT INTO project_accounts (project_id, credential_id)
    VALUES ($1, $2)
    ON CONFLICT (project_id, credential_id) DO NOTHING
    `,
    [projectUuid, credentialId]
  )
  return (result.rowCount ?? 0) > 0
}
```

- [ ] **Step 2: Add `removeProjectAccount` function**

Append to `project-queries.ts`:

```typescript
/**
 * Unlink a credential from a project's account pool.
 * Returns true if removed, false if wasn't linked.
 */
export async function removeProjectAccount(
  pool: Pool,
  projectUuid: string,
  credentialId: string
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM project_accounts WHERE project_id = $1 AND credential_id = $2`,
    [projectUuid, credentialId]
  )
  return (result.rowCount ?? 0) > 0
}
```

- [ ] **Step 3: Update `getProjectWithAccounts` to include `linked_account_ids`**

In `project-queries.ts`, replace the `getProjectWithAccounts` function body. After fetching the train and all credentials, add a query to get linked account IDs:

```typescript
export async function getProjectWithAccounts(
  pool: Pool,
  projectId: string
): Promise<ProjectWithAccounts | null> {
  const train = await getProjectByProjectId(pool, projectId)
  if (!train) {
    return null
  }

  // All projects have access to all credentials
  const accountsResult = await pool.query<Credential>(
    `SELECT * FROM credentials ORDER BY account_name ASC`
  )

  // Get linked account IDs from junction table
  const linkedResult = await pool.query<{ credential_id: string }>(
    `SELECT credential_id FROM project_accounts WHERE project_id = $1`,
    [train.id]
  )
  const linkedAccountIds = linkedResult.rows.map(r => r.credential_id)

  return {
    ...train,
    accounts: accountsResult.rows.map(cred => toSafeCredential(cred)),
    linked_account_ids: linkedAccountIds,
  }
}
```

- [ ] **Step 4: Update `listProjectsWithAccounts` to include `linked_account_ids`**

In `project-queries.ts`, replace the `listProjectsWithAccounts` function body:

```typescript
export async function listProjectsWithAccounts(pool: Pool): Promise<ProjectWithAccounts[]> {
  const projects = await listProjects(pool)

  // Get all credentials once (shared across all projects)
  const accountsResult = await pool.query<Credential>(
    `SELECT * FROM credentials ORDER BY account_name ASC`
  )
  const allAccounts = accountsResult.rows.map(cred => toSafeCredential(cred))

  // Get all project-account links in one query
  const linksResult = await pool.query<{ project_id: string; credential_id: string }>(
    `SELECT project_id, credential_id FROM project_accounts`
  )

  // Group linked IDs by project
  const linksByProject = new Map<string, string[]>()
  for (const link of linksResult.rows) {
    const existing = linksByProject.get(link.project_id) ?? []
    existing.push(link.credential_id)
    linksByProject.set(link.project_id, existing)
  }

  return projects.map(train => ({
    ...train,
    accounts: allAccounts,
    linked_account_ids: linksByProject.get(train.id) ?? [],
  }))
}
```

- [ ] **Step 5: Fix `getUserProjectsWithAccounts` in `project-member-queries.ts`**

This function uses the stale `anthropic_credentials` table name. Fix and add `linked_account_ids`. The import for `Credential` type needs to be added if not present.

In `project-member-queries.ts`, find and replace the `getUserProjectsWithAccounts` function:

```typescript
export async function getUserProjectsWithAccounts(
  pool: Pool,
  userEmail: string
): Promise<ProjectWithAccounts[]> {
  const projects = await getUserProjects(pool, userEmail)

  // All projects have access to all credentials
  const accountsResult = await pool.query<Credential>(
    `SELECT * FROM credentials ORDER BY account_name ASC`
  )
  const allAccounts = accountsResult.rows.map(cred => toSafeCredential(cred))

  // Get all project-account links for these projects in one query
  const projectIds = projects.map(p => p.id)
  const linksResult =
    projectIds.length > 0
      ? await pool.query<{ project_id: string; credential_id: string }>(
          `SELECT project_id, credential_id FROM project_accounts WHERE project_id = ANY($1)`,
          [projectIds]
        )
      : { rows: [] }

  const linksByProject = new Map<string, string[]>()
  for (const link of linksResult.rows) {
    const existing = linksByProject.get(link.project_id) ?? []
    existing.push(link.credential_id)
    linksByProject.set(link.project_id, existing)
  }

  return projects.map(project => ({
    ...project,
    accounts: allAccounts,
    linked_account_ids: linksByProject.get(project.id) ?? [],
  }))
}
```

Ensure the `Credential` type import exists at the top of `project-member-queries.ts`. If `AnthropicCredential` is imported, replace it with `Credential` (or add it alongside).

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`

Expected: PASS — all `ProjectWithAccounts` construction sites now include `linked_account_ids`.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/database/queries/project-queries.ts packages/shared/src/database/queries/project-member-queries.ts
git commit -m "feat: add project account pool query functions and linked_account_ids"
```

---

### Task 3: Export New Query Functions

**Files:**

- Modify: `packages/shared/src/database/queries/index.ts`

- [ ] **Step 1: Verify exports are already re-exported**

The index file uses `export * from './project-queries'` so `addProjectAccount` and `removeProjectAccount` are already exported. Verify by running:

Run: `bun run typecheck`

Expected: PASS — no changes needed if wildcard re-export is in place.

- [ ] **Step 2: Commit (skip if no changes needed)**

Only commit if changes were required.

---

### Task 4: Add API Endpoints

**Files:**

- Modify: `services/dashboard/src/routes/projects.ts`

- [ ] **Step 1: Add imports for new query functions**

In `services/dashboard/src/routes/projects.ts`, add `addProjectAccount` and `removeProjectAccount` to the import from `@agent-prompttrain/shared/database/queries`. Also add `getProjectById` if not already imported.

```typescript
import {
  getProjectWithAccounts,
  getProjectById,
  createProject,
  updateProject,
  setProjectDefaultAccount,
  addProjectMember,
  addProjectAccount,
  removeProjectAccount,
  getUserProjectsWithAccounts,
  deleteProject,
} from '@agent-prompttrain/shared/database/queries'
```

- [ ] **Step 2: Add POST endpoint to link an account**

Add before the `export default projects` line:

```typescript
// POST /api/projects/:id/accounts - Link account to project pool (owner only)
projects.post('/:id/accounts', requireProjectOwner, async c => {
  try {
    const pool = container.getPool()
    const projectId = c.req.param('id')
    const { credential_id } = await c.req.json<{ credential_id: string }>()

    if (!credential_id) {
      return c.json({ error: 'credential_id is required' }, 400)
    }

    const added = await addProjectAccount(pool, projectId, credential_id)
    return c.json({ linked: added }, added ? 201 : 200)
  } catch (error: any) {
    console.error('Failed to link account:', error)
    if (error.code === '23503') {
      return c.json({ error: 'Invalid credential ID' }, 400)
    }
    return c.json({ error: 'Failed to link account' }, 500)
  }
})
```

- [ ] **Step 3: Add DELETE endpoint to unlink an account**

Add after the POST endpoint:

```typescript
// DELETE /api/projects/:id/accounts/:credentialId - Unlink account from project pool (owner only)
projects.delete('/:id/accounts/:credentialId', requireProjectOwner, async c => {
  try {
    const pool = container.getPool()
    const projectId = c.req.param('id')
    const credentialId = c.req.param('credentialId')

    // Prevent unlinking the default account
    const project = await getProjectById(pool, projectId)
    if (project?.default_account_id === credentialId) {
      return c.json({ error: 'Cannot unlink the default account. Change the default first.' }, 400)
    }

    const removed = await removeProjectAccount(pool, projectId, credentialId)
    if (!removed) {
      return c.json({ error: 'Account was not linked to this project' }, 404)
    }

    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to unlink account:', error)
    return c.json({ error: 'Failed to unlink account' }, 500)
  }
})
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/dashboard/src/routes/projects.ts
git commit -m "feat: add API endpoints for project account pool management"
```

---

### Task 5: Add HTMX Handlers for Link/Unlink

**Files:**

- Modify: `services/dashboard/src/routes/projects-ui.ts`

- [ ] **Step 1: Add imports**

Add `addProjectAccount`, `removeProjectAccount`, and `getProjectById` to the imports from `@agent-prompttrain/shared/database/queries` in `projects-ui.ts` (if not already present).

- [ ] **Step 2: Add link-account HTMX handler**

Add after the `set-default-account` handler (after line 1444):

```typescript
/**
 * Link an account to a project's pool (HTMX form submission - owner only)
 */
trainsUIRoutes.post('/:projectId/link-account', async c => {
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

  const isOwner = await isProjectOwner(pool, projectId, auth.principal)
  if (!isOwner) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        <strong>Error:</strong> Only project owners can manage the account pool
      </div>
    `)
  }

  try {
    const formData = await c.req.parseBody()
    const credentialId = formData.credential_id as string

    await addProjectAccount(pool, projectId, credentialId)

    return c.html(html`
      <div
        style="background: #d1fae5; color: #065f46; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1rem;"
      >
        <strong>Account linked to pool.</strong>
      </div>
      <script>
        setTimeout(() => location.reload(), 1500)
      </script>
    `)
  } catch (error) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        Error: ${getErrorMessage(error)}
      </div>
    `)
  }
})
```

- [ ] **Step 3: Add unlink-account HTMX handler**

Add after the link-account handler:

```typescript
/**
 * Unlink an account from a project's pool (HTMX form submission - owner only)
 */
trainsUIRoutes.delete('/:projectId/unlink-account/:credentialId', async c => {
  const projectId = c.req.param('projectId')
  const credentialId = c.req.param('credentialId')
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

  const isOwner = await isProjectOwner(pool, projectId, auth.principal)
  if (!isOwner) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        <strong>Error:</strong> Only project owners can manage the account pool
      </div>
    `)
  }

  try {
    // Prevent unlinking the default account
    const project = await getProjectById(pool, projectId)
    if (project?.default_account_id === credentialId) {
      return c.html(html`
        <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
          <strong>Error:</strong> Cannot unlink the default account. Change the default first.
        </div>
      `)
    }

    await removeProjectAccount(pool, projectId, credentialId)

    return c.html(html`
      <div
        style="background: #d1fae5; color: #065f46; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1rem;"
      >
        <strong>Account removed from pool.</strong>
      </div>
      <script>
        setTimeout(() => location.reload(), 1500)
      </script>
    `)
  } catch (error) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        Error: ${getErrorMessage(error)}
      </div>
    `)
  }
})
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/dashboard/src/routes/projects-ui.ts
git commit -m "feat: add HTMX handlers for account pool link/unlink"
```

---

### Task 6: Replace Default Account UI with Accounts Section

**Files:**

- Modify: `services/dashboard/src/routes/projects-ui.ts` (lines 608-694, the Default Account section in the detail page)

- [ ] **Step 1: Replace the Default Account section**

In `projects-ui.ts`, find the "Default Account Section" block (starts around line 608 with `<!-- Default Account Section -->` and ends around line 694 closing `</div>`). Replace the entire section with the new "Accounts" section.

The new section replaces lines 608-694:

```typescript
        <!-- Accounts Section -->
        <div
          style="background: white; border: 1px solid #e5e7eb; border-radius: 0.5rem; padding: 1.5rem; margin-bottom: 1.5rem;"
        >
          <h3 style="font-size: 1.125rem; font-weight: bold; margin-bottom: 0.25rem;">
            Accounts
          </h3>
          <p style="font-size: 0.75rem; color: #6b7280; margin-bottom: 0.75rem;">
            Link 2+ Anthropic accounts to enable automatic load balancing.
            The default account is used as fallback.
          </p>

          ${!train.accounts || train.accounts.length === 0
            ? html`
                <div
                  style="background-color: #fef3c7; border: 1px solid #f59e0b; padding: 0.75rem; border-radius: 0.25rem;"
                >
                  <p style="margin: 0; color: #92400e; font-size: 0.875rem;">
                    No credentials available.
                  </p>
                </div>
              `
            : html`
                <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                  ${train.accounts.map(
                    (cred: CredentialSafe) => {
                      const isDefault = train.default_account_id === cred.id
                      const isLinked = train.linked_account_ids.includes(cred.id)
                      return html`
                      <div
                        style="background: ${isDefault
                          ? '#eff6ff'
                          : isLinked
                            ? '#f0fdf4'
                            : '#f9fafb'}; border: 1px solid ${isDefault
                          ? '#3b82f6'
                          : isLinked
                            ? '#22c55e'
                            : '#e5e7eb'}; padding: 0.75rem; border-radius: 0.25rem; display: flex; justify-content: space-between; align-items: center;"
                      >
                        <div style="flex: 1;">
                          <div style="font-weight: 600; font-size: 0.875rem;">
                            ${cred.account_name}
                            ${isDefault
                              ? html`<span
                                  style="background: #3b82f6; color: white; padding: 0.125rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; margin-left: 0.5rem; font-weight: 600;"
                                  >DEFAULT</span
                                >`
                              : ''}
                            ${isLinked
                              ? html`<span
                                  style="background: #22c55e; color: white; padding: 0.125rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; margin-left: 0.5rem; font-weight: 600;"
                                  >LINKED</span
                                >`
                              : ''}
                          </div>
                          <div style="font-size: 0.75rem; color: #6b7280;">
                            <code
                              style="background: white; padding: 0.125rem 0.25rem; border-radius: 0.125rem;"
                              >${cred.account_id}</code
                            >
                            ${cred.provider === 'anthropic'
                              ? html`
                                  <div
                                    style="display: inline-flex; align-items: center; margin-left: 0.5rem; vertical-align: middle;"
                                    hx-get="/dashboard/projects/${train.id}/account-utilization/${cred.account_id}"
                                    hx-trigger="load"
                                    hx-swap="innerHTML"
                                  >
                                    <span style="font-size: 0.7rem; color: #9ca3af;">Loading usage…</span>
                                  </div>
                                `
                              : html`• Region: ${(cred as any).aws_region}`}
                          </div>
                        </div>
                        <div style="display: flex; gap: 0.375rem; align-items: center;">
                          ${isOwner && !isDefault
                            ? html`
                                <form
                                  hx-post="/dashboard/projects/${train.id}/set-default-account"
                                  hx-swap="outerHTML"
                                  hx-target="closest div[style*='margin-bottom: 1.5rem']"
                                  style="margin: 0;"
                                >
                                  <input type="hidden" name="credential_id" value="${cred.id}" />
                                  <button
                                    type="submit"
                                    style="background: #3b82f6; color: white; padding: 0.25rem 0.75rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer; font-size: 0.75rem;"
                                  >
                                    Set Default
                                  </button>
                                </form>
                              `
                            : ''}
                          ${isOwner && !isLinked
                            ? html`
                                <form
                                  hx-post="/dashboard/projects/${train.id}/link-account"
                                  hx-swap="outerHTML"
                                  hx-target="closest div[style*='margin-bottom: 1.5rem']"
                                  style="margin: 0;"
                                >
                                  <input type="hidden" name="credential_id" value="${cred.id}" />
                                  <button
                                    type="submit"
                                    style="background: #22c55e; color: white; padding: 0.25rem 0.75rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer; font-size: 0.75rem;"
                                  >
                                    Link
                                  </button>
                                </form>
                              `
                            : ''}
                          ${isOwner && isLinked && !isDefault
                            ? html`
                                <form
                                  hx-delete="/dashboard/projects/${train.id}/unlink-account/${cred.id}"
                                  hx-confirm="Remove this account from the pool?"
                                  hx-swap="outerHTML"
                                  hx-target="closest div[style*='margin-bottom: 1.5rem']"
                                  style="margin: 0;"
                                >
                                  <button
                                    type="submit"
                                    style="background: #ef4444; color: white; padding: 0.25rem 0.75rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer; font-size: 0.75rem;"
                                  >
                                    Unlink
                                  </button>
                                </form>
                              `
                            : ''}
                        </div>
                      </div>
                    `}
                  )}
                </div>
              `}
        </div>
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add services/dashboard/src/routes/projects-ui.ts
git commit -m "feat: replace default account section with account pool UI"
```

---

### Task 7: Final Validation

- [ ] **Step 1: Run full typecheck**

Run: `bun run typecheck`

Expected: PASS with no errors.

- [ ] **Step 2: Run tests**

Run: `bun test`

Expected: All existing tests pass. No regressions.

- [ ] **Step 3: Verify build**

Run: `bun run build`

Expected: Build succeeds.

- [ ] **Step 4: Commit any remaining fixes**

Only if needed.
