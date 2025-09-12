# Domain Credentials

This directory contains credential files for domain-specific authentication.

## File Format

Each domain should have its own credential file named `<domain>.credentials.json`.

Example: `example.com.credentials.json`

### Wildcard Credentials

You can create wildcard credential files to match multiple subdomains:

- `_wildcard.example.com.credentials.json` - Matches all subdomains of example.com
- `_wildcard.staging.example.com.credentials.json` - Matches all subdomains of staging.example.com

**Note**: Exact matches always take precedence over wildcards. Enable with `CNP_WILDCARD_CREDENTIALS=true`.

## Credential Structure

```json
{
  "type": "api_key" | "oauth",
  "accountId": "acc_unique_id",       // Unique account identifier
  "api_key": "sk-ant-...",           // For type: api_key
  "oauth": { ... },                  // For type: oauth
  "client_api_key": "cnp_live_...",  // Required for proxy authentication
  "slack": {                         // Optional Slack configuration
    "webhook_url": "https://...",
    "channel": "#alerts",
    "enabled": true
  }
}
```

## Security Features

### Client API Key Authentication

Each domain can have its own `client_api_key` that clients must provide to access the proxy. This adds an extra layer of security on top of the Claude API authentication.

To generate a secure API key:

```bash
bun run ../scripts/generate-api-key.ts
```

### How It Works

1. Clients must send the domain's API key in the `Authorization` header:
   ```
   Authorization: Bearer cnp_live_YOUR-API-KEY
   ```

2. The proxy verifies this key before forwarding requests to Claude API

3. If no `client_api_key` is configured for a domain, authentication is bypassed (unless disabled via `ENABLE_CLIENT_AUTH=false`)

## Security Best Practices

- Generate strong, random API keys using the provided script
- Store credential files securely with restricted permissions
- Rotate API keys regularly
- Never commit real credentials to version control
- Use environment-specific credential directories

## Example Setup

1. Generate a client API key:
   ```bash
   bun run ../scripts/generate-api-key.ts
   ```

2. Create credential file for your domain:
   ```bash
   cp example.com.credentials.json yourdomain.com.credentials.json
   ```

3. Edit the file and add:
   - Your Claude API key or OAuth credentials
   - The generated client API key
   - Optional Slack configuration

4. Test the authentication:
   ```bash
   curl -H "Authorization: Bearer YOUR-CLIENT-API-KEY" \
        -H "Content-Type: application/json" \
        -d '{"model":"claude-3-opus-20240229","messages":[{"role":"user","content":"Hello"}]}' \
        https://yourdomain.com/v1/messages
   ```