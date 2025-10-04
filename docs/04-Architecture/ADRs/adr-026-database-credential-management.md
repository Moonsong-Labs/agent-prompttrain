# ADR-026: Database-Backed Credential Management

## Status

Accepted

## Context

Currently, the proxy stores account credentials and train configurations as JSON files in the filesystem under `credentials/accounts/` and `credentials/train-client-keys/` directories. While this approach is simple and works for single-instance deployments, it has several limitations:

1. **Scalability**: Filesystem-based storage doesn't scale well across multiple instances
2. **Management**: No centralized interface for managing credentials (requires manual file editing)
3. **Audit Trail**: Limited ability to track credential access and modifications
4. **Security**: Credentials stored in plaintext on disk (relying only on filesystem permissions)
5. **Multi-tenancy**: Difficult to implement fine-grained access control per train
6. **Discovery**: No easy way to list and search available accounts and trains

The Slack configuration is currently associated with account credentials but logically belongs at the train level, as notifications are train-specific, not account-specific.

## Decision Drivers

- **Dashboard Management**: Need UI to manage accounts and trains without filesystem access
- **Security**: Encrypt sensitive credentials at rest
- **Scalability**: Support future multi-instance deployments
- **Backward Compatibility**: Must not disrupt existing deployments
- **Auditability**: Track credential usage and modifications
- **Zero Downtime**: Migration must not require service interruption

## Considered Options

### 1. Big Bang Migration (All at Once)

- Description: Immediate complete migration to database storage
- Pros: Clean cutover, simpler code
- Cons: Risky, no rollback, requires downtime, harder to test

### 2. Hybrid Dual-Write

- Description: Write to both filesystem and database simultaneously
- Pros: Maximum safety during transition
- Cons: Complex synchronization, eventual consistency issues, data drift risk

### 3. Phased Migration with Feature Flag (SELECTED)

- Description: Gradual migration with filesystem fallback controlled by feature flag
- Pros: Easy rollback, testable in production, zero downtime, low risk
- Cons: More code initially (dual paths), requires feature flag management

## Decision

Implement database-backed credential storage using PostgreSQL with a **phased migration approach** controlled by the `USE_DATABASE_CREDENTIALS` feature flag.

### Implementation Details

**Database Schema:**

```sql
-- Account credentials table
CREATE TABLE accounts (
  account_id VARCHAR(255) PRIMARY KEY,
  account_name VARCHAR(255) UNIQUE NOT NULL,
  credential_type VARCHAR(20) NOT NULL,  -- 'api_key' or 'oauth'
  api_key_encrypted TEXT,
  oauth_access_token_encrypted TEXT,
  oauth_refresh_token_encrypted TEXT,
  oauth_expires_at BIGINT,
  oauth_scopes TEXT[],
  oauth_is_max BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

-- Train configurations table
CREATE TABLE trains (
  train_id VARCHAR(255) PRIMARY KEY,
  train_name VARCHAR(255),
  description TEXT,
  client_api_keys_hashed TEXT[],  -- SHA-256 hashed for security
  slack_config JSONB,              -- Moved from accounts
  default_account_id VARCHAR(255) REFERENCES accounts(account_id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Train-account mappings (many-to-many)
CREATE TABLE train_account_mappings (
  train_id VARCHAR(255) REFERENCES trains(train_id) ON DELETE CASCADE,
  account_id VARCHAR(255) REFERENCES accounts(account_id) ON DELETE CASCADE,
  priority INTEGER DEFAULT 0,  -- For deterministic selection
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (train_id, account_id)
);
```

**Encryption Strategy:**

- Algorithm: AES-256-GCM (authenticated encryption)
- Key Derivation: PBKDF2 with 100,000 iterations
- Storage Format: `salt:iv:authTag:ciphertext` (base64-encoded)
- Key Source: `CREDENTIAL_ENCRYPTION_KEY` environment variable

**Feature Flag:**

- `USE_DATABASE_CREDENTIALS=false` (default) - Use filesystem
- `USE_DATABASE_CREDENTIALS=true` - Use database

**Migration Scripts:**

- `013-accounts-trains-schema.ts` - Create tables and indexes
- `014-import-credentials-data.ts` - Import filesystem data to database

**Dashboard Routes (Future):**

- `/dashboard/accounts` - Account management
- `/dashboard/trains` - Train configuration and account mapping

## Consequences

### Positive

- **Centralized Management**: Dashboard UI for account and train administration
- **Enhanced Security**: Credentials encrypted at rest with AES-256-GCM
- **Better Scalability**: Database storage supports multi-instance deployments
- **Audit Trail**: Track credential creation, modification, and usage
- **Improved Organization**: Slack config properly associated with trains
- **Zero Downtime**: Feature flag enables gradual rollout with rollback capability
- **Type Safety**: Shared TypeScript types ensure consistency

### Negative

- **Increased Complexity**: Additional database tables and migration scripts
- **Performance Overhead**: Encryption/decryption on every credential access (mitigated by caching)
- **Key Management**: Must securely manage `CREDENTIAL_ENCRYPTION_KEY`
- **Migration Required**: Existing deployments must run migration scripts

### Risks and Mitigations

- **Risk**: Encryption key exposure or loss
  - **Mitigation**: Document key management best practices, recommend secrets management tools

- **Risk**: Database performance impact on credential lookups
  - **Mitigation**: Indexes on frequently queried columns, existing credential caching layer

- **Risk**: Data migration failures
  - **Mitigation**: Idempotent migration scripts, keep filesystem as backup during transition

- **Risk**: Feature flag misconfiguration
  - **Mitigation**: Safe default (filesystem), clear documentation, validation checks

## Links

- [ADR-004: Proxy Authentication](./adr-004-proxy-authentication.md) - Account selection logic
- [ADR-012: Database Schema Evolution](./adr-012-database-schema-evolution.md) - Migration patterns
- [ADR-024: Train-ID Header Routing](./adr-024-train-id-header-routing.md) - Train identification
- [Environment Variables Reference](../../06-Reference/environment-vars.md)

## Notes

**Migration Path:**

1. Phase 1: Create schema (migration 013)
2. Phase 2: Import existing data (migration 014)
3. Phase 3: Deploy with `USE_DATABASE_CREDENTIALS=false` (filesystem fallback)
4. Phase 4: Enable database mode per train/instance
5. Phase 5: Remove filesystem fallback after full validation

**Key Management Recommendations:**

- Use AWS Secrets Manager, HashiCorp Vault, or similar for production
- Rotate encryption keys periodically (requires re-encryption migration)
- Never commit `CREDENTIAL_ENCRYPTION_KEY` to version control

**Future Enhancements:**

- Row-level security for multi-tenant isolation
- Credential rotation workflow via dashboard
- Integration with external secret managers
- OAuth token refresh using database locks for multi-instance support

---

Date: 2025-10-04
Authors: Claude Code (AI Agent)
