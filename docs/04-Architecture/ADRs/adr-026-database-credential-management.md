# ADR-026: Database-Based Credential and Train Management

## Status

Accepted

## Context

The Agent Prompt Train proxy initially used filesystem-based credential storage, where OAuth credentials were stored as JSON files in the `credentials/accounts/` directory, and train configuration was distributed across multiple configuration files. This approach worked for early development but created several operational challenges:

1. **Credential Management Complexity**: Adding, updating, or rotating OAuth credentials required direct filesystem access and service restarts
2. **Train Configuration Fragmentation**: Train settings (like Slack webhooks) were tied to credentials rather than trains, requiring duplication when multiple teams shared the same credential
3. **No Multi-Tenancy Support**: The filesystem approach made it difficult to support multiple independent "trains" (isolated Claude API access configurations) with different account associations
4. **Manual API Key Management**: Client API keys for accessing trains were managed through files, with no programmatic way to generate or revoke keys
5. **Audit and Compliance Gaps**: No tracking of when credentials were used, who generated API keys, or when accounts were linked/unlinked from trains
6. **Operational Friction**: Every credential change required file edits, git commits, and deployments

## Decision Drivers

- **Operational Simplicity**: Credential management should be possible without direct filesystem access or deployments
- **Multi-Tenancy**: Support multiple isolated trains with independent credential associations
- **Security**: Track credential usage, API key lifecycle, and provide secure token refresh
- **Scalability**: Prepare for future features like credential rotation policies, usage quotas, and audit logs
- **Developer Experience**: Provide dashboard UI and REST APIs for all credential operations
- **Zero Downtime**: Changes to credentials or train configuration shouldn't require service restarts

## Considered Options

### Option 1: Keep Filesystem-Based Approach with Improved Tooling

**Description**: Enhance the existing filesystem approach with better CLI tools and hot-reloading

**Pros**:
- No migration needed
- Simple to understand
- No database dependency

**Cons**:
- Still requires git commits for credential changes
- Can't provide real-time dashboard UI
- No audit trail without custom log parsing
- Difficult to implement multi-tenancy
- Credential rotation requires deployment

### Option 2: Database Storage with Dual-Read Period

**Description**: Migrate to PostgreSQL but maintain filesystem fallback for safety

**Pros**:
- Gradual migration path
- Fallback if database issues occur
- Less risky for production

**Cons**:
- Significantly more complex codebase
- Two sources of truth to maintain
- Unclear when to remove filesystem code
- Not needed for dev-stage project

### Option 3: Full Migration to Database Storage

**Description**: Migrate all credential and train management to PostgreSQL with no filesystem fallback

**Pros**:
- Single source of truth
- Enables real-time dashboard UI
- Full audit trail in database
- Natural fit for multi-tenancy
- No code duplication
- Simpler mental model

**Cons**:
- Requires database for all environments
- Migration needed for existing credentials
- More complex initial implementation

## Decision

We will **fully migrate to database-based credential and train management (Option 3)** with the following architecture:

### Database Schema

Four new tables manage the credential and train lifecycle:

1. **`anthropic_credentials`**: Stores OAuth credentials (access token, refresh token, expiry, scopes)
   - Primary key: `id` (UUID)
   - Business key: `account_id` (e.g., "acc_team_alpha")
   - Tracks: `created_at`, `updated_at`, `last_refresh_at`

2. **`trains`**: Represents isolated Claude API access configurations
   - Primary key: `id` (UUID)
   - Business key: `train_id` (e.g., "cnp-dev-001")
   - Configuration: `slack_webhook_url`, `is_active`

3. **`train_accounts`**: Many-to-many junction table linking trains to credentials
   - Composite primary key: `(train_id, credential_id)`
   - Tracks: `linked_at`
   - Enables multiple credentials per train (for failover) and credential reuse across trains

4. **`train_api_keys`**: Client API keys for accessing specific trains
   - Primary key: `id` (UUID)
   - Foreign key: `train_id`
   - Stores: `key_hash` (SHA-256), `key_preview` (first 10 chars), `description`
   - Tracks: `created_at`, `last_used_at`, `revoked_at`

### Key Design Decisions

**OAuth-Only Authentication**: Removed legacy API key support from `AuthenticationService`. All authentication now uses OAuth tokens with automatic refresh.

**Train-Scoped Configuration**: Moved Slack webhooks and other configuration from credentials to trains, allowing multiple trains to share the same credential with different settings.

**Credential Failover**: Trains can link multiple credentials. The proxy automatically fails over to the next credential if one expires or encounters errors.

**API Key Generation**: Secure random generation with `cnp_live_` prefix, SHA-256 hashing, and database verification. Keys are shown in full only once at creation.

**Token Refresh Handling**: Maintained all existing OAuth refresh safety features (concurrent request coalescing, negative caching, refresh metrics) but now saves refreshed tokens to database instead of filesystem.

### Migration Strategy

