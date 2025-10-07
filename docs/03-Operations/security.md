# Security Guide

This guide covers security considerations and best practices for deploying Agent Prompt Train.

## ⚠️ CRITICAL SECURITY NOTICE

**Dashboard Authentication**: The dashboard requires mandatory user authentication via oauth2-proxy headers. There is no unauthenticated mode.

**ALWAYS deploy with oauth2-proxy in production!**

Without oauth2-proxy configured, the dashboard will only be accessible in development mode with `DASHBOARD_DEV_USER_EMAIL` set. Production deployments MUST use oauth2-proxy with proper SSO configuration.

See [ADR-027: Mandatory User Authentication](../04-Architecture/ADRs/adr-027-mandatory-user-authentication.md) for detailed information about the authentication architecture.

## Authentication

### Client Authentication

The proxy supports multiple authentication layers:

1. **Client API Keys** - For authenticating clients to the proxy
2. **Claude API Keys** - For authenticating the proxy to Claude
3. **OAuth Tokens** - Alternative to API keys with auto-refresh

#### Client Authentication Setup

```bash
# Generate secure client API key
bun run auth:generate-key
# Output: cnp_live_1a2b3c4d5e6f...

# Add it to the train client key list
cat > credentials/train-client-keys/your-train-id.client-keys.json <<'JSON'
{ "keys": ["cnp_live_1a2b3c4d5e6f..."] }
JSON
```

Clients must include this key in requests:

```bash
curl -H "Authorization: Bearer cnp_live_..." http://proxy/v1/messages
```

#### Disabling Client Auth (Development Only)

```bash
ENABLE_CLIENT_AUTH=false  # NOT recommended for production
```

### OAuth Implementation

OAuth tokens are automatically refreshed before expiry:

```json
{
  "type": "oauth",
  "access_token": "...",
  "refresh_token": "...",
  "expires_at": "2024-12-31T23:59:59Z"
}
```

The proxy adds required headers:

```
anthropic-beta: oauth-2025-04-20
```

## Credential Management

### Storage Security

1. **File Permissions** - Credential files should be readable only by the proxy user:

```bash
chmod 600 credentials/*.json
chown proxy-user:proxy-user credentials/*.json
```

2. **Directory Security**:

```bash
chmod 700 credentials/
```

3. **Encryption at Rest** - Consider encrypting the credentials directory

### Credential Rotation

Best practices for key rotation:

1. Generate new keys regularly
2. Update credentials without downtime:

```bash
# Update client key list - proxy reloads automatically
jq '.keys = ["cnp_live_new_key"]' \
  credentials/train-client-keys/your-train-id.client-keys.json \
  > credentials/train-client-keys/your-train-id.client-keys.json.tmp
mv credentials/train-client-keys/your-train-id.client-keys.json.tmp \
   credentials/train-client-keys/your-train-id.client-keys.json
```

3. Monitor old key usage before removal

## Data Protection

### Sensitive Data Masking

Debug logs automatically mask:

- API keys: `sk-ant-****`
- Bearer tokens: `Bearer ****`
- OAuth tokens: `token-****`

### Request/Response Storage

When `STORAGE_ENABLED=true`:

- Request bodies are stored in PostgreSQL
- Consider encrypting sensitive fields
- Implement data retention policies

### Database Security

```sql
-- Restrict database access
REVOKE ALL ON DATABASE claude_nexus FROM PUBLIC;
GRANT CONNECT ON DATABASE claude_nexus TO proxy_user;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES TO proxy_user;

-- Use SSL connections
DATABASE_URL=postgresql://user:pass@host:5432/db?sslmode=require
```

## Network Security

### TLS/SSL Configuration

1. **Proxy Behind Load Balancer**:

