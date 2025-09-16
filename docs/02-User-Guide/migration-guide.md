# Migration Guide: Domain-Based to Train-ID System

This guide helps you migrate from the old domain-based authentication system to the new train-id system.

## Overview

Agent Prompt Train has migrated from a domain-based authentication system (using `Host` headers) to a train-id system (using `X-TRAIN-ID` headers). This change provides:

- **Better flexibility**: No need to set up custom domains or subdomains
- **Improved security**: Clearer separation between project identification and authentication
- **Easier deployment**: Single endpoint for all projects
- **Enhanced monitoring**: Better project/user tracking and analytics

## Quick Migration Checklist

- [ ] **IMPORTANT**: Complete the codebase migration first (see Prerequisites below)
- [ ] Run database migration script
- [ ] Update credential files structure
- [ ] Update client code to use `X-TRAIN-ID` header
- [ ] Update environment variables for Claude CLI
- [ ] Test the migration works
- [ ] Update monitoring/dashboards

## Prerequisites

**⚠️ CRITICAL**: Before running this migration, ensure that the codebase migration from domain-based to train-id system has been completed. This means:

1. All TypeScript code has been updated to use `trainId` instead of `domain`
2. All database queries use `train_id` column instead of `domain`
3. All API endpoints accept `trainId` parameters instead of `domain`
4. The `X-TRAIN-ID` header extraction middleware is in place

If you see TypeScript errors related to missing `domain` properties, run the automated codebase migration script first:

```bash
# Run the automated codebase migration (use with caution - creates backups)
bun run scripts/replace-domain-with-trainid.sh

# Check for any remaining issues
bun run typecheck
```

**Note**: The automated migration script is provided for reference but should be reviewed carefully before running. Manual migration is recommended for production systems.

## 1. Database Migration

### Prerequisites

- PostgreSQL database access
- Database backup (recommended)

### Run Migration

```bash
# 1. Backup your database (REQUIRED)
bun run db:backup

# 2. Run the migration script
bun run scripts/db/migrations/012-migrate-to-train-id.ts
```

The migration will:

- Add `train_id` column to `api_requests` table
- Copy existing `domain` values to `train_id` field
- Add new indexes for performance
- Preserve all existing data

### Verify Migration

```bash
# Check that train_id column exists and has data
psql $DATABASE_URL -c "SELECT train_id, domain, COUNT(*) FROM api_requests GROUP BY train_id, domain LIMIT 10;"
```

## 2. Credential Files Migration

### Old System (Domain-Based)

```
credentials/
├── api.example.com.credentials.json
├── staging.example.com.credentials.json
└── localhost:3000.credentials.json
```

### New System (Account-Based)

```
credentials/
├── account1.credentials.json  # Maps to multiple train-ids via hash
├── account2.credentials.json
└── account3.credentials.json
```

### Migration Script

Run the credential migration helper:

```bash
# This script converts domain-specific credentials to account-based
bun run scripts/migrate-credentials.ts
```

Or migrate manually:

```bash
# Example: migrate api.example.com.credentials.json to account1.credentials.json
mv credentials/api.example.com.credentials.json credentials/account1.credentials.json

# Update the accountId in the file
cat credentials/account1.credentials.json
```

Update the `accountId` field in each credential file:

```json
{
  "type": "api_key",
  "accountId": "account1", // Update this to match filename
  "api_key": "sk-ant-...",
  "client_api_key": "cnp_live_..."
}
```

## 3. Client Code Migration

### REST API Calls

**Before (Domain-Based):**

```bash
# Different domains for different projects
curl -X POST https://api.example.com/v1/messages \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'

curl -X POST https://staging.example.com/v1/messages \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'
```

**After (Train-ID Based):**

```bash
# Single domain, different train-ids
curl -X POST https://your-proxy.com/v1/messages \
  -H "X-TRAIN-ID: api-example-com" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'

curl -X POST https://your-proxy.com/v1/messages \
  -H "X-TRAIN-ID: staging-example-com" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'
```

### JavaScript/TypeScript

**Before:**

```typescript
// Different base URLs
const prodClient = new AnthropicClient({
  baseURL: 'https://api.example.com',
  apiKey: 'YOUR_API_KEY',
})

const stagingClient = new AnthropicClient({
  baseURL: 'https://staging.example.com',
  apiKey: 'YOUR_API_KEY',
})
```

**After:**

```typescript
// Single base URL, different headers
const createClient = (trainId: string) =>
  new AnthropicClient({
    baseURL: 'https://your-proxy.com',
    apiKey: 'YOUR_API_KEY',
    defaultHeaders: {
      'X-TRAIN-ID': trainId,
    },
  })

const prodClient = createClient('api-example-com')
const stagingClient = createClient('staging-example-com')
```

### Python

**Before:**

```python
# Different clients for different domains
prod_client = anthropic.Anthropic(
    api_key="YOUR_API_KEY",
    base_url="https://api.example.com"
)

staging_client = anthropic.Anthropic(
    api_key="YOUR_API_KEY",
    base_url="https://staging.example.com"
)
```

**After:**

```python
# Single client with different headers
def create_client(train_id: str):
    return anthropic.Anthropic(
        api_key="YOUR_API_KEY",
        base_url="https://your-proxy.com",
        default_headers={"X-TRAIN-ID": train_id}
    )

prod_client = create_client("api-example-com")
staging_client = create_client("staging-example-com")
```

## 4. Claude CLI Migration

### Before (Domain-Based)

```bash
# Different base URLs for different projects
ANTHROPIC_BASE_URL=https://api.example.com claude "Hello"
ANTHROPIC_BASE_URL=https://staging.example.com claude "Hello"
```

