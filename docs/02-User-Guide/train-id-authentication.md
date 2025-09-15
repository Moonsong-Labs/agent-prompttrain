# Train-ID Authentication

## Overview

The Agent Prompt Train proxy uses a `train-id` header system to identify and authenticate requests from different projects or users. This replaces the previous domain-based authentication system.

## How It Works

### Request Identification

Every request to the proxy must include an `X-TRAIN-ID` header to identify the source project/user:

```bash
curl -X POST https://your-proxy.com/v1/messages \
  -H "X-TRAIN-ID: my-project" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_CLIENT_API_KEY" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'
```

If no `X-TRAIN-ID` header is provided, the system uses `"default"` as the train-id.

### Using ANTHROPIC_CUSTOM_HEADERS

When using the Claude CLI or SDK, you can set the train-id via the `ANTHROPIC_CUSTOM_HEADERS` environment variable:

```bash
export ANTHROPIC_CUSTOM_HEADERS="train-id:my_project"
```

This will automatically add the `X-TRAIN-ID: my_project` header to all requests.

## Authentication Flow

### Account Mapping

The proxy uses consistent hashing to map train-ids to available credential accounts:

1. **Default train-id**: Uses the default API key if configured
2. **Project-specific train-ids**: Maps to accounts using SHA-256 hashing

### Credential Files

Credential files are stored per account (not per train-id):

```
credentials/
├── account1.credentials.json
├── account2.credentials.json
└── account3.credentials.json
```

Each credential file contains:

```json
{
  "type": "api_key",
  "accountId": "acc_12345",
  "api_key": "sk-ant-...",
  "betaHeader": "oauth-2025-04-20"
}
```

Or for OAuth:

```json
{
  "type": "oauth",
  "accountId": "acc_67890",
  "oauth": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": 1234567890000,
    "scopes": ["read", "write"],
    "isMax": true
  },
  "betaHeader": "oauth-2025-04-20"
}
```

### Consistent Account Assignment

Train-ids are consistently mapped to accounts using SHA-256 hashing:

- Same train-id always maps to the same account
- Load is distributed evenly across available accounts
- Adding/removing accounts may cause remapping

## Migration from Domain-Based System

### Database Migration

Run the migration script to update your database:

```bash
psql $DATABASE_URL < scripts/migrate-to-train-id.sql
```

This will:
1. Add `train_id` column to `api_requests` table
2. Copy existing domain values to train_id
3. Update indexes for performance

### Client Updates

Update your clients to use the X-TRAIN-ID header instead of relying on the Host header:

**Before (domain-based):**
```bash
curl -X POST https://project1.your-proxy.com/v1/messages
```

**After (train-id):**
```bash
curl -X POST https://your-proxy.com/v1/messages \
  -H "X-TRAIN-ID: project1"
```

## Rate Limiting

Rate limits are applied per train-id:

- Default limits: 5000 requests/hour, 5M tokens/hour per train-id
- Limits can be configured via environment variables
- The `default` train-id has its own separate limits

## Dashboard and Monitoring

The dashboard displays train-ids instead of domains:

- Filter conversations by train-id
- View usage statistics per train-id
- Track token usage by train-id

## Best Practices

1. **Use descriptive train-ids**: Choose names that clearly identify your project or environment
   - Good: `production-api`, `staging-tests`, `dev-john`
   - Bad: `1`, `test`, `abc`

2. **Consistent naming**: Use the same train-id across your application for proper tracking

3. **Environment-specific IDs**: Use different train-ids for different environments:
   ```bash
   # Production
   export ANTHROPIC_CUSTOM_HEADERS="train-id:prod-api"
   
   # Staging
   export ANTHROPIC_CUSTOM_HEADERS="train-id:staging-api"
   
   # Development
   export ANTHROPIC_CUSTOM_HEADERS="train-id:dev-${USER}"
   ```

4. **Security**: Train-ids are not secrets but should be consistent within your organization

## Troubleshooting

### No Authentication

If you see "No default API key configured" errors:
- Ensure you have credential files in the `credentials/` directory
- Check that the default API key is set if using `train-id: default`

### Rate Limiting

If you hit rate limits:
- Use different train-ids for different use cases
- Monitor usage via the dashboard
- Adjust rate limits in configuration if needed

### Account Assignment

To see which account a train-id maps to:
- Check the proxy logs for "Authentication successful" messages
- These show the train-id → account mapping