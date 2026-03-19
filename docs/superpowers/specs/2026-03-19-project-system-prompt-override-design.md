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

### `packages/shared/src/types/claude.ts`

Extract the inline system content block type into a named export (reuse, don't duplicate):

```typescript
export interface SystemContentBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}
```

The existing `ClaudeMessagesRequest.system` field already uses `string | Array<{...}>`. The named `SystemContentBlock` type replaces the inline array element type.

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

Import `SystemContentBlock` from `claude.ts`.

## Proxy Logic

### Location: `services/proxy/src/services/ProxyService.ts`

**Mutation point**: The system prompt override mutates `rawRequest.system` **after** the `storageAdapter.linkConversation()` call (which uses the original system for hash computation at ~line 117) and **before** the `this.apiClient.forward()` call (~line 212). The `ProxyRequest` object is created at line 78 before conversation linking, but `apiClient.forward()` reads `rawRequest` fields for the actual HTTP request body, so mutating `rawRequest.system` after conversation linking is correct.

**Original system field handling**: The incoming `system` may be `string | Array<SystemContentBlock> | undefined`. The override always replaces it with an array of `SystemContentBlock[]` regardless of the original format. Conversation tracking preserves the original value for hash computation since `linkConversation` is called before the mutation.

Steps:

1. After `linkConversation` completes (~line 148), query the project's system prompt config via `getProjectSystemPrompt(pool, projectId)`
2. If `system_prompt_enabled === true` and `system_prompt` is a non-empty array:
   - Replace `rawRequest.system` with the project's `system_prompt` array
3. If `system_prompt` is `null` or an empty array `[]`, skip — do not send `system: []` to Claude API (empty array is treated as "no override")
4. The modified `rawRequest` is then forwarded to Claude API

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
3. **Save button** — PUT to the dedicated endpoint
4. **Validation** — client-side JSON parse check + server-side schema validation
5. **Block count indicator** — "X content blocks configured"

Visible to all project members. Non-members see the section but cannot edit (read-only or hidden based on existing patterns).

## Validation

Server-side validation for the system prompt:

- Must be a JSON array (empty array `[]` is valid but treated as "no override" — same as null)
- Each element must have `type: "text"` and `text: string`
- Optional `cache_control: { type: "ephemeral" }` per block
- Maximum total JSON string length: 1MB (checked on `JSON.stringify(system_prompt).length`)

## Migration numbering

Use `020-add-system-prompt-to-projects.ts` (next after existing `019`).

## Edge cases

- **Bedrock requests**: The `/v1/messages` endpoint already rejects Bedrock accounts (ProxyService line 180-190). Bedrock-specific endpoints (`/model/*/invoke`) are separate and not affected by this feature.
- **Empty array**: `system_prompt = []` is treated as no override (same as `null`). The UI should show this as "no prompt configured".
- **Feature disabled with prompt configured**: The prompt data is preserved in the database but not applied. Users can re-enable without re-entering the prompt.

## Testing

- **Unit**: System prompt replacement logic in ProxyService
- **Unit**: Validation of system prompt JSON structure
- **Integration**: API endpoint accepts, validates, and persists system prompt
- **Integration**: Conversation tracking still uses original system hash when override is active
