# ADR-034: Project System Prompt Override

## Status

Accepted

## Context

Claude API requests include an optional `system` field that provides instructions to the model. Different projects using the proxy may need to enforce specific system prompts for compliance, consistency, or operational reasons. Currently, the proxy forwards the `system` field from client requests unchanged.

Teams need the ability to:

- Define a standard system prompt at the project level
- Override client-provided system prompts when the feature is enabled
- Allow any project member (not just owners) to configure the system prompt

## Decision Drivers

- **Operational Control**: Projects need to enforce specific instructions across all API calls
- **Simplicity**: Avoid over-engineering — a simple toggle + JSON field covers the use case
- **Backward Compatibility**: Disabled by default, existing behavior unchanged
- **Conversation Tracking Integrity**: System hash computation must use the original prompt, not the override
- **Access Control**: System prompt editing should be available to all project members, not restricted to owners

## Considered Options

1. **Single JSON column on projects table (Chosen)**
   - Description: Add `system_prompt_enabled` boolean and `system_prompt` JSONB columns to `projects`
   - Pros: Simple, single migration, maps directly to Claude API format
   - Cons: No versioning/history, JSON validation at application layer

2. **Separate system_prompt_blocks table**
   - Description: Relational table with individual content block rows
   - Pros: Queryable individual blocks, relational
   - Cons: Over-engineered for a complete-array use case, complex aggregation queries

3. **Versioned system_prompts table**
   - Description: Each edit creates a new row, latest version is active
   - Pros: Full audit trail, rollback capability
   - Cons: Significant complexity for v1, YAGNI

## Decision

Add two columns to the `projects` table and a dedicated override function in the proxy:

### Database Schema

```sql
ALTER TABLE projects
  ADD COLUMN system_prompt_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN system_prompt JSONB DEFAULT NULL,
  ADD COLUMN system_prompt_mode VARCHAR(10) NOT NULL DEFAULT 'replace';
```

The `system_prompt_mode` column controls how the project system prompt interacts with client requests:

- `'replace'` (default): Replaces the entire `system` field
- `'prepend'`: Prepends the project system prompt blocks before the original request blocks

The `system_prompt` column stores the full Claude API system content blocks array:

```json
[
  { "type": "text", "text": "You are a helpful assistant." },
  { "type": "text", "text": "Follow company guidelines.", "cache_control": { "type": "ephemeral" } }
]
```

### Proxy Override Logic

The override is applied in `ProxyService.handleRequest()` at a specific point in the request lifecycle:

1. **Request received** → `ProxyRequest` created
2. **Conversation tracking** → `linkConversation()` computes system hash using the **original** `system` field
3. **System prompt override** → `applySystemPromptOverride()` replaces `rawRequest.system` if the project has an enabled, non-empty system prompt
4. **Authentication** → Account selection
5. **Forwarding** → Modified request sent to Claude API

This ordering ensures conversation tracking integrity — the system hash reflects what the client sent, while the Claude API receives the project's override.

### Override Behavior

- **Replace mode** (default): Replaces the entire `system` field regardless of original format (string or array)
- **Prepend mode**: Prepends the project's system prompt blocks before the original request blocks. If the original system is a string, it is normalized to a `[{ type: "text", text: "..." }]` array. If the request has no system prompt, the project blocks are used as-is.
- **Enabled with null or empty array `[]`**: No override applied (pass-through), regardless of mode
- **Disabled**: No override applied, prompt data preserved in database for re-enablement
- **Error during lookup**: Gracefully falls back to original request (logged as warning)

### API Endpoint

`PUT /api/projects/:id/system-prompt` with `requireProjectMembership` middleware (any member can edit, not just owners). This is a dedicated endpoint separate from the owner-only `PUT /api/projects/:id`.

### Validation

Server-side validation via `validateSystemPrompt()`:

- Must be a JSON array (or null)
- Each block: `{ type: "text", text: string, cache_control?: { type: "ephemeral" } }`
- Maximum JSON string length: 1MB
- Empty array `[]` is valid but treated as "no override"

## Consequences

### Positive

- Projects can enforce consistent system prompts across all API calls
- Simple toggle allows quick enable/disable without losing configuration
- Any project member can configure, reducing bottleneck on project owners
- Graceful failure ensures overrides never block legitimate requests
- Conversation tracking integrity maintained via ordered mutation

### Negative

- No audit trail of system prompt changes (only `updated_at` timestamp)
- No versioning or rollback capability
- ~~System prompt replacement is all-or-nothing (no prepend/append modes)~~ — resolved: prepend mode added alongside replace mode

### Risks and Mitigations

- **Risk**: Large system prompts increasing API costs
  - **Mitigation**: 1MB size limit on system prompt storage
- **Risk**: Override silently changing behavior for users unaware of the feature
  - **Mitigation**: Dashboard UI clearly shows override status; disabled by default
- **Risk**: Conversation tracking confusion when override changes mid-conversation
  - **Mitigation**: System hash tracks the original client system prompt, not the override

## Links

- [ADR-029: Project Privacy Model](./adr-029-project-privacy-model.md)
- [ADR-003: Conversation Tracking](./adr-003-conversation-tracking.md)

---

Date: 2026-03-19
Authors: Development Team
