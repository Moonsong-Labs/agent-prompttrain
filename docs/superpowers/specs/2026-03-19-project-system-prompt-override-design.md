# Project System Prompt Override

## Summary

Add a project-level system prompt that replaces (or adds) the `system` field in Claude API requests forwarded by the proxy. Disabled by default, editable by any project member.

## Requirements

- Projects can define a system prompt as a JSON array of Claude API content blocks
- When enabled, replaces the entire `system` field in incoming requests before forwarding to Claude
- When disabled (default), requests pass through unchanged
- Any project member (owner or member role) can toggle and edit the system prompt
- Claude API only (not Bedrock or other providers)

## Database

### Migration: Add system prompt columns to projects table

```sql
ALTER TABLE projects
  ADD COLUMN system_prompt_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN system_prompt JSONB DEFAULT NULL;
```

- `system_prompt_enabled`: Toggle for the feature. Default `false`.
- `system_prompt`: Stores a JSON array of Claude API system content blocks. Format:
  ```json
  [
    { "type": "text", "text": "First block" },
    { "type": "text", "text": "Second block", "cache_control": { "type": "ephemeral" } }
  ]
  ```
  `NULL` when no prompt is configured.

## Type Changes

### `packages/shared/src/types/credentials.ts`

Add to `Project` interface:

```typescript
system_prompt_enabled: boolean
system_prompt: SystemContentBlock[] | null
```

Add to `UpdateProjectRequest`:

```typescript
system_prompt_enabled?: boolean
system_prompt?: SystemContentBlock[] | null
```

Add new type:

```typescript
interface SystemContentBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}
```

## Proxy Logic

### Location: `services/proxy/src/services/ProxyService.ts`

In `handleRequest()`, after conversation data extraction but before authentication and forwarding:

1. Query the project's system prompt config via a new function `getProjectSystemPrompt(pool, projectId)`
2. If `system_prompt_enabled === true` and `system_prompt` is not null:
   - Replace `rawRequest.system` with the project's `system_prompt` array
3. Conversation tracking uses the **original** system field for hash computation (preserving tracking integrity)
4. The modified request is what gets forwarded to Claude API

### New query: `getProjectSystemPrompt`

```typescript
async function getProjectSystemPrompt(
  pool: Pool,
  projectId: string
): Promise<{ enabled: boolean; system_prompt: SystemContentBlock[] | null } | null>
```

Returns `null` if project not found. Returns the enabled flag and prompt data otherwise. Simple SELECT query on the projects table.

## Dashboard API

### Existing endpoint: `PUT /api/projects/:id`

Extend to accept `system_prompt_enabled` and `system_prompt` fields in the request body. The `updateProject` query function already supports dynamic field updates — add the two new fields.

### Authorization change

The system prompt update needs `requireProjectMembership` (any member) instead of `requireProjectOwner`. Two options:

**Chosen approach**: Add a dedicated endpoint `PUT /api/projects/:id/system-prompt` with `requireProjectMembership` middleware. This keeps the existing `PUT /api/projects/:id` (owner-only for name, privacy, slack config) unchanged.

Endpoint accepts:

```json
{
  "system_prompt_enabled": true,
  "system_prompt": [{ "type": "text", "text": "..." }]
}
```

Returns the updated project.

## Dashboard UI

### Project detail page: new "System Prompt" section

Location: `services/dashboard/src/routes/projects-ui.ts`, between Privacy Settings and Default Account sections.

Components:

1. **Enable/disable toggle** — checkbox or toggle button, similar to privacy toggle
2. **JSON textarea** — for editing the system prompt array. Pre-populated with current value or an empty template
3. **Save button** — POST to the dedicated endpoint
4. **Validation** — client-side JSON parse check + server-side schema validation
5. **Block count indicator** — "X content blocks configured"

Visible to all project members. Non-members see the section but cannot edit (read-only or hidden based on existing patterns).

## Validation

Server-side validation for the system prompt:

- Must be a JSON array
- Each element must have `type: "text"` and `text: string`
- Optional `cache_control: { type: "ephemeral" }` per block
- Maximum total size: 1MB (reasonable limit for system prompts)

## Testing

- **Unit**: System prompt replacement logic in ProxyService
- **Unit**: Validation of system prompt JSON structure
- **Integration**: API endpoint accepts, validates, and persists system prompt
- **Integration**: Conversation tracking still uses original system hash when override is active
