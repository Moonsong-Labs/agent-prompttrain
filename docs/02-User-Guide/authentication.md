# Train-ID Authentication Guide

⚠️ **IMPORTANT**: This system has migrated from domain-based to train-id based authentication. See the [Migration Guide](migration-guide.md) for upgrade instructions.

Agent Prompt Train uses train-id based authentication to identify and route requests to the appropriate credentials.

## Overview

The proxy uses a two-layer authentication system:

1. **Client Authentication**: Authenticates requests to the proxy using API keys
2. **Train-ID Routing**: Routes requests to appropriate Claude credentials based on train-id

## Client Authentication

### API Key Authentication

The proxy can require clients to authenticate using a client API key:

```bash
# In your account credential file
{
  "client_api_key": "cnp_live_your_generated_key"
}
```

Client requests must include this key:

```bash
curl -X POST http://proxy:3000/v1/messages \
  -H "X-TRAIN-ID: my-project" \
  -H "Authorization: Bearer cnp_live_your_generated_key" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'
```

Generate a secure client API key:

```bash
bun run scripts/generate-api-key.ts
```

### Disabling Client Authentication

For development or internal use, you can disable client authentication:

```bash
ENABLE_CLIENT_AUTH=false
```

⚠️ **Warning**: Only disable client authentication in secure, internal environments.

## Claude API Authentication

The proxy supports two methods for authenticating with the Claude API:

### Method 1: API Key Authentication

Most common and straightforward method:

```json
{
  "type": "api_key",
  "accountId": "acc_unique_identifier",
  "api_key": "sk-ant-api03-...",
  "client_api_key": "cnp_live_..."
}
```

### Method 2: OAuth Authentication

For enhanced security and automatic token management:

```json
{
  "type": "oauth",
  "accountId": "acc_unique_identifier",
  "client_api_key": "cnp_live_...",
  "oauth": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": 1234567890000,
    "scopes": ["org:create_api_key", "user:profile", "user:inference"],
    "isMax": false
  }
}
```

## Setting Up Authentication

### Step 1: Create Credentials Directory

```bash
mkdir -p credentials
```

### Step 2: Create Account Credential File

For API key authentication:

```bash
cat > credentials/account-001.credentials.json << EOF
{
  "type": "api_key",
  "accountId": "acc_$(uuidgen)",
  "api_key": "sk-ant-your-claude-api-key",
  "client_api_key": "$(bun run scripts/generate-api-key.ts)"
}
EOF
```

For OAuth authentication:

```bash
bun run scripts/oauth-login.ts credentials/account-001.credentials.json
```

### Step 3: Configure Request Headers

Requests must include the X-TRAIN-ID header:

```bash
# The X-TRAIN-ID header identifies your project/application
curl -H "X-TRAIN-ID: my-project" http://localhost:3000/v1/messages
```

**How it works:**

- Train-ids are consistently hashed to map to available accounts
- Multiple train-ids can share the same account credentials
- Default train-id is "default" if header is not provided

## OAuth Management

### OAuth Auto-Refresh

The proxy automatically refreshes OAuth tokens:

- Checks token expiration 1 minute before expiry
- Refreshes token using the refresh token
- Updates credential file with new tokens
- Adds `anthropic-beta: oauth-2025-04-20` header

### Check OAuth Status

```bash
bun run scripts/check-oauth-status.ts credentials/account-001.credentials.json
```

Output shows:

- Token validity status
- Expiration time
- Available scopes
- Refresh token presence

### Manual Token Refresh

```bash
# Refresh if expiring soon
bun run scripts/oauth-refresh.ts credentials/account-001.credentials.json

# Force refresh
bun run scripts/oauth-refresh.ts credentials/account-001.credentials.json --force
```

### Refresh All Tokens

```bash
# Check all accounts
bun run scripts/oauth-refresh-all.ts credentials --dry-run

# Actually refresh
bun run scripts/oauth-refresh-all.ts credentials
```

## OAuth Troubleshooting

### Common OAuth Errors

#### "Failed to refresh token: 400 Bad Request - Refresh token not found or invalid"

**Causes:**

- Refresh token expired or revoked
- Invalid or corrupted token
- OAuth client ID mismatch

**Solution:**

```bash
bun run scripts/oauth-login.ts credentials/account-001.credentials.json
```

#### "No refresh token available"

**Cause:** OAuth credentials missing refresh token

**Solution:** Re-authenticate to get complete credentials

### Debugging OAuth Issues

1. **Check credential file**:

   ```bash
   cat credentials/account-001.credentials.json | jq .
   ```

2. **Verify OAuth status**:

   ```bash
   bun run scripts/check-oauth-status.ts credentials/domain.credentials.json
   ```

3. **Test refresh token**:

   ```bash
   bun run scripts/test-oauth-refresh.ts <refresh_token>
   ```

4. **Enable debug logging**:
   ```bash
   DEBUG=true bun run dev:proxy
   ```

## Security Best Practices

### Credential File Security

1. **File Permissions**: Restrict access to credential files

   ```bash
   chmod 600 credentials/*.json
   ```

2. **Directory Permissions**: Secure the credentials directory

   ```bash
   chmod 700 credentials/
   ```

3. **Never Commit**: Add to .gitignore
   ```
   credentials/
   *.credentials.json
   ```

### API Key Security

1. **Use Strong Keys**: Generate cryptographically secure keys
2. **Rotate Regularly**: Update client API keys periodically
3. **Limit Scope**: Use separate keys for different environments
4. **Monitor Usage**: Track key usage in dashboard

### OAuth Security

1. **Secure Storage**: Protect OAuth tokens like passwords
2. **Monitor Expiration**: Set up alerts for expiring tokens
3. **Audit Access**: Review OAuth scopes regularly
4. **Revoke Unused**: Remove tokens for inactive domains

## Dashboard Authentication

The monitoring dashboard uses a separate API key:

```bash
# In .env
DASHBOARD_API_KEY=your-secure-dashboard-key
```

Access the dashboard:

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

## Multi-Domain Setup

Support multiple domains with separate credentials:

```bash
credentials/
├── app1.example.com.credentials.json
├── app2.example.com.credentials.json
└── staging.example.com.credentials.json
```

Each domain can use different:

- Authentication methods (API key vs OAuth)
- Claude accounts
- Client API keys
- Rate limits and quotas

## Environment Variables

### Authentication Configuration

```bash
# Enable/disable client authentication
ENABLE_CLIENT_AUTH=true

# OAuth client ID (optional)
CLAUDE_OAUTH_CLIENT_ID=your-oauth-client-id

# Dashboard authentication
DASHBOARD_API_KEY=secure-dashboard-key

# Credentials directory
CREDENTIALS_DIR=./credentials
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
- Per-domain authentication methods
- OAuth token expiration status

## Next Steps

- [Configure your domains](./configuration.md)
- [Make your first API call](./api-reference.md)
- [Monitor usage in dashboard](./dashboard-guide.md)
- [Set up OAuth automation](../03-Operations/security.md)
