# Agent Prompt Train - Quick Start

## Prerequisites

- Docker and Docker Compose
- Claude OAuth token or API key

## Setup

### 1. Clone and configure

```bash
git clone https://github.com/moonsong-labs/agent-prompttrain.git
cd agent-prompttrain
cp .env.example .env

# For development: Set DASHBOARD_DEV_USER_EMAIL for local testing
# For production: Configure oauth2-proxy (see deployment docs)
```

### 2. Create credentials

Create credential files for your project identifier:

```bash
# For OAuth (Claude Code)
cat > credentials/train-alpha.credentials.json << 'EOF'
{
  "type": "oauth",
  "accountId": "acc_unique_identifier",
  "oauth": {
    "accessToken": "sk-ant-oat01-YOUR-TOKEN",
    "refreshToken": "",
    "expiresAt": 1234567890000,
    "scopes": ["user:inference", "user:profile"],
    "isMax": true
  }
}
EOF

# Create single source of credentials
mkdir -p client-setup
cp credentials/train-alpha.credentials.json client-setup/.credentials.json

# Link for proxy service (avoids duplication)
ln -sf ../client-setup/.credentials.json credentials/proxy.credentials.json

# Configure outgoing requests to tag the train ID
echo 'ANTHROPIC_CUSTOM_HEADERS="MSL-Project-Id:train-alpha"' >> .env
```

### 3. Start services

```bash
cd docker
docker compose --profile dev --profile claude up -d
```

### 4. Use Claude CLI

```bash
# From anywhere in the project
./claude "What is 2+2?"

# Or directly
cd docker
docker compose exec claude-cli /usr/local/bin/claude-cli "Hello!"
```

## Monitoring

- **View logs**: `docker compose logs -f proxy`
- **Token stats**: `curl http://localhost:3000/token-stats`
- **Dashboard**: http://localhost:3001 (authentication required - use `DASHBOARD_DEV_USER_EMAIL=dev@localhost` for local development)

## Troubleshooting

- **Invalid API key**: Check credentials files are correct
- **Connection issues**: Verify services with `docker compose ps`
- **Disable client auth**: Set `ENABLE_CLIENT_AUTH=false` in docker-compose.override.yml

## Stop services

```bash
cd docker && docker compose down
```
