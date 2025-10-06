# Authentication Guide

Agent Prompt Train uses database-backed credential management to secure access to both the proxy itself and the Claude API.

## Overview

The proxy uses a two-layer authentication system:

1. **Client Authentication**: Authenticates requests to the proxy (train-scoped API keys)
2. **Claude API Authentication**: OAuth credentials stored in PostgreSQL database

## Client Authentication

### Train-Scoped API Keys

The proxy requires clients to authenticate using per-train Bearer tokens stored in the database. API keys are managed via the dashboard REST API.

#### Generating an API Key

**Via Dashboard API**:

```bash
curl -X POST http://localhost:3001/api/trains/your-train-id/api-keys \
  -H "Content-Type: application/json" \
  -H "X-Dashboard-Key: your-dashboard-key" \
  -d '{"description": "Production API key for mobile app"}'
```

Response includes the full key (shown only once):

```json
{
  "api_key": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "train_id": "your-train-id",
    "key": "cnp_live_abc123xyz789...",
    "key_preview": "cnp_live_a",
    "description": "Production API key for mobile app",
    "created_at": "2025-08-19T12:00:00Z",
    "last_used_at": null
  }
}
```

**⚠️ Important**: Save the `key` value immediately - it won't be shown again.

#### Using an API Key

Client requests must include the API key:

```bash
curl -X POST http://proxy:3000/v1/messages \
  -H "MSL-Train-Id: your-train-id" \
  -H "Authorization: Bearer cnp_live_abc123xyz789..." \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}], "model": "claude-3-5-sonnet-20241022"}'
```

#### Listing API Keys

```bash
curl http://localhost:3001/api/trains/your-train-id/api-keys \
  -H "X-Dashboard-Key: your-dashboard-key"
```

Response shows all keys (without full key values):

```json
{
  "api_keys": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "key_preview": "cnp_live_a",
      "description": "Production API key for mobile app",
      "created_at": "2025-08-19T12:00:00Z",
      "last_used_at": "2025-08-19T14:30:00Z",
      "revoked_at": null
    }
  ]
}
```

#### Revoking an API Key

```bash
curl -X DELETE http://localhost:3001/api/trains/your-train-id/api-keys/550e8400-e29b-41d4-a716-446655440000 \
  -H "X-Dashboard-Key: your-dashboard-key"
```

### Disabling Client Authentication

For development or internal use, you can disable client authentication:

```bash
ENABLE_CLIENT_AUTH=false
```

⚠️ **Warning**: Only disable client authentication in secure, internal environments.

## Dashboard Authentication

The dashboard supports two production-grade authentication approaches:

1. **API Key Authentication** (existing behavior)
2. **Google SSO via OAuth2 Proxy** (recommended for shared deployments)

### API Key Authentication

Set a dashboard API key in your environment:

```bash
DASHBOARD_API_KEY=your-secure-dashboard-key
```

Access the dashboard with this key:

```javascript
// Using header
fetch('http://localhost:3001/api/stats', {
  headers: {
    'X-Dashboard-Key': 'your-secure-dashboard-key',
  },
})

// Using cookie (set by login page)
// Cookie: dashboard_auth=your-secure-dashboard-key
```

### Google SSO via OAuth2 Proxy