```nginx
upstream proxy {
    server localhost:3000;
}

server {
    listen 443 ssl;
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://proxy;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

2. **Direct TLS** (using a reverse proxy):

- Terminate TLS at nginx/caddy
- Keep proxy on localhost only

### IP Whitelisting

Restrict access by IP:

```nginx
location / {
    allow 10.0.0.0/8;
    allow 192.168.1.0/24;
    deny all;
    proxy_pass http://proxy;
}
```

## Audit and Monitoring

### Access Logging

The proxy logs all requests with:

- Timestamp
- Train ID
- Request ID
- IP address
- Response status

### Security Monitoring

1. **Failed Authentication Attempts**:

```sql
SELECT COUNT(*), ip_address, train_id
FROM api_requests
WHERE response_status = 401
GROUP BY ip_address, train_id
HAVING COUNT(*) > 10;
```

2. **Unusual Usage Patterns**:

```sql
-- Detect token usage spikes
SELECT train_id, DATE(timestamp), SUM(total_tokens)
FROM api_requests
GROUP BY train_id, DATE(timestamp)
HAVING SUM(total_tokens) > average_daily_usage * 2;
```

3. **Slack Alerts**:

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/...
```

## Security Checklist

### Pre-Deployment

- [ ] Generate strong client API keys
- [ ] Configure oauth2-proxy for dashboard (MANDATORY for production)
- [ ] Set `DASHBOARD_SSO_HEADERS` and `DASHBOARD_SSO_ALLOWED_DOMAINS`
- [ ] Generate secure `INTERNAL_API_KEY`
- [ ] Configure TLS/SSL
- [ ] Set appropriate file permissions
- [ ] Enable database SSL
- [ ] Review firewall rules
- [ ] Ensure `DASHBOARD_DEV_USER_EMAIL` is NOT set in production

### Post-Deployment

- [ ] Monitor authentication failures
- [ ] Set up log aggregation
- [ ] Configure alerts for anomalies
- [ ] Regular credential rotation
- [ ] Database backup encryption
- [ ] Security audit schedule

## Common Vulnerabilities

### 1. Exposed Dashboard (CRITICAL)

**Risk**: Dashboard accessible without proper authentication exposes ALL conversation data

**⚠️ CRITICAL SECURITY WARNING**:
The dashboard requires mandatory user authentication via oauth2-proxy headers. Without oauth2-proxy properly configured in production, the dashboard will not function correctly and may expose sensitive data.

**Impact**: Complete data exposure, privacy breach, potential compliance violations

**Mitigation**:

- **ALWAYS** deploy oauth2-proxy in production environments
- Configure `DASHBOARD_SSO_HEADERS` and `DASHBOARD_SSO_ALLOWED_DOMAINS`
- Set secure `INTERNAL_API_KEY` for service-to-service communication
- Restrict dashboard to internal network with proper SSO authentication
- Never expose dashboard port (3001) directly to the internet
- Never set `DASHBOARD_DEV_USER_EMAIL` in production (development only)

**Checking for Vulnerability**:

```bash
# Verify production configuration is set
echo $DASHBOARD_SSO_HEADERS
echo $DASHBOARD_SSO_ALLOWED_DOMAINS
echo $INTERNAL_API_KEY

# Ensure dev bypass is NOT set in production
echo $DASHBOARD_DEV_USER_EMAIL  # Should be empty in production

# Check if dashboard requires authentication
curl http://your-server:3001/dashboard
# Should be protected by oauth2-proxy, not directly accessible
```

### 2. Credential Leakage

**Risk**: Credentials in logs or error messages

**Mitigation**:

- Enable log masking
- Review error handling
- Avoid logging request bodies

### 3. Database Injection

**Risk**: SQL injection through user input

**Mitigation**:

- Proxy uses parameterized queries
- No user input in SQL construction
- Regular dependency updates

## Incident Response

### Suspected Breach

1. **Immediate Actions**:

```bash
# Rotate all keys
bun run auth:generate-key

# Check access logs
SELECT * FROM api_requests
WHERE timestamp > 'suspected_breach_time'
ORDER BY timestamp;
```

2. **Investigation**:

- Review authentication logs
- Check for unusual patterns
- Analyze token usage

3. **Recovery**:

- Rotate all credentials
- Update client configurations
- Monitor for continued activity

## Security Updates

Stay informed about security updates:

1. Watch the repository for security advisories
2. Update dependencies regularly:

```bash
bun update
```

3. Monitor Claude API security announcements

## Compliance

For regulatory compliance:

1. **Data Residency** - Deploy in appropriate regions
2. **Audit Trails** - Enable comprehensive logging
3. **Encryption** - Use TLS and encrypt at rest
4. **Access Control** - Implement principle of least privilege
5. **Data Retention** - Configure appropriate retention policies