### After (Train-ID Based)

```bash
# Single base URL with train-id header
export ANTHROPIC_BASE_URL=https://your-proxy.com
export ANTHROPIC_CUSTOM_HEADERS="train-id:api-example-com"
claude "Hello"

# For different projects, change the train-id
export ANTHROPIC_CUSTOM_HEADERS="train-id:staging-example-com"
claude "Hello"
```

### Environment Setup

Create environment-specific scripts:

```bash
# scripts/env/production.sh
export ANTHROPIC_BASE_URL=https://your-proxy.com
export ANTHROPIC_CUSTOM_HEADERS="train-id:production"

# scripts/env/staging.sh
export ANTHROPIC_BASE_URL=https://your-proxy.com
export ANTHROPIC_CUSTOM_HEADERS="train-id:staging"

# Usage:
source scripts/env/production.sh && claude "Hello"
```

## 5. Train-ID Best Practices

### Naming Convention

Use descriptive, consistent train-ids that map to your old domain structure:

```bash
# Domain → Train-ID mapping examples
api.example.com        → "api-example-com"
staging.example.com    → "staging-example-com"
dev.example.com        → "dev-example-com"
localhost:3000         → "localhost-dev"
team1.internal.com     → "team1-internal"
```

### Environment-Based IDs

Consider using environment prefixes:

```bash
# Production
export ANTHROPIC_CUSTOM_HEADERS="train-id:prod-api"

# Staging
export ANTHROPIC_CUSTOM_HEADERS="train-id:stage-api"

# Development (user-specific)
export ANTHROPIC_CUSTOM_HEADERS="train-id:dev-${USER}"
```

### Team/Project Organization

```bash
# By team
"team-frontend"
"team-backend"
"team-ml"

# By project
"project-alpha"
"project-beta"

# By environment and project
"prod-project-alpha"
"stage-project-alpha"
"dev-project-alpha"
```

## 6. Monitoring & Dashboard Updates

### Dashboard Changes

The dashboard now shows train-ids instead of domains:

- **Conversations**: Filtered by train-id instead of domain
- **Analytics**: Token usage grouped by train-id
- **Requests**: Listed with train-id information

### API Endpoint Changes

Update any monitoring or analytics tools:

**Before:**

```bash
curl "https://dashboard.example.com/api/requests?domain=api.example.com"
```

**After:**

```bash
curl "https://dashboard.example.com/api/requests?trainId=api-example-com"
```

## 7. Testing Your Migration

### 1. Verify Database Migration

```bash
# Check train_id data exists
psql $DATABASE_URL -c "SELECT COUNT(*) FROM api_requests WHERE train_id IS NOT NULL;"

# Check domain mapping
psql $DATABASE_URL -c "SELECT DISTINCT domain, train_id FROM api_requests ORDER BY domain LIMIT 20;"
```

### 2. Test Credential Resolution

```bash
# Test that train-ids resolve to correct accounts
curl -X POST https://your-proxy.com/v1/messages \
  -H "X-TRAIN-ID: your-test-train-id" \
  -H "Authorization: Bearer YOUR_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Test"}]}' \
  -v
```

Check the logs to see which account the train-id mapped to.

### 3. Verify Dashboard Access

```bash
# Check dashboard shows train-id data
open "https://dashboard.example.com"

# Or via API
curl "https://dashboard.example.com/api/requests?limit=1" \
  -H "Authorization: Bearer YOUR_DASHBOARD_KEY"
```

## 8. Rollback Plan

If you need to rollback the migration:

### Database Rollback

```sql
-- Remove train_id column (CAUTION: This loses train-id data)
ALTER TABLE api_requests DROP COLUMN train_id;

-- Remove new indexes
DROP INDEX IF EXISTS idx_api_requests_train_id;
DROP INDEX IF EXISTS idx_api_requests_train_id_timestamp;
```

### Credential Files Rollback

```bash
# Restore from backup
cp -r .migration-backup/credentials/* credentials/

# Or manually rename account files back to domain files
mv credentials/account1.credentials.json credentials/api.example.com.credentials.json
```

## 9. Common Issues

### Train-ID Not Found Errors

**Error**: `"No credentials found for train-id: xyz"`

**Solution**: Check that:

1. Credential files exist in `credentials/` directory
2. Account IDs in credential files match filenames
3. Train-id hashes to an available account

### Dashboard Shows No Data

**Issue**: Dashboard doesn't show historical data after migration

**Solution**:

1. Verify database migration completed successfully
2. Check that `train_id` column has data: `SELECT COUNT(*) FROM api_requests WHERE train_id IS NOT NULL;`
3. Clear browser cache and refresh dashboard

### Invalid Train-ID Errors

**Error**: `"Invalid train-id header"`

**Solution**: Train-IDs must:

- Be 1-255 characters long
- Contain only alphanumeric characters, underscores, and hyphens
- Not be empty

Valid: `my-project`, `team_1`, `prod-api`
Invalid: `my.project`, `team@1`, `prod api`

## 10. Support

If you encounter issues during migration:

1. **Check the logs**: Look for authentication and mapping errors
2. **Verify database**: Ensure migration completed successfully
3. **Test incrementally**: Migrate one project/environment at a time
4. **Use the default train-id**: Test with no `X-TRAIN-ID` header (uses "default")
5. **Create an issue**: Report problems with specific error messages

## Next Steps

After successful migration:

1. **Remove old documentation references** to domain-based setup
2. **Update CI/CD pipelines** to use new train-id headers
3. **Update team documentation** with new setup instructions
4. **Consider removing deprecated domain-based code** (if no longer needed)
5. **Monitor usage patterns** in the dashboard to ensure proper train-id distribution