**Simple Approach for Dev Environment**: No automated migration script since the project has no production deployments. Existing credentials can be re-added via the OAuth login script, which now saves to database.

**For Future Production Use**: Would implement dual-read period (Option 2) with filesystem fallback during rollout.

### API Design

**Dashboard Backend APIs**:
- `GET /api/credentials` - List credentials (safe format, no tokens)
- `GET /api/credentials/:id` - Get credential details
- `GET /api/trains` - List all trains with linked accounts
- `POST /api/trains` - Create new train
- `PUT /api/trains/:id` - Update train configuration
- `POST /api/trains/:id/accounts` - Link credential to train
- `DELETE /api/trains/:id/accounts/:credentialId` - Unlink credential
- `GET /api/trains/:trainId/api-keys` - List API keys
- `POST /api/trains/:trainId/api-keys` - Generate new API key
- `DELETE /api/trains/:trainId/api-keys/:keyId` - Revoke API key

**Naming Conventions**: Snake_case for JSON (external API contract), camelCase for internal TypeScript.

## Consequences

### Positive

- **Zero-Downtime Credential Updates**: Add, update, or rotate credentials without restarting services
- **Dashboard UI Ready**: All credential operations exposed via REST APIs for future UI implementation
- **Multi-Tenancy Support**: Multiple trains with independent configurations sharing the same credentials
- **Audit Trail**: Complete history of credential usage, API key generation/revocation, and train configuration changes
- **Simplified Operations**: No git commits or deployments needed for credential management
- **Security Improvements**: API key hashing, credential usage tracking, programmatic revocation
- **Scalability**: Foundation for future features like usage quotas, rotation policies, and compliance reporting

### Negative

- **Database Dependency**: All environments must have PostgreSQL configured
- **Migration Complexity**: Existing filesystem credentials must be manually re-added via OAuth login script
- **Increased Code Surface**: Database schema, queries, and APIs add ~1500 lines of code
- **No Fallback**: If database is unavailable, proxy cannot authenticate (acceptable for dev environment)

### Neutral

- **Breaking Changes**:
  - `AuthenticationService` constructor signature changed (now takes `Pool` instead of directory paths)
  - `getApiKey()` signature changed (credential ID + pool instead of file path)
  - Removed `slackConfig` from `AuthResult` (now fetched separately from train)
  - Environment variables `ACCOUNTS_DIR` and `TRAIN_CLIENT_KEYS_DIR` no longer used

## Implementation Notes

### Code Organization

**Shared Package** (`packages/shared/src/database/queries/`):
- `credential-queries.ts` - CRUD operations for credentials
- `train-queries.ts` - Train management and account linking
- `api-key-queries.ts` - API key generation and verification
- All queries use parameterized SQL to prevent injection attacks

**Types** (`packages/shared/src/types/`):
- `credentials.ts` - Full credential type and safe (no tokens) variant
- Exported via `packages/shared/src/types/index.ts`

**Database Migration**:
- `scripts/db/migrations/013-credential-train-management.ts`
- Idempotent: safe to run multiple times
- Creates all tables with proper indexes

**Scripts**:
- `scripts/auth/oauth-login.ts` - Completely rewritten to save to database
- Prompts for `account_id` and `account_name`
- Provides next steps (link to train via dashboard)

### Backward Compatibility

**Intentionally Broken**: This is a breaking change requiring manual migration. Documented in IMPLEMENTATION_GUIDE.md.

**Migration Steps for Existing Users**:
1. Run database migration: `bun run scripts/db/migrations/013-credential-train-management.ts`
2. Re-add OAuth credentials: `bun run scripts/auth/oauth-login.ts`
3. Create trains via dashboard API
4. Link credentials to trains
5. Generate train API keys
6. Remove old `credentials/` directory files

### Security Considerations

**Current Implementation**:
- API keys hashed with SHA-256 before storage
- OAuth tokens stored in plaintext (acceptable for dev environment)
- Database access controlled via PostgreSQL permissions
- All queries use parameterized SQL

**Not Implemented (Deferred)**:
- Token encryption at rest (would require key management)
- Timing-safe API key comparison (marginal benefit for dev environment)
- Rate limiting on credential refresh (handled by Anthropic API)

## Related Decisions

- [ADR-004: Proxy Authentication](adr-004-proxy-authentication.md) - Original filesystem-based authentication decision
- [ADR-012: Database Schema Evolution](adr-012-database-schema-evolution.md) - TypeScript migration strategy
- [ADR-019: Dashboard Security](adr-019-dashboard-read-only-mode-security.md) - Dashboard API key requirement

## References

- Implementation Guide: `/IMPLEMENTATION_GUIDE.md`
- Database Migration: `scripts/db/migrations/013-credential-train-management.ts`
- OAuth Login Script: `scripts/auth/oauth-login.ts`
- Dashboard API Routes: `services/dashboard/src/routes/{credentials,trains,api-keys}.ts`
- Proxy Authentication: `services/proxy/src/services/AuthenticationService.ts`
