# Authentication Guide

Agent Prompt Train supports multiple authentication methods to secure access to both the proxy itself and the Claude API.

## Overview

The proxy uses a two-layer authentication system:

1. **Client Authentication**: Authenticates requests to the proxy
2. **Claude API Authentication**: Authenticates requests from the proxy to Claude

## Client Authentication

### API Key Authentication

The proxy can require clients to authenticate using per-train Bearer tokens stored under
`credentials/train-client-keys/<train-id>.client-keys.json`:

```bash
cat > credentials/train-client-keys/your-train-id.client-keys.json <<'JSON'
{ "keys": ["cnp_live_your_generated_key"] }
JSON
```

Client requests must include this key:

```bash
curl -X POST http://proxy:3000/v1/messages \
  -H "MSL-Train-Id: your-train-id" \
  -H "Authorization: Bearer cnp_live_your_generated_key" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'
```

Generate a secure client API key:

```bash
bun run scripts/auth/generate-api-key.ts
```

### Disabling Client Authentication

For development or internal use, you can disable client authentication:

```bash
ENABLE_CLIENT_AUTH=false
```

⚠️ **Warning**: Only disable client authentication in secure, internal environments.

## Dashboard Authentication

The dashboard now supports two production-grade authentication approaches:

1. **API Key Authentication** (existing behavior)
2. **Google SSO via OAuth2 Proxy** (recommended for shared deployments)

### Google SSO via OAuth2 Proxy

For environments running Nginx in front of the dashboard, deploy [OAuth2 Proxy](https://oauth2-proxy.github.io/oauth2-proxy/) as an auth middleware. Nginx uses the `auth_request` directive to require Google sign-in before requests reach the dashboard. When SSO is enabled, the dashboard trusts identity headers forwarded by OAuth2 Proxy and no longer needs the dashboard login page.

#### 1. Enable Dashboard SSO

Set the following environment variables (see `.env.example` for the full list):

```
DASHBOARD_SSO_ENABLED=true
DASHBOARD_SSO_HEADERS=X-Auth-Request-Email
DASHBOARD_SSO_ALLOWED_DOMAINS=example.com
DASHBOARD_API_KEY=cnp_live_automation_only   # keep for API clients and local bypass
```

`DASHBOARD_SSO_HEADERS` defaults to `X-Authenticated-User,X-Auth-Request-Email,X-Forwarded-Email`. Specify a comma-separated list if you use custom header names. Use `DASHBOARD_SSO_ALLOWED_DOMAINS` to restrict sign-ins to approved Google Workspace domains.

#### 2. Run OAuth2 Proxy

Example Docker Compose service:

```yaml
oauth2-proxy:
  image: quay.io/oauth2-proxy/oauth2-proxy:v7.8.1
  environment:
    OAUTH2_PROXY_PROVIDER: google
    OAUTH2_PROXY_CLIENT_ID: ${GOOGLE_CLIENT_ID}
    OAUTH2_PROXY_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET}
    OAUTH2_PROXY_COOKIE_SECRET: ${OAUTH_PROXY_COOKIE_SECRET} # 32 byte base64 string
    OAUTH2_PROXY_EMAIL_DOMAINS: example.com
    OAUTH2_PROXY_SET_XAUTHREQUEST: 'true'
    OAUTH2_PROXY_UPSTREAMS: 'http://dashboard:3001'
    OAUTH2_PROXY_REDIRECT_URL: https://dashboard.example.com/oauth2/callback
  ports:
    - '4180:4180'
```

#### 3. Update Nginx

```nginx
location /dashboard/ {
  auth_request /oauth2/auth;
  error_page 401 = @oauth2_sign_in;

  auth_request_set $email $upstream_http_x_auth_request_email;
  proxy_set_header X-Auth-Request-Email $email;
  proxy_set_header X-Forwarded-User $email;
  proxy_pass http://dashboard:3001;
}

location = /oauth2/auth {
  internal;
  proxy_pass http://127.0.0.1:4180;
}

location @oauth2_sign_in {
  return 302 https://$host/oauth2/start?rd=$scheme://$http_host$request_uri;
}
```

Retain API key support by allowing automation clients to route through a dedicated path (e.g., `/dashboard/api/`) with the `X-Dashboard-Key` header. See [ADR-025](../04-Architecture/ADRs/adr-025-dashboard-sso-proxy.md) for architectural context.

## Claude API Authentication

The proxy supports two methods for authenticating with the Claude API:

### Method 1: API Key Authentication

Most common and straightforward method:

```json
{
  "type": "api_key",
  "accountId": "acc_unique_identifier",
  "api_key": "sk-ant-api03-..."
}
```

### Method 2: OAuth Authentication

For enhanced security and automatic token management:

```json
{
  "type": "oauth",
  "accountId": "acc_unique_identifier",
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
mkdir -p credentials/accounts
mkdir -p credentials/train-client-keys
```

### Step 2: Create Account Credential File

For API key authentication:

```bash
cat > credentials/accounts/account-primary.credentials.json <<'JSON'
{
  "type": "api_key",
  "accountId": "acc_$(uuidgen)",
  "api_key": "sk-ant-your-claude-api-key"
}
JSON
```

For OAuth authentication:

```bash
bun run scripts/auth/oauth-login.ts credentials/accounts/account-primary.credentials.json
```

### Step 3: Configure Request Headers

Requests must include the correct `MSL-Train-Id` header. Add `MSL-Account` to pin a
specific account credential (otherwise the proxy deterministically assigns an account based on the train ID):

```bash
# Train identification header (required)
curl -H "MSL-Train-Id: your-train-id" \
     -H "MSL-Account: account-primary" \
     http://localhost:3000/v1/messages
```

## OAuth Management

### OAuth Auto-Refresh

The proxy automatically refreshes OAuth tokens:

- Checks token expiration 1 minute before expiry
- Refreshes token using the refresh token
- Updates credential file with new tokens
- Adds `anthropic-beta: oauth-2025-04-20` header

### Check OAuth Status

```bash
bun run scripts/check-oauth-status.ts credentials/accounts/account-primary.credentials.json
```

Output shows:

- Token validity status
- Expiration time
- Available scopes
- Refresh token presence

### Manual Token Refresh

```bash
# Refresh if expiring soon
bun run scripts/oauth-refresh.ts credentials/accounts/account-primary.credentials.json

# Force refresh
bun run scripts/oauth-refresh.ts credentials/accounts/account-primary.credentials.json --force
```

### Refresh All Tokens

```bash
# Check all trains
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
bun run scripts/auth/oauth-login.ts credentials/accounts/account-primary.credentials.json
```

#### "No refresh token available"

**Cause:** OAuth credentials missing refresh token

**Solution:** Re-authenticate to get complete credentials

### Debugging OAuth Issues

1. **Check credential file**:

   ```bash
   cat credentials/accounts/account-primary.credentials.json | jq .
   ```

2. **Verify OAuth status**:

   ```bash
   bun run scripts/check-oauth-status.ts credentials/train-id.credentials.json
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
4. **Revoke Unused**: Remove tokens for inactive trains

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

## Multi-Train Setup

Support multiple trains with separate credentials:

```bash
credentials/
├── train-alpha.credentials.json
├── train-beta.credentials.json
└── staging.credentials.json
```

Each train can use different:

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
- Per-train authentication methods
- OAuth token expiration status

## Next Steps

- [Configure your trains](./configuration.md)
- [Make your first API call](./api-reference.md)
- [Monitor usage in dashboard](./dashboard-guide.md)
- [Set up OAuth automation](../03-Operations/security.md)
