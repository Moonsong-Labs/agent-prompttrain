# ADR-030: User Credential Passthrough Mode

**Status:** Accepted

**Date:** 2025-11-04

**Context:** Project-level authentication with user-provided credentials

**Decision Makers:** AI Agent

---

## Context

Currently, all projects must have a `default_account_id` configured, which references an organization-level Anthropic credential stored in the `anthropic_credentials` table. When users make API requests, the proxy uses this organization account to authenticate with Anthropic's API.

This model works well for centralized account management, but creates limitations:

1. **No support for individual user accounts**: Users cannot use their personal Anthropic accounts
2. **Billing complexity**: All usage is attributed to the organization account
3. **Access control limitations**: Cannot leverage user-specific Anthropic permissions
4. **Development friction**: Developers must use shared credentials instead of their own

We need a way for projects to operate in "user passthrough mode" where authenticated users provide their own Anthropic credentials via the `Authorization` header, and the proxy forwards these directly to Anthropic's API.

## Decision

We will implement **user credential passthrough mode** with the following design:

### 1. Optional Default Account

- The `default_account_id` column in the `projects` table remains nullable (already supported)
- When `default_account_id` is `null`, the project operates in user passthrough mode
- Existing projects continue to work unchanged (backward compatible)

### 2. Mandatory Project Identification

The `MSL-Project-Id` header is now **mandatory** for all requests:

- Requests without this header are rejected with a clear error message
- This ensures proper project identification for authentication lookup
- Required to determine if project uses organization account or user passthrough mode
- Removes fallback to default project ID for better security and explicit configuration

### 3. Authentication Priority

The `AuthenticationService.authenticate()` method follows this priority order:

1. **MSL-Account header** (explicit account override) → uses specified organization account
2. **Project default account** → uses `default_account_id` from database
3. **User passthrough mode** (NEW) → forwards user's `Authorization: Bearer <token>` header

### 4. Error Handling

When a project has no default account (`default_account_id = null`):

- If user provides `Authorization: Bearer <token>` → passthrough succeeds
- If user provides no Authorization header → returns clear error:
  ```
  No default account configured for this project and no user credentials provided.
  Either set a default account via the dashboard, or provide your Anthropic credentials via Authorization header.
  ```

### 5. Dashboard Integration

**Project Creation:**

- Add dropdown: "👤 User Account (passthrough mode)" + organization accounts
- Default selection remains random organization account (backward compatible)
- Users can explicitly select "User Account" for new projects

**Project Management:**

- Display "👤 User Account" badge when `default_account_id = null`
- Allow switching between User Account and organization accounts
- Add explanatory text about passthrough mode

### 6. Implementation Details

**Migration:** `015-user-passthrough-support.ts`

- Ensures `default_account_id` column is nullable
- Adds column documentation explaining passthrough behavior
- No data migration needed (idempotent)

**Type Updates:**

- `CreateProjectRequest.default_account_id?: string | null`
- `UpdateProjectRequest.default_account_id?: string | null`

**Query Updates:**

- `createProject()`: Accepts explicit `null` for passthrough mode
- `updateProject()`: Allows changing `default_account_id` to `null`

**Request Context:**

- `RequestContext.fromHono()`: Enforces mandatory `MSL-Project-Id` header
- Throws clear error if header is missing

**UI Sentinel Value:**

- Dashboard uses `"__user__"` string value in forms
- Converted to `null` before database insertion
- Prevents dropdown from submitting empty string

## Consequences

### Positive

✅ **User choice**: Projects can choose organization OR user credentials
✅ **Backward compatible**: Existing projects continue working unchanged
✅ **Simple implementation**: Leverages existing nullable column, no new tables
✅ **Clear intent**: Explicit "User Account" option in dashboard
✅ **Flexible**: Can switch between modes via dashboard
✅ **No token storage**: User tokens never stored in database (security benefit)

### Negative

⚠️ **No automatic refresh**: User must manage their own token expiration (unlike organization accounts)
⚠️ **Manual token provision**: Users must pass `Authorization` header in every request
⚠️ **No centralized tracking**: Cannot track individual user costs in dashboard (shows project-level only)
⚠️ **Documentation burden**: Users need clear instructions on obtaining/using their Anthropic tokens

### Neutral

- User authentication in dashboard (ADR-027) is separate from API authentication
- Request tracking continues to work (uses `account_id: 'user-passthrough'` for attribution)
- Slack notifications continue to work (project-level configuration)

## Alternatives Considered

### Alternative 1: Store user OAuth tokens in database

**Approach**: Create `user_anthropic_credentials` table, implement OAuth flow in dashboard, automatically refresh user tokens

**Rejected because:**

- Significantly more complex (OAuth flow, token refresh, user credential management)
- Security risk (storing user tokens in database)
- Not needed for MVP use case (users can manage their own tokens)
- Can be added later if demand exists

### Alternative 2: Project-level passthrough flag

**Approach**: Add `use_user_passthrough: boolean` column instead of implicit `default_account_id = null`

**Rejected because:**

- Adds unnecessary column when nullable `default_account_id` already expresses the same intent
- More complex validation (what if both flag is true AND default_account_id is set?)
- Less intuitive ("what does this flag do?" vs "no default account = user provides credentials")

### Alternative 3: Dashboard-only passthrough

**Approach**: Dashboard forwards user auth headers to proxy, only works from dashboard UI

**Rejected because:**

- Doesn't solve the primary use case (developers using Claude Code CLI)
- Creates two different authentication flows (dashboard vs direct API)
- More complex (dashboard must capture and forward user Anthropic tokens)

## Related ADRs

- **ADR-004**: Proxy Authentication - Established multi-account model
- **ADR-024**: Header-Based Project and Account Routing - Defines MSL-Account header priority
- **ADR-027**: Mandatory User Authentication - Dashboard authentication (separate concern)
- **ADR-028**: Proxy Service Operational Modes - Passthrough works in all modes
- **ADR-029**: Project Privacy Model - User passthrough respects project membership

## Implementation Notes

### Testing User Passthrough Mode

1. Create project with "User Account" selected
2. Obtain Anthropic API token from https://console.anthropic.com/settings/keys
3. Make API request with headers:
   ```
   MSL-Project-Id: your-project-id
   Authorization: Bearer your-anthropic-token
   ```
4. Proxy forwards your token to Anthropic API
5. Request tracked under `account_id: 'user-passthrough'`

### Switching Modes

- **User Account → Organization Account**: Select organization account in dashboard
- **Organization Account → User Account**: Select "User Account" in dashboard
- No data loss, instant switch

### Monitoring

- Dashboard shows requests under "User Account" when `default_account_id = null`
- Individual user tokens not tracked (privacy by design)
- Project-level metrics still work (conversation tracking, token usage aggregates)

## Migration Path

**Existing Projects:** No changes required, continue using organization accounts

**New Projects:** Can choose User Account at creation time

**Future Enhancement:** If user credential storage becomes needed, can add:

- `user_anthropic_credentials` table
- OAuth flow in dashboard
- Automatic token refresh
- Per-user cost tracking

This decision provides immediate value while keeping the door open for future enhancements.
