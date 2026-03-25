# Account Pool UI Management

**Date:** 2026-03-25
**Status:** Approved

## Context

The `project_accounts` junction table (migration 019) and `AccountPoolService` already support multi-account load balancing for projects. When a project has 2+ linked Anthropic accounts, the pool service automatically selects the least-utilized account under each account's `token_limit_threshold`. Currently, managing these links requires direct SQL.

This spec adds UI and API support for linking/unlinking accounts to a project's pool.

## Design Decisions

- **Permissions:** Owner only (consistent with default account management)
- **UI placement:** Replace the existing "Default Account" section with a unified "Accounts" section
- **Pool info:** No real-time usage data; just link/unlink controls
- **Interaction pattern:** Individual HTMX action buttons per account (matches existing codebase patterns)

## Changes

### 1. Database Query Layer

**New functions in `project-queries.ts`:**

- `addProjectAccount(pool, projectUuid, credentialId)` — `INSERT INTO project_accounts ... ON CONFLICT DO NOTHING`. Both params are UUIDs (`projects.id`, `credentials.id`). Returns boolean (true if inserted, false if already existed). FK violation on invalid `credentialId` is caught and returns a user-friendly error at the API layer.
- `removeProjectAccount(pool, projectUuid, credentialId)` — `DELETE FROM project_accounts WHERE project_id = $1 AND credential_id = $2`. Both params are UUIDs. Returns boolean success.

**Modified functions in `project-queries.ts`:**

- `getProjectWithAccounts()` — additionally query `project_accounts WHERE project_id = train.id` (UUID) to populate `linked_account_ids: string[]`.
- `listProjectsWithAccounts()` — same: include `linked_account_ids` per project via a single query joining `project_accounts`.

**Modified functions in `project-member-queries.ts`:**

- `getUserProjectsWithAccounts()` — Fix stale table reference: change `anthropic_credentials` to `credentials`. Add `linked_account_ids` to satisfy updated `ProjectWithAccounts` type.

### 2. Type Changes (`packages/shared/src/types/credentials.ts`)

Add `linked_account_ids` field to `ProjectWithAccounts`:

```typescript
export interface ProjectWithAccounts extends Project {
  accounts: CredentialSafe[]
  linked_account_ids: string[]
}
```

### 3. API Endpoints (`services/dashboard/src/routes/projects.ts`)

- `POST /api/projects/:id/accounts` — body: `{ credential_id: string }`. Owner only. Calls `addProjectAccount`.
- `DELETE /api/projects/:id/accounts/:credentialId` — Owner only. Calls `removeProjectAccount`.

### 4. HTMX Endpoints (`services/dashboard/src/routes/projects-ui.ts`)

- `POST /:projectId/link-account` — form with hidden `credential_id`. Route param `:projectId` is `train.id` (UUID), consistent with existing HTMX routes like `set-default-account`. Returns refreshed accounts section HTML.
- `DELETE /:projectId/unlink-account/:credentialId` — Same UUID convention. Returns refreshed accounts section HTML.

Both endpoints require owner permissions. They return a success message and trigger a full page reload after 1.5s, consistent with the existing `set-default-account` handler pattern.

### 5. UI Changes (`services/dashboard/src/routes/projects-ui.ts`)

Replace the "Default Account" section with "Accounts":

**Header:** "Accounts" with subtitle: "Link 2+ Anthropic accounts to enable automatic load balancing."

**Each credential row displays:**

- Account name, account ID, provider info (unchanged styling)
- **DEFAULT** badge (blue) if `cred.id === train.default_account_id`
- **LINKED** badge (green) if `cred.id` is in `linked_account_ids`
- **"Set as Default"** button — owner only, for non-default accounts (unchanged behavior)
- **"Link"** button — owner only, for unlinked accounts. HTMX POST to `/:projectId/link-account`
- **"Unlink"** button — owner only, for linked non-default accounts. HTMX DELETE to `/:projectId/unlink-account/:credentialId`. Hidden/disabled when the account is the default (cannot unlink the default).

### 6. Export Updates (`packages/shared/src/database/queries/index.ts`)

Export `addProjectAccount` and `removeProjectAccount`.

## Files Modified

| File                                                             | Change                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/types/credentials.ts`                       | Add `linked_account_ids` to `ProjectWithAccounts`                                                            |
| `packages/shared/src/database/queries/project-queries.ts`        | Add `addProjectAccount`, `removeProjectAccount`; modify `getProjectWithAccounts`, `listProjectsWithAccounts` |
| `packages/shared/src/database/queries/project-member-queries.ts` | Fix stale `anthropic_credentials` table ref; add `linked_account_ids` to `getUserProjectsWithAccounts`       |
| `packages/shared/src/database/queries/index.ts`                  | Export new functions                                                                                         |
| `services/dashboard/src/routes/projects.ts`                      | Add POST/DELETE account endpoints                                                                            |
| `services/dashboard/src/routes/projects-ui.ts`                   | Replace Default Account section, add HTMX handlers                                                           |

## Constraints

- Cannot unlink the default account (must change default first)
- `ON CONFLICT DO NOTHING` makes link operations idempotent
- Pool activation is implicit: 2+ linked Anthropic accounts = pool active (per ADR-031)
- Bedrock accounts can be linked but are excluded from pool selection by `AccountPoolService`
- Invalid `credential_id` on link triggers FK violation; API layer catches and returns 400
