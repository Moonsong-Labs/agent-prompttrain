# Credentials Directory

The proxy now separates **accounts** (Anthropic credential sources) from **trains** (analytics & client access identifiers).

```
credentials/
├── accounts/                # Anthropic account credentials
│   ├── account-primary.credentials.json
│   └── account-secondary.credentials.json
└── train-client-keys/       # Proxy client API keys per train
    ├── train-alpha.client-keys.json
    └── train-beta.client-keys.json
```

## Account Credential Files

Account files live under `credentials/accounts/` and are named `<account-name>.credentials.json`.

```json
{
  "type": "api_key",              // or "oauth"
  "accountId": "acc_team_alpha",
  "api_key": "sk-ant-...",        // Required when type === "api_key"
  "oauth": {                       // Required when type === "oauth"
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": 1737072000000,
    "scopes": ["user:inference"]
  },
  "slack": {
    "enabled": true,
    "webhook_url": "https://hooks.slack.com/services/..."
  }
}
```

Requests select an account by setting the `MSL-Account` header. When the header is omitted, the proxy deterministically assigns an account based on the train ID and falls back only if the preferred account is unavailable.

## Train Client Keys

Train-level API keys that gate proxy access are stored in `credentials/train-client-keys/<train-id>.client-keys.json`.

```json
{
  "keys": [
    "cnp_live_internal_service",
    "cnp_live_ci_runner"
  ]
}
```

The `client-auth` middleware accepts any token listed in the file for the given train. If no file exists (or the list is empty) the proxy returns `401` unless client authentication is disabled.

## Request Headers

- `MSL-Train-Id`: identifies the project/train for analytics and storage. Configure upstream clients (or the proxy itself) to send this header. `ANTHROPIC_CUSTOM_HEADERS="MSL-Train-Id:my_project"` ensures outgoing Anthropic calls stay tagged.
- `MSL-Account`: optional; selects a specific account credential file. If omitted, the proxy deterministically maps the train to one of the configured accounts.

Neither header is forwarded to Anthropic.

## Quick Setup

1. Create an account credential file:
   ```bash
   mkdir -p credentials/accounts
   cat > credentials/accounts/account-primary.credentials.json <<'JSON'
   {
     "type": "api_key",
     "accountId": "acc_team_alpha",
     "api_key": "sk-ant-your-claude-api-key"
   }
   JSON
   ```

2. Define allowed client tokens for a train:
   ```bash
   mkdir -p credentials/train-client-keys
   cat > credentials/train-client-keys/train-alpha.client-keys.json <<'JSON'
   { "keys": ["cnp_live_team_alpha"] }
   JSON
   ```

3. Tag outbound Anthropic calls:
   ```bash
   export ANTHROPIC_CUSTOM_HEADERS="MSL-Train-Id:train-alpha"
   ```

4. Choose an account per request when needed:
   ```bash
   curl -X POST http://localhost:3000/v1/messages \
     -H "MSL-Train-Id: train-alpha" \
     -H "MSL-Account: account-primary" \
     -H "Authorization: Bearer cnp_live_team_alpha" \
     -H "Content-Type: application/json" \
     -d '{"model":"claude-3-opus-20240229","messages":[{"role":"user","content":"Hello"}]}'
   ```

## Security Tips

- Restrict filesystem permissions: `chmod 600 credentials/**/*.json`
- Keep production secrets out of version control
- Rotate Anthropic keys and client tokens regularly
- Separate credentials per environment (development, staging, production)
