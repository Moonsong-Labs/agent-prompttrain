# Train Credentials

This directory contains credential files keyed by train identifiers. Each credential file is named `<train-id>.credentials.json` so the proxy can look up credentials using the `train-id` header on incoming requests.

## File Format

```json
{
  "type": "api_key" | "oauth",
  "accountId": "acc_unique_id",
  "api_key": "sk-ant-...",          // Required for type: api_key
  "oauth": { ... },                   // Required for type: oauth
  "client_api_key": "cnp_live_...",  // Optional client auth token
  "slack": {                          // Optional Slack configuration
    "enabled": true,
    "webhook_url": "https://hooks.slack.com/..."
  }
}
```

## Usage

1. Generate a client API key (if using proxy auth):
   ```bash
   bun run ../scripts/generate-api-key.ts
   ```

2. Create a new credential file:
   ```bash
   cat > credentials/train-alpha.credentials.json <<'JSON'
   {
     "type": "api_key",
     "accountId": "acc_team_alpha",
     "api_key": "sk-ant-your-claude-api-key",
     "client_api_key": "cnp_live_generated_key"
   }
   JSON
   ```

3. Configure outbound requests to tag the train:
   ```bash
   export ANTHROPIC_CUSTOM_HEADERS="train-id:train-alpha"
   ```

4. Test the proxy:
   ```bash
   curl -X POST http://localhost:3000/v1/messages \
     -H "train-id: train-alpha" \
     -H "Authorization: Bearer cnp_live_generated_key" \
     -H "Content-Type: application/json" \
     -d '{"model":"claude-3-opus-20240229","messages":[{"role":"user","content":"Hello"}]}'
   ```

## Wildcard Credentials (Optional)

You can create wildcard credential files to match multiple train IDs using a prefix:

```bash
cat > credentials/_wildcard.train-beta.credentials.json <<'JSON'
{
  "type": "api_key",
  "accountId": "acc_shared_beta",
  "api_key": "sk-ant-shared",
  "client_api_key": "cnp_live_generated_key"
}
JSON

export CNP_WILDCARD_CREDENTIALS=true
```

Exact matches take precedence over wildcards for safety.

## Security Best Practices

- `chmod 600 credentials/*.json`
- Never commit real credentials to version control
- Rotate API keys regularly
- Keep separate credential files per environment
