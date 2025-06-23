# Claude Nexus Proxy - Quick Start

## Prerequisites

- Docker and Docker Compose
- Claude OAuth token or API key

## Setup

### 1. Clone and configure

```bash
git clone https://github.com/moonsong-labs/claude-nexus-proxy.git
cd claude-nexus-proxy
cp .env.example .env
```

### 2. Create credentials

Create credential files for your domain:

```bash
# For OAuth (Claude Code)
cat > credentials/localhost:3000.credentials.json << 'EOF'
{
  "type": "oauth",
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
cp credentials/localhost:3000.credentials.json client-setup/.credentials.json

# Link for proxy service (avoids duplication)
ln -sf ../client-setup/.credentials.json credentials/proxy:3000.credentials.json
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
- **Dashboard**: http://localhost:3001 (use DASHBOARD_API_KEY from .env)

## Troubleshooting

- **Invalid API key**: Check credentials files are correct
- **Connection issues**: Verify services with `docker compose ps`
- **Disable client auth**: Set `ENABLE_CLIENT_AUTH=false` in docker-compose.override.yml

## Stop services

```bash
cd docker && docker compose down
```
