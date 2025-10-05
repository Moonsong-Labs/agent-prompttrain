# Train-ID and Credential Management Migration Roadmap

## Executive Summary

This document outlines the implementation roadmap for migrating train-id and credential management from filesystem-based storage to PostgreSQL database. This migration enables centralized management through a dashboard interface while maintaining backward compatibility.

**Current Status:** Phase 2 Complete (Repository Layer)
**Phase 1 PR:** [#144](https://github.com/Moonsong-Labs/agent-prompttrain/pull/144) - Foundation (Merged)
**Phase 2 Commits:** ac42415, 331ad9b - Repository Layer (In Progress)
**ADR:** [ADR-026: Database Credential Management](./ADRs/adr-026-database-credential-management.md)

---

## Phase 1: Foundation (COMPLETED ✅)

### What Was Implemented

#### 1. Database Schema (Migration 013)

**Location:** `scripts/db/migrations/013-accounts-trains-schema.ts`

Created three core tables with comprehensive constraints and indexes:

**accounts table:**

- Stores Anthropic account credentials (API keys and OAuth tokens)
- Encrypted storage for sensitive data using AES-256-GCM
- Supports both `api_key` and `oauth` credential types
- Includes audit fields: `created_at`, `updated_at`, `last_used_at`
- Soft delete support via `is_active` flag
- Constraint ensures proper credentials based on type

**trains table:**

- Stores train configurations and metadata
- Contains hashed client API keys (SHA-256) for security
- Includes Slack configuration (moved from accounts table)
- References default account via foreign key
- Supports soft delete and audit tracking

**train_account_mappings table:**

- Many-to-many relationship between trains and accounts
- Priority field for deterministic account selection
- Cascade delete when train or account is removed

**Indexes Created:**

- `idx_accounts_type` - Fast lookup by credential type
- `idx_accounts_active` - Partial index on active accounts
- `idx_accounts_last_used` - Track usage patterns
- `idx_trains_active` - Partial index on active trains
- `idx_trains_default_account` - Fast lookup by default account
- `idx_train_mappings_train` - Efficient mapping queries
- `idx_train_mappings_account` - Reverse mapping lookup
- `idx_train_mappings_priority` - Priority-based selection

#### 2. Data Import Script (Migration 014)

**Location:** `scripts/db/migrations/014-import-credentials-data.ts`

Implements idempotent data migration from filesystem to database:

**Features:**

- Reads existing credential files from `credentials/accounts/`
- Reads train client keys from `credentials/train-client-keys/`
- Encrypts sensitive fields before database insertion
- Uses `ON CONFLICT` for idempotent re-runs
- Validates encryption key presence and length
- Provides detailed import summary and verification
- Gracefully handles missing directories
- Transaction-based with rollback on errors

**Security Measures:**

- Requires `CREDENTIAL_ENCRYPTION_KEY` (minimum 32 characters)
- Encrypts: API keys, OAuth access tokens, OAuth refresh tokens
- Hashes: Client API keys (one-way SHA-256)
- Validates data integrity after import

#### 3. TypeScript Type Definitions

**Location:** `packages/shared/src/types/credentials.ts`

Created comprehensive type definitions:

```typescript
// Database representation (encrypted)
interface DatabaseAccount {
  accountId: string
  accountName: string
  credentialType: 'api_key' | 'oauth'
  apiKeyEncrypted?: string
  oauthAccessTokenEncrypted?: string
  oauthRefreshTokenEncrypted?: string
  oauthExpiresAt?: number
  oauthScopes?: string[]
  oauthIsMax?: boolean
  isActive: boolean
  createdAt: Date
  updatedAt: Date
  lastUsedAt?: Date
}

interface DatabaseTrain {
  trainId: string
  trainName?: string
  description?: string
  clientApiKeysHashed?: string[]
  slackConfig?: Record<string, unknown>
  defaultAccountId?: string
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

interface TrainAccountMapping {
  trainId: string
  accountId: string
  priority: number
  createdAt: Date
}

// Application representation (decrypted)
interface DecryptedAccount {
  accountId: string
  accountName: string
  credentialType: 'api_key' | 'oauth'
  apiKey?: string
  oauthAccessToken?: string
  oauthRefreshToken?: string
  oauthExpiresAt?: number
  oauthScopes?: string[]
  oauthIsMax?: boolean
  isActive: boolean
  lastUsedAt?: Date
}
```

#### 4. Encryption Utilities

**Location:** `packages/shared/src/utils/encryption.ts`

Implemented secure encryption functions:

**Algorithm:** AES-256-GCM (Galois/Counter Mode)

- Provides both confidentiality and authenticity
- 256-bit key strength
- 128-bit authentication tag prevents tampering

**Key Derivation:** PBKDF2

- 100,000 iterations (OWASP recommended minimum)
- SHA-256 hash function
- 32-byte salt (randomly generated per encryption)
- Derives 32-byte encryption key from master key

**Storage Format:** `salt:iv:authTag:ciphertext` (all base64-encoded)

- Salt: 32 bytes (for key derivation)
- IV: 16 bytes (initialization vector)
- Auth Tag: 16 bytes (GCM authentication tag)
- Ciphertext: Variable length (encrypted data)

**Functions Provided:**

- `encrypt(plaintext, key)` - Encrypt sensitive data
- `decrypt(ciphertext, key)` - Decrypt stored data
- `hashApiKey(apiKey)` - One-way hash for client keys
- `verifyApiKeyHash(apiKey, hash)` - Constant-time verification

#### 5. Configuration Updates

**Location:** `packages/shared/src/config/index.ts`

Added new configuration section:

```typescript
credentials: {
  get useDatabaseStorage() {
    return env.bool('USE_DATABASE_CREDENTIALS', false)
  },
  get encryptionKey() {
    return env.string('CREDENTIAL_ENCRYPTION_KEY', '')
  },
}
```

**Environment Variables:**

- `USE_DATABASE_CREDENTIALS` - Feature flag (default: false)
- `CREDENTIAL_ENCRYPTION_KEY` - Encryption key (required when enabled)

#### 6. Documentation

**ADR-026:** Complete architectural decision record

- Context and problem statement
- Decision drivers and options considered
- Implementation details and schema design
- Consequences (positive, negative, risks)
- Migration path and rollout strategy

**Environment Variables Reference:**

- Updated with credential management section
- Security notes and best practices
- Key generation instructions
- Production recommendations (AWS Secrets Manager, etc.)

**Example Configuration:**

- Updated `.env.example` with new variables
- Clear comments and security warnings
- Key generation command examples

### Key Architectural Decisions

1. **Slack Config Location:** Moved from accounts to trains table
   - Rationale: Notifications are train-specific, not account-specific
   - Allows different Slack configurations per train
   - More logical data organization

2. **Application-Level Encryption:** Not pgcrypto
   - Better control over encryption logic
   - Easier key rotation strategy
   - No database extension dependencies
   - Portable across PostgreSQL versions

3. **Feature Flag Approach:** Gradual rollout
   - Safe default: filesystem mode (USE_DATABASE_CREDENTIALS=false)
   - Easy rollback without code changes
   - Test in production with subset of trains
   - No breaking changes to existing deployments

4. **Idempotent Migrations:** Can be run multiple times
   - Uses `IF NOT EXISTS` for tables and indexes
   - Uses `ON CONFLICT` for data insertion
   - Transaction-based with rollback
   - Verification steps after each operation

### Code Review Results

**Overall Status:** APPROVED ✅

**Strengths Identified:**

- Excellent encryption implementation (AES-256-GCM + PBKDF2)
- Proper database design with constraints and indexes
- Idempotent migrations following ADR-012 patterns
- Comprehensive TypeScript types
- Feature flag for safe rollout
- Thorough documentation
- Transaction-based error handling

**Minor Recommendations (Non-Blocking):**

1. Consider using `crypto.timingSafeEqual()` in `verifyApiKeyHash` to prevent timing attacks
2. Add JSON structure validation in migration 014 after parsing
3. Add explicit comment about automatic index on `account_name` UNIQUE constraint

**Security Assessment:** Strong
**Code Quality:** High
**Documentation:** Excellent

---

## Phase 2: Repository Layer (COMPLETED ✅)

### What Was Implemented

Implemented the repository pattern with dual implementations (database and filesystem) controlled by feature flag. This provides an abstraction layer for credential access while maintaining 100% backward compatibility.

**Commits:** ac42415 (implementations), 331ad9b (integration)

#### Repository Interfaces

**Location:** `services/proxy/src/repositories/IAccountRepository.ts`

Defines the contract for account credential operations:

- `listAccountNames()` - Returns all available account names
- `getAccountByName()` - Fetches a decrypted account
- `getApiKey()` - Gets API key or OAuth access token (with auto-refresh check)
- `updateOAuthTokens()` - Updates OAuth credentials (concurrency-safe)
- `updateLastUsed()` - Tracks account usage
- `clearCache()` - Clears credential cache

**Location:** `services/proxy/src/repositories/ITrainRepository.ts`

Defines the contract for train-specific operations:

- `getAccountNamesForTrain()` - Returns mapped account names for a train (priority-ordered)
- `getAccountsForTrain()` - Returns full decrypted accounts for a train
- `validateClientKey()` - Validates hashed client API keys
- `getSlackConfig()` - Retrieves train-specific Slack configuration

#### Repository Implementations

**Filesystem Repositories:**

**Location:** `services/proxy/src/repositories/FilesystemAccountRepository.ts`

```typescript
import { Pool } from 'pg'
import { DecryptedAccount } from '@agent-prompttrain/shared'

export interface IAccountRepository {
  // Core operations
  getAccount(accountId: string): Promise<DecryptedAccount | null>
  listAccounts(): Promise<DecryptedAccount[]>
  updateOAuthTokens(accountId: string, tokens: OAuthTokens): Promise<void>
  updateLastUsed(accountId: string): Promise<void>

  // OAuth-specific
  getAccountForRefresh(accountId: string): Promise<DecryptedAccount | null>
}

// Database implementation
export class DatabaseAccountRepository implements IAccountRepository {
  constructor(
    private pool: Pool,
    private encryptionKey: string
  ) {}

  async getAccount(accountId: string): Promise<DecryptedAccount | null> {
    // SELECT from accounts table
    // Decrypt credentials using encryption utilities
    // Return DecryptedAccount
  }

  async getAccountForRefresh(accountId: string): Promise<DecryptedAccount | null> {
    // Use SELECT ... FOR UPDATE to lock row during OAuth refresh
    // Prevents concurrent refresh attempts
    // Returns locked account for safe token update
  }

  async updateOAuthTokens(accountId: string, tokens: OAuthTokens): Promise<void> {
    // Encrypt new tokens
    // UPDATE accounts SET oauth_access_token_encrypted = $1, ...
    // Update expires_at and updated_at
  }

  async listAccounts(): Promise<DecryptedAccount[]> {
    // SELECT all active accounts
    // Decrypt each account's credentials
    // Return array of DecryptedAccount
  }
}

// Filesystem implementation (existing logic)
export class FilesystemAccountRepository implements IAccountRepository {
  // Wrap existing file-based logic from credentials.ts
  // Maintain current behavior for backward compatibility
}
```

#### 2. Train Repository Interface

**Location:** `services/proxy/src/repositories/TrainRepository.ts`

```typescript
export interface ITrainRepository {
  getTrain(trainId: string): Promise<Train | null>
  getTrainAccounts(trainId: string): Promise<string[]>
  validateClientKey(trainId: string, clientKey: string): Promise<boolean>
  getSlackConfig(trainId: string): Promise<SlackConfig | null>
}

export class DatabaseTrainRepository implements ITrainRepository {
  async validateClientKey(trainId: string, clientKey: string): Promise<boolean> {
    // Hash the provided key
    // Check if hash exists in client_api_keys_hashed array
    // Use ANY() operator for array membership check
  }

  async getTrainAccounts(trainId: string): Promise<string[]> {
    // Query train_account_mappings
    // Join with accounts table
    // Return ordered by priority
  }

  async getSlackConfig(trainId: string): Promise<SlackConfig | null> {
    // SELECT slack_config FROM trains WHERE train_id = $1
    // Parse JSONB to SlackConfig type
  }
}

export class FilesystemTrainRepository implements ITrainRepository {
  // Wrap existing train client key file logic
  // No Slack config in filesystem (will be null)
}
```

#### 3. Repository Factory

**Location:** `services/proxy/src/repositories/index.ts`

```typescript
import { config } from '@agent-prompttrain/shared'
import { Pool } from 'pg'

export function createRepositories(pool: Pool): {
  accountRepo: IAccountRepository
  trainRepo: ITrainRepository
} {
  if (config.credentials.useDatabaseStorage) {
    // Validate encryption key
    if (!config.credentials.encryptionKey || config.credentials.encryptionKey.length < 32) {
      throw new Error('CREDENTIAL_ENCRYPTION_KEY must be set and at least 32 characters')
    }

    return {
      accountRepo: new DatabaseAccountRepository(pool, config.credentials.encryptionKey),
      trainRepo: new DatabaseTrainRepository(pool),
    }
  }

  return {
    accountRepo: new FilesystemAccountRepository(),
    trainRepo: new FilesystemTrainRepository(),
  }
}
```

#### 4. Update Authentication Service

**Location:** `services/proxy/src/services/AuthenticationService.ts`

Modify to use repository pattern instead of direct file access:

```typescript
export class AuthenticationService {
  constructor(
    private accountRepo: IAccountRepository,
    private trainRepo: ITrainRepository
  ) {}

  async authenticate(context: RequestContext): Promise<AuthResult> {
    // Use accountRepo.listAccounts() instead of file listing
    // Use accountRepo.getAccount() instead of file reading
    // Maintain existing deterministic selection logic
  }

  async getClientApiKeys(trainId: string): Promise<string[]> {
    // Use trainRepo.validateClientKey() instead of file reading
  }
}
```

#### 5. Update OAuth Refresh Logic

**Location:** `services/proxy/src/credentials.ts`

Modify `getApiKey` function to use repository:

```typescript
export async function getApiKey(
  credentialPath: string,
  accountRepo: IAccountRepository
): Promise<string | null> {
  // Extract accountId from credentialPath
  // Use accountRepo.getAccount() instead of loadCredentials()

  // For OAuth, check if refresh needed
  if (needsRefresh) {
    // Use accountRepo.getAccountForRefresh() to lock row
    // Perform token refresh
    // Use accountRepo.updateOAuthTokens() to save
  }

  return accessToken
}
```

### Implementation Checklist

- [ ] Create `IAccountRepository` interface
- [ ] Implement `DatabaseAccountRepository` with encryption
- [ ] Implement `FilesystemAccountRepository` (wrap existing)
- [ ] Create `ITrainRepository` interface
- [ ] Implement `DatabaseTrainRepository`
- [ ] Implement `FilesystemTrainRepository`
- [ ] Create repository factory with feature flag logic
- [ ] Update `AuthenticationService` to use repositories
- [ ] Update OAuth refresh to use database locks
- [ ] Add unit tests for repository implementations
- [ ] Add integration tests for feature flag switching

### Testing Strategy

**Unit Tests:**

```typescript
describe('DatabaseAccountRepository', () => {
  it('should decrypt credentials correctly', async () => {
    // Test encryption/decryption round-trip
  })

  it('should lock account during OAuth refresh', async () => {
    // Test SELECT FOR UPDATE behavior
  })

  it('should handle concurrent refresh attempts', async () => {
    // Test that only one refresh happens
  })
})

describe('DatabaseTrainRepository', () => {
  it('should validate client API keys correctly', async () => {
    // Test hash verification
  })

  it('should return accounts in priority order', async () => {
    // Test train_account_mappings query
  })
})
```

**Integration Tests:**

```typescript
describe('Feature Flag Switching', () => {
  it('should use filesystem when flag is false', async () => {
    process.env.USE_DATABASE_CREDENTIALS = 'false'
    // Verify filesystem repositories are used
  })

  it('should use database when flag is true', async () => {
    process.env.USE_DATABASE_CREDENTIALS = 'true'
    // Verify database repositories are used
  })
})
```

---

## Phase 3: Dashboard Management UI (FUTURE)

### Overview

Create HTMX-based dashboard routes for managing accounts and trains. Follows existing dashboard architecture (ADR-009) with server-side rendering and progressive enhancement.

### Routes to Implement

#### 1. Account Management

**Location:** `services/dashboard/src/routes/accounts.ts`

```typescript
// List all accounts
GET /dashboard/accounts
  - Display table of all accounts
  - Show: account name, type, status, last used
  - Filter by type (API key / OAuth)
  - Search by account name
  - Click row to view details

// View account details
GET /dashboard/accounts/:id
  - Show full account information
  - Display credential type and metadata
  - Show OAuth expiry if applicable
  - List associated trains
  - Edit/delete buttons

// Create account form
GET /dashboard/accounts/new
POST /dashboard/accounts
  - HTMX form with real-time validation
  - Account name (required, unique)
  - Credential type selector (API key / OAuth)
  - Conditional fields based on type
  - Encrypt credentials before saving

// Update account
GET /dashboard/accounts/:id/edit
PUT /dashboard/accounts/:id
  - Pre-filled form with existing data
  - Allow credential rotation
  - Re-encrypt on save
  - HTMX partial update

// Delete account (soft delete)
DELETE /dashboard/accounts/:id
  - Confirm modal via HTMX
  - Set is_active = false
  - Remove from train mappings (or warn if in use)
```

#### 2. Train Management

**Location:** `services/dashboard/src/routes/trains.ts`

```typescript
// List all trains
GET /dashboard/trains
  - Display table of all trains
  - Show: train ID, name, account count, status
  - Filter by active/inactive
  - Search by train ID/name
  - Click row to view details

// View train details
GET /dashboard/trains/:id
  - Show train information
  - Display client API keys (hashed)
  - Show Slack configuration
  - List mapped accounts with priorities
  - Edit/delete buttons

// Create train
GET /dashboard/trains/new
POST /dashboard/trains
  - Train ID (required, unique)
  - Train name (optional)
  - Description (optional)
  - Client API keys (multiline input)
  - Slack configuration (JSON editor or form)
  - Hash keys before saving

// Update train
GET /dashboard/trains/:id/edit
PUT /dashboard/trains/:id
  - Pre-filled form
  - Allow key rotation
  - Update Slack config
  - HTMX partial update

// Manage account mappings
GET /dashboard/trains/:id/accounts
POST /dashboard/trains/:id/accounts
DELETE /dashboard/trains/:id/accounts/:accountId
  - Drag-and-drop priority ordering
  - Add/remove account mappings
  - Set default account
  - Real-time updates via HTMX
```

#### 3. HTMX Patterns

**List View with Filters:**

```html
<form hx-get="/dashboard/accounts" hx-target="#accounts-table">
  <input
    type="search"
    name="q"
    placeholder="Search accounts..."
    hx-trigger="keyup changed delay:300ms"
  />
  <select name="type" hx-trigger="change">
    <option value="">All Types</option>
    <option value="api_key">API Key</option>
    <option value="oauth">OAuth</option>
  </select>
</form>

<div id="accounts-table">
  <!-- Server-rendered table with HTMX attributes -->
</div>
```

**Create Form with Validation:**

```html
<form hx-post="/dashboard/accounts" hx-target="#form-container">
  <input
    name="account_name"
    hx-post="/dashboard/accounts/validate"
    hx-trigger="blur"
    hx-target="#name-validation"
  />
  <div id="name-validation"></div>

  <select name="credential_type" hx-get="/dashboard/accounts/fields" hx-target="#credential-fields">
    <option value="api_key">API Key</option>
    <option value="oauth">OAuth</option>
  </select>

  <div id="credential-fields">
    <!-- Dynamic fields based on type -->
  </div>

  <button type="submit">Create Account</button>
</form>
```

**Account-Train Mapping Interface:**

```html
<div id="account-mappings">
  <div class="mapping-list" hx-swap="outerHTML">
    <!-- Draggable account items with priority -->
    <div class="account-item" data-priority="0" draggable="true">
      <span class="drag-handle">⋮⋮</span>
      <span class="account-name">account-1</span>
      <button hx-delete="/dashboard/trains/{id}/accounts/account-1">Remove</button>
    </div>
  </div>

  <form hx-post="/dashboard/trains/{id}/accounts">
    <select name="account_id">
      <!-- Available accounts -->
    </select>
    <button type="submit">Add Account</button>
  </form>
</div>
```

### UI Components to Build

**1. Account Card Component**

- Display account info in card format
- Show credential type badge
- OAuth expiry indicator
- Last used timestamp
- Quick actions (edit, delete)

**2. Train Card Component**

- Train ID and name
- Account count badge
- Slack config indicator
- Client key count
- Status badge (active/inactive)

**3. Credential Form Components**

- API key input with show/hide toggle
- OAuth token fields (access, refresh)
- Scope selector (checkboxes)
- Max tier toggle
- Validation indicators

**4. Slack Config Editor**

- Webhook URL input
- Channel selector
- Username and emoji inputs
- Test button (send test message)
- Enable/disable toggle

**5. Priority Ordering UI**

- Drag-and-drop interface
- Visual priority indicators
- Save order button
- Reset to default

### Security Considerations

**1. Dashboard Authentication**

- Enforce `DASHBOARD_API_KEY` in production (ADR-019)
- Session-based authentication
- CSRF protection on forms
- Rate limiting on endpoints

**2. Credential Display**

- Never show plaintext credentials
- Masked display with "show" toggle
- Audit log for credential views
- Time-limited display (auto-hide after 30s)

**3. Input Validation**

- Sanitize all user inputs
- Validate credential formats
- Check for injection attempts
- Server-side validation (never trust client)

**4. Audit Trail**

- Log all create/update/delete operations
- Track who made changes (if user auth implemented)
- Timestamp all modifications
- Immutable audit log

### Implementation Checklist

- [ ] Create account list route with filters
- [ ] Create account detail route
- [ ] Create account create/edit forms
- [ ] Create account delete confirmation
- [ ] Create train list route with filters
- [ ] Create train detail route
- [ ] Create train create/edit forms
- [ ] Create train-account mapping interface
- [ ] Build HTMX partial templates
- [ ] Implement drag-and-drop priority ordering
- [ ] Add Slack config editor
- [ ] Implement credential masking/unmasking
- [ ] Add form validation (client and server)
- [ ] Create audit logging for all operations
- [ ] Add E2E tests for CRUD operations
- [ ] Update navigation to include new routes

---

## Phase 4: Integration Testing (FUTURE)

### Test Categories

#### 1. Migration Tests

**Location:** `scripts/db/migrations/__tests__/`

```typescript
describe('Migration 013: Schema Creation', () => {
  it('should create all tables', async () => {
    // Run migration
    // Verify tables exist
    // Check constraints and indexes
  })

  it('should be idempotent', async () => {
    // Run migration twice
    // Verify no errors
    // Check data integrity
  })
})

describe('Migration 014: Data Import', () => {
  it('should import all filesystem credentials', async () => {
    // Create test credential files
    // Run migration
    // Verify data in database
    // Check encryption
  })

  it('should handle missing directories gracefully', async () => {
    // Run without credential files
    // Verify no errors
    // Check empty tables
  })
})
```

#### 2. Repository Tests

**Location:** `services/proxy/src/repositories/__tests__/`

```typescript
describe('DatabaseAccountRepository', () => {
  it('should retrieve and decrypt account correctly', async () => {
    // Insert encrypted account
    // Retrieve via repository
    // Verify decrypted values
  })

  it('should update OAuth tokens atomically', async () => {
    // Simulate concurrent refresh
    // Verify only one succeeds
    // Check final state
  })
})
```

#### 3. End-to-End Tests

**Location:** `e2e/credential-management.spec.ts`

```typescript
describe('Credential Management E2E', () => {
  test('should create account via dashboard', async ({ page }) => {
    await page.goto('/dashboard/accounts/new')
    await page.fill('[data-testid="account-name"]', 'test-account')
    await page.selectOption('[data-testid="credential-type"]', 'api_key')
    await page.fill('[data-testid="api-key"]', 'test-key-123')
    await page.click('[data-testid="submit"]')

    // Verify account created
    await expect(page.locator('[data-testid="account-list"]')).toContainText('test-account')
  })

  test('should authenticate using database credentials', async () => {
    // Enable database mode
    // Make proxy request
    // Verify authentication works
    // Check last_used_at updated
  })
})
```

#### 4. Performance Tests

**Location:** `services/proxy/src/__tests__/performance/`

```typescript
describe('Credential Lookup Performance', () => {
  it('should retrieve credentials under 100ms p99', async () => {
    // Benchmark database lookup
    // Compare with filesystem
    // Verify cache effectiveness
  })

  it('should handle concurrent OAuth refresh', async () => {
    // Simulate 100 concurrent requests
    // Verify only one refresh occurs
    // Check performance impact
  })
})
```

### Testing Strategy

**1. Unit Tests**

- Test each repository function independently
- Mock database connections
- Verify encryption/decryption
- Test error handling

**2. Integration Tests**

- Test repository with real database
- Verify feature flag switching
- Test OAuth refresh flow
- Check audit logging

**3. E2E Tests**

- Test complete user flows
- Dashboard CRUD operations
- Proxy authentication with database credentials
- Migration process

**4. Performance Tests**

- Benchmark credential lookup times
- Test concurrent access patterns
- Measure cache effectiveness
- Compare filesystem vs database performance

### Test Data Setup

**Test Fixtures:**

```typescript
// Test accounts
const testAccounts = [
  {
    accountId: 'acc_test_api',
    accountName: 'test-api-account',
    credentialType: 'api_key',
    apiKey: 'sk-ant-test-key-123',
  },
  {
    accountId: 'acc_test_oauth',
    accountName: 'test-oauth-account',
    credentialType: 'oauth',
    oauthAccessToken: 'access-token-123',
    oauthRefreshToken: 'refresh-token-456',
    oauthExpiresAt: Date.now() + 3600000,
  },
]

// Test trains
const testTrains = [
  {
    trainId: 'test-train-1',
    trainName: 'Test Train',
    clientApiKeys: ['cnp_test_key_1', 'cnp_test_key_2'],
    slackConfig: {
      webhook_url: 'https://hooks.slack.com/test',
      channel: '#test-alerts',
    },
  },
]
```

---

## Phase 5: Production Rollout (FUTURE)

### Pre-Deployment Checklist

**1. Security Validation**

- [ ] Encryption key securely stored (AWS Secrets Manager / Vault)
- [ ] Key rotation procedure documented
- [ ] Audit logging enabled and tested
- [ ] Dashboard authentication verified (DASHBOARD_API_KEY set)
- [ ] SSL/TLS enabled for database connections
- [ ] Credential masking working in dashboard
- [ ] No credentials in application logs

**2. Performance Validation**

- [ ] Credential lookup < 100ms p99
- [ ] OAuth refresh working with database locks
- [ ] Cache effectiveness verified
- [ ] Database indexes optimized
- [ ] Connection pooling configured
- [ ] Query performance analyzed

**3. Operational Readiness**

- [ ] Migration scripts tested on staging
- [ ] Rollback procedure documented
- [ ] Monitoring dashboards created
- [ ] Alert thresholds configured
- [ ] On-call runbook updated
- [ ] Backup strategy verified

**4. Documentation Complete**

- [ ] ADR-026 finalized
- [ ] Environment variables documented
- [ ] Migration guide written
- [ ] Dashboard user guide created
- [ ] Troubleshooting guide prepared

### Rollout Strategy

**Stage 1: Staging Validation (Week 1)**

1. Deploy to staging with `USE_DATABASE_CREDENTIALS=false`
2. Run migration scripts on staging database
3. Verify data import successful
4. Run full test suite
5. Enable database mode (`USE_DATABASE_CREDENTIALS=true`)
6. Monitor for 48 hours:
   - Credential lookup latency
   - OAuth refresh operations
   - Error rates and logs
   - Database connection pool utilization

**Stage 2: Production Migration (Week 2)**

1. **Maintenance Window Planning**
   - Schedule 2-hour window
   - Notify all stakeholders
   - Prepare rollback plan

2. **Migration Execution**

   ```bash
   # Backup current state
   pg_dump $DATABASE_URL > backup_before_migration.sql

   # Run migrations
   bun run scripts/db/migrations/013-accounts-trains-schema.ts
   bun run scripts/db/migrations/014-import-credentials-data.ts

   # Verify data
   psql $DATABASE_URL -c "SELECT COUNT(*) FROM accounts;"
   psql $DATABASE_URL -c "SELECT COUNT(*) FROM trains;"
   ```

3. **Deploy with Feature Flag Off**

   ```bash
   # Deploy code
   USE_DATABASE_CREDENTIALS=false
   CREDENTIAL_ENCRYPTION_KEY=$ENCRYPTION_KEY

   # Restart services
   docker-compose restart proxy dashboard
   ```

4. **Validate Deployment**
   - Check all services healthy
   - Verify filesystem mode working
   - Monitor error logs
   - Test sample requests

**Stage 3: Gradual Enablement (Week 3)**

1. **Enable for 10% of Trains**

   ```sql
   -- Mark specific trains for database mode
   UPDATE trains SET use_database = true
   WHERE train_id IN ('train-1', 'train-2', 'train-3');
   ```

2. **Monitor for 24 Hours**
   - Credential lookup latency
   - OAuth refresh success rate
   - Error rates compared to baseline
   - Database query performance

3. **Enable for 50% of Trains**
   - Continue monitoring
   - Compare metrics between database and filesystem modes

4. **Enable for 100% of Trains**
   - Full cutover to database mode
   - Keep filesystem as backup for 30 days

**Stage 4: Cleanup (Week 4)**

1. **After 30 Days of Stable Operation**
   - Remove filesystem fallback code
   - Delete credential files (after backup)
   - Update documentation to database-only
   - Remove feature flag

### Monitoring and Alerts

**Key Metrics to Track:**

1. **Performance Metrics**
   - Credential lookup latency (p50, p95, p99)
   - OAuth refresh duration
   - Database query time
   - Cache hit rate

2. **Error Metrics**
   - Authentication failures
   - Decryption errors
   - Database connection errors
   - OAuth refresh failures

3. **Usage Metrics**
   - Accounts accessed per minute
   - Trains active per hour
   - Database credentials usage percentage
   - Filesystem fallback usage (should trend to 0)

**Alert Thresholds:**

```yaml
alerts:
  - name: credential_lookup_slow
    condition: p99_latency > 200ms
    severity: warning

  - name: decryption_errors
    condition: error_rate > 1%
    severity: critical

  - name: database_connection_failure
    condition: db_errors > 5 in 5m
    severity: critical

  - name: oauth_refresh_failures
    condition: refresh_failures > 10%
    severity: warning
```

### Rollback Procedures

**Immediate Rollback (< 5 minutes):**

```bash
# Set feature flag to filesystem mode
USE_DATABASE_CREDENTIALS=false

# Restart services
docker-compose restart proxy dashboard

# Verify rollback
curl http://localhost:3000/health
```

**Data Rollback (if corruption detected):**

```bash
# Restore from backup
psql $DATABASE_URL < backup_before_migration.sql

# Verify restore
psql $DATABASE_URL -c "SELECT COUNT(*) FROM accounts;"

# Restart services
docker-compose restart proxy dashboard
```

**Partial Rollback (specific trains):**

```sql
-- Disable database mode for problematic trains
UPDATE trains SET use_database = false
WHERE train_id IN ('problematic-train-1', 'problematic-train-2');
```

---

## Success Metrics

### Phase 1 (Foundation) ✅

- [x] Database schema created successfully
- [x] Migration scripts are idempotent
- [x] TypeScript types defined
- [x] Encryption utilities implemented
- [x] Configuration updated
- [x] Documentation complete
- [x] Code review approved

### Phase 2 (Repository Layer)

- [ ] Repository interfaces defined
- [ ] Database repositories implemented with encryption
- [ ] Filesystem repositories wrap existing logic
- [ ] Feature flag switching works correctly
- [ ] OAuth refresh uses database locks
- [ ] Unit tests pass (>90% coverage)
- [ ] Integration tests pass

### Phase 3 (Dashboard UI)

- [ ] All CRUD routes implemented
- [ ] HTMX patterns working correctly
- [ ] Credential masking functional
- [ ] Slack config editor working
- [ ] Account-train mapping UI complete
- [ ] E2E tests pass
- [ ] Security audit passed

### Phase 4 (Testing)

- [ ] Migration tests pass
- [ ] Repository tests pass
- [ ] E2E tests pass
- [ ] Performance benchmarks met (<100ms p99)
- [ ] Load testing passed
- [ ] Security testing passed

### Phase 5 (Production)

- [ ] Staging validation successful
- [ ] Production migration successful
- [ ] Zero service interruptions
- [ ] Performance targets met
- [ ] Error rates < 0.1%
- [ ] All monitors green
- [ ] Positive user feedback

---

## Risk Mitigation

### Technical Risks

**Risk 1: Encryption Key Exposure**

- **Impact:** Critical - All credentials compromised
- **Mitigation:**
  - Store key in secrets manager (AWS Secrets Manager, Vault)
  - Never commit to version control
  - Rotate keys periodically
  - Audit key access logs

**Risk 2: Database Performance Degradation**

- **Impact:** High - Slow authentication
- **Mitigation:**
  - Comprehensive indexes on query patterns
  - Connection pooling (20 connections)
  - Query result caching
  - Regular ANALYZE operations
  - Monitor slow query log

**Risk 3: Migration Data Corruption**

- **Impact:** Critical - Lost credentials
- **Mitigation:**
  - Transaction-based migrations with rollback
  - Verification steps after each operation
  - Keep filesystem as backup during transition
  - Test migrations on staging first
  - Database backups before migration

**Risk 4: OAuth Refresh Race Conditions**

- **Impact:** Medium - Duplicate refresh requests
- **Mitigation:**
  - Use SELECT FOR UPDATE for row locking
  - Implement refresh deduplication
  - Handle lock timeout gracefully
  - Monitor concurrent refresh attempts

**Risk 5: Feature Flag Misconfiguration**

- **Impact:** High - Wrong credential source
- **Mitigation:**
  - Safe default (filesystem mode)
  - Clear documentation and examples
  - Environment validation on startup
  - Configuration audit in logs

### Operational Risks

**Risk 6: Insufficient Testing**

- **Impact:** High - Production issues
- **Mitigation:**
  - Comprehensive test suite (unit, integration, E2E)
  - Staging validation before production
  - Gradual rollout with monitoring
  - Canary deployments

**Risk 7: Poor Documentation**

- **Impact:** Medium - Operational confusion
- **Mitigation:**
  - Complete ADR with decision rationale
  - Environment variable documentation
  - Migration guide with examples
  - Troubleshooting runbook
  - Dashboard user guide

**Risk 8: Monitoring Gaps**

- **Impact:** Medium - Delayed incident detection
- **Mitigation:**
  - Comprehensive metrics (performance, errors, usage)
  - Alert thresholds based on baseline
  - Dashboard for real-time monitoring
  - On-call runbook with procedures

---

## Future Enhancements

### Potential Improvements (Not Planned Yet)

1. **Multi-Region Support**
   - Replicate credentials across regions
   - Read replicas for low latency
   - Automatic failover

2. **Credential Rotation Automation**
   - Scheduled rotation workflows
   - Zero-downtime credential updates
   - Automatic API key regeneration

3. **Advanced Audit Logging**
   - Detailed access logs
   - Change history with diffs
   - Compliance reporting

4. **External Secret Manager Integration**
   - Native support for AWS Secrets Manager
   - HashiCorp Vault integration
   - Azure Key Vault support

5. **Row-Level Security**
   - Multi-tenant isolation
   - Per-user access controls
   - Policy-based permissions

6. **Credential Health Monitoring**
   - OAuth expiry alerts
   - API key usage tracking
   - Automatic health checks

7. **Bulk Operations**
   - Batch account creation
   - CSV import/export
   - Template-based provisioning

---

## Conclusion

The train-id and credential management migration to database is a multi-phase project that will significantly improve the scalability, security, and manageability of the proxy system.

**Current Status:** Phase 1 (Foundation) is complete with PR #144 merged.

**Next Immediate Steps:**

1. Implement repository layer (Phase 2)
2. Create dashboard UI (Phase 3)
3. Comprehensive testing (Phase 4)
4. Production rollout (Phase 5)

**Timeline Estimate:**

- Phase 2: 1-2 weeks
- Phase 3: 2-3 weeks
- Phase 4: 1 week
- Phase 5: 1 week (gradual rollout)

**Total:** 5-7 weeks to full production deployment

**Success Criteria:**

- Zero service interruptions
- < 100ms p99 credential lookup latency
- All security requirements met
- Dashboard fully functional
- Complete documentation

This roadmap provides a comprehensive guide for completing the migration with minimal risk and maximum benefit to the system.