For environments running Nginx in front of the dashboard, deploy [OAuth2 Proxy](https://oauth2-proxy.github.io/oauth2-proxy/) as an auth middleware. See [ADR-025](../04-Architecture/ADRs/adr-025-dashboard-sso-proxy.md) for full configuration details.

#### Enable Dashboard SSO

```bash
DASHBOARD_SSO_ENABLED=true
DASHBOARD_SSO_HEADERS=X-Auth-Request-Email
DASHBOARD_SSO_ALLOWED_DOMAINS=example.com
DASHBOARD_API_KEY=cnp_live_automation_only   # keep for API clients
```

## Claude API Authentication

The proxy uses **OAuth-only authentication** stored in the PostgreSQL database. All credentials are managed via the database and dashboard APIs.

### Setting Up OAuth Credentials

#### Step 1: Run OAuth Login Script

The OAuth login script will guide you through the authentication flow:

```bash
bun run scripts/auth/oauth-login.ts
```

The script will:

1. Prompt for **Account ID** (e.g., `acc_team_alpha`)
2. Prompt for **Account Name** (e.g., `Team Alpha`)
3. Generate an authorization URL
4. Open your browser to authorize with Anthropic
5. Prompt you to paste the authorization code
6. Exchange the code for OAuth tokens
7. Save the credential to the database

Example session:

```
Starting OAuth login flow...

Enter account ID (e.g., acc_team_alpha): acc_marketing
Enter account name (e.g., Team Alpha): Marketing Team

Please visit the following URL to authorize:
https://claude.ai/oauth/authorize?code=true&client_id=...

After authorizing, you will see an authorization code.
Copy the entire code (it should contain a # character).

Enter the authorization code: abc123def456#state789xyz

Exchanging authorization code for tokens...
Saving credentials to database...

✅ OAuth credentials saved successfully!
   Account ID: acc_marketing
   Account Name: Marketing Team
   Expires At: 2025-08-20T12:00:00Z

Next steps:
1. Create or update a train via the dashboard
2. Link this credential to the train
3. Generate API keys for the train
```

#### Step 2: Create a Train

Create a train via the dashboard API:

```bash
curl -X POST http://localhost:3001/api/trains \
  -H "Content-Type: application/json" \
  -H "X-Dashboard-Key: your-dashboard-key" \
  -d '{
    "train_id": "marketing-prod",
    "description": "Marketing team production train",
    "is_active": true
  }'
```

#### Step 3: Link Credential to Train

Link the OAuth credential to your train:

```bash
curl -X POST http://localhost:3001/api/trains/marketing-prod/accounts \
  -H "Content-Type: application/json" \
  -H "X-Dashboard-Key": "your-dashboard-key" \
  -d '{
    "credential_id": "550e8400-e29b-41d4-a716-446655440000"
  }'
```

#### Step 4: Generate Train API Keys

Now you can generate client API keys for the train (see [Client Authentication](#client-authentication) above).

### Managing Credentials

#### List All Credentials

```bash
curl http://localhost:3001/api/credentials \
  -H "X-Dashboard-Key: your-dashboard-key"
```

Response:

```json
{
  "credentials": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "account_id": "acc_marketing",
      "account_name": "Marketing Team",
      "oauth_expires_at": "2025-08-20T12:00:00Z",
      "oauth_scopes": ["org:create_api_key", "user:profile", "user:inference"],
      "oauth_is_max": false,
      "created_at": "2025-08-19T10:00:00Z",
      "updated_at": "2025-08-19T12:00:00Z",
      "last_refresh_at": "2025-08-19T12:00:00Z"
    }
  ]
}
```

**Note**: Credential responses never include OAuth tokens (access_token, refresh_token). These are only accessible internally by the proxy service.

#### Get Credential Details

```bash
curl http://localhost:3001/api/credentials/550e8400-e29b-41d4-a716-446655440000 \
  -H "X-Dashboard-Key: your-dashboard-key"
```

### Managing Trains

#### List All Trains

```bash
curl http://localhost:3001/api/trains \
  -H "X-Dashboard-Key: your-dashboard-key"
```

Response shows trains with linked credentials:

```json
{
  "trains": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "train_id": "marketing-prod",
      "description": "Marketing team production train",
      "is_active": true,
      "slack_webhook_url": null,
      "created_at": "2025-08-19T10:00:00Z",
      "updated_at": "2025-08-19T10:00:00Z",
      "credentials": [
        {
          "id": "660e8400-e29b-41d4-a716-446655440001",
          "account_id": "acc_marketing",
          "account_name": "Marketing Team",
          "oauth_expires_at": "2025-08-20T12:00:00Z"
        }
      ]
    }
  ]
}
```

#### Update Train Configuration

```bash
curl -X PUT http://localhost:3001/api/trains/550e8400-e29b-41d4-a716-446655440000 \
  -H "Content-Type: application/json" \
  -H "X-Dashboard-Key: your-dashboard-key" \
  -d '{
    "description": "Marketing team production (updated)",
    "slack_webhook_url": "https://hooks.slack.com/services/T00/B00/XXX",
    "is_active": true
  }'
```

#### Unlink Credential from Train

```bash
curl -X DELETE http://localhost:3001/api/trains/marketing-prod/accounts/660e8400-e29b-41d4-a716-446655440001 \
  -H "X-Dashboard-Key: your-dashboard-key"
```

## OAuth Management

### OAuth Auto-Refresh

The proxy automatically refreshes OAuth tokens:

- Checks token expiration 1 minute before expiry
- Refreshes token using the refresh token
- Updates database with new tokens
- Adds `anthropic-beta: oauth-2025-04-20` header

The OAuth refresh process includes:

- **Concurrent Request Coalescing**: Multiple simultaneous requests share the same refresh operation
- **Negative Caching**: Failed refresh attempts are cached for 5 minutes to prevent retry storms
- **Refresh Metrics**: Track attempt counts, success rates, failures, and durations

### Credential Failover

Trains can link multiple credentials for automatic failover. When one credential expires or encounters errors, the proxy automatically tries the next linked credential.

**Example**: Link two credentials to a train for redundancy:

```bash
# Link primary credential
curl -X POST http://localhost:3001/api/trains/marketing-prod/accounts \
  -H "Content-Type: application/json" \
  -H "X-Dashboard-Key: your-dashboard-key" \
  -d '{"credential_id": "660e8400-e29b-41d4-a716-446655440001"}'

# Link backup credential
curl -X POST http://localhost:3001/api/trains/marketing-prod/accounts \
  -H "Content-Type: application/json" \
  -H "X-Dashboard-Key: your-dashboard-key" \
  -d '{"credential_id": "770e8400-e29b-41d4-a716-446655440002"}'
```

The proxy will use credentials in the order they were linked. If the first credential fails, it automatically tries the second.

## Security Best Practices

### Database Security

1. **Secure Database Access**: Use strong PostgreSQL credentials
2. **Network Security**: Restrict database access to proxy service only
3. **Connection Encryption**: Use SSL for database connections in production

### API Key Security

1. **Use Strong Keys**: Generated keys are cryptographically secure (32 random bytes)
2. **Store Securely**: Never commit API keys to version control
3. **Rotate Regularly**: Revoke and regenerate keys periodically
4. **Monitor Usage**: Track `last_used_at` timestamps to identify unused keys
5. **Revoke Unused**: Remove keys that are no longer needed

### OAuth Security

1. **Secure Storage**: OAuth tokens are stored in database (no encryption at rest in dev mode)
2. **Monitor Expiration**: Tokens auto-refresh, but monitor `oauth_expires_at` timestamps
3. **Audit Access**: Review OAuth scopes in credential details
4. **Revoke Unused**: Delete credentials that are no longer needed

### Dashboard Security

1. **Require API Key**: Always set `DASHBOARD_API_KEY` in production
2. **Use SSO**: Configure OAuth2 Proxy for shared deployments
3. **Limit Access**: Restrict dashboard access to authorized users only

## Multi-Train Setup

Support multiple trains with separate configurations:

- Each train has independent API keys
- Trains can share credentials (many-to-many relationship)
- Each train can have unique Slack webhooks
- Credential failover is train-specific

Example multi-train setup:

```bash
# Create marketing train
curl -X POST http://localhost:3001/api/trains \
  -H "Content-Type: application/json" \
  -H "X-Dashboard-Key: your-dashboard-key" \
  -d '{"train_id": "marketing-prod", "description": "Marketing team"}'

# Create engineering train
curl -X POST http://localhost:3001/api/trains \
  -H "Content-Type: application/json" \
  -H "X-Dashboard-Key: your-dashboard-key" \
  -d '{"train_id": "eng-prod", "description": "Engineering team"}'

# Link same credential to both trains (shared Claude account)
curl -X POST http://localhost:3001/api/trains/marketing-prod/accounts \
  -H "Content-Type: application/json" \
  -H "X-Dashboard-Key: your-dashboard-key" \
  -d '{"credential_id": "660e8400-e29b-41d4-a716-446655440001"}'

curl -X POST http://localhost:3001/api/trains/eng-prod/accounts \
  -H "Content-Type: application/json" \
  -H "X-Dashboard-Key: your-dashboard-key" \
  -d '{"credential_id": "660e8400-e29b-41d4-a716-446655440001"}'
```

## Environment Variables

### Authentication Configuration

```bash
# Enable/disable client authentication
ENABLE_CLIENT_AUTH=true

# OAuth client ID (optional, uses default if not set)
CLAUDE_OAUTH_CLIENT_ID=your-oauth-client-id

# Dashboard authentication
DASHBOARD_API_KEY=secure-dashboard-key

# Dashboard SSO (optional)
DASHBOARD_SSO_ENABLED=false
DASHBOARD_SSO_HEADERS=X-Auth-Request-Email
DASHBOARD_SSO_ALLOWED_DOMAINS=example.com

# Database connection (required)
DATABASE_URL=postgresql://user:password@localhost:5432/agent_prompttrain
```

## Monitoring Authentication

### View Auth Logs

```bash
# Enable debug mode
DEBUG=true bun run dev:proxy

# View auth-related logs
docker compose logs proxy | grep -i auth
```

### Track Authentication Metrics

The dashboard shows:

- Authentication success/failure rates
- Token refresh events
- Per-train authentication methods
- OAuth token expiration status
- API key last used timestamps

## Migration from Filesystem Credentials

If you have existing filesystem-based credentials:

1. **Run Database Migration**:

   ```bash
   bun run scripts/db/migrations/013-credential-train-management.ts
   ```

2. **Re-Add OAuth Credentials**: Run the OAuth login script for each account

   ```bash
   bun run scripts/auth/oauth-login.ts
   ```

3. **Create Trains**: Use dashboard API to create trains

4. **Link Credentials**: Associate credentials with trains via dashboard API

5. **Generate API Keys**: Create new train-scoped API keys

6. **Update Clients**: Replace old client API keys with new train-scoped keys

7. **Remove Old Files**: Delete the `credentials/` directory after verification

## Troubleshooting

### "No credentials configured for this train"

**Cause**: Train has no linked credentials

**Solution**: Link at least one credential to the train via dashboard API

### "Invalid client API key"

**Cause**: API key not found, revoked, or wrong train ID

**Solution**:

1. Verify train ID in `MSL-Train-Id` header matches
2. Check API key is not revoked
3. Regenerate API key if needed

### "Failed to refresh OAuth token"

**Cause**: Refresh token expired or revoked

**Solution**: Re-authenticate via OAuth login script

### Database Connection Errors

**Cause**: PostgreSQL not running or `DATABASE_URL` misconfigured

**Solution**:

1. Verify PostgreSQL is running: `pg_isready`
2. Check `DATABASE_URL` environment variable
3. Ensure database exists and migrations are run

## Next Steps

- [Configure your trains](./configuration.md)
- [Make your first API call](./api-reference.md)
- [Monitor usage in dashboard](./dashboard-guide.md)
- [Review ADR-026](../04-Architecture/ADRs/adr-026-database-credential-management.md) for architecture details
