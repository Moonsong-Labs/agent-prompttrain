# Docker Compose Deployment

Deploy the complete Agent Prompt Train stack using Docker Compose for a production-ready setup.

## Overview

The Docker Compose configuration includes:

- PostgreSQL database with persistent storage
- Proxy service with auto-restart
- Dashboard service with monitoring
- Optional Claude CLI integration
- Network isolation and security

## Prerequisites

- Docker Engine 20.10+
- Docker Compose v2.0+
- 2GB+ available RAM
- 10GB+ available disk space

## Quick Start

### 1. Clone and Configure

```bash
# Clone the repository
git clone https://github.com/moonsong-labs/agent-prompttrain.git
cd agent-prompttrain

# Copy and edit environment file
cp .env.example .env
nano .env
```

### 2. Create Credentials

```bash
# Create credentials directory
mkdir -p credentials

# Generate client API key
bun run scripts/generate-api-key.ts

# Create train credentials
cat > credentials/your-train-id.credentials.json << EOF
{
  "type": "api_key",
  "accountId": "acc_$(uuidgen)",
  "api_key": "sk-ant-your-claude-api-key",
  "client_api_key": "cnp_live_generated_key"
}
EOF
```

### 3. Start Services

```bash
# Start all services
docker compose up -d

# View logs
docker compose logs -f

# Check service status
docker compose ps
```

## Service Configuration

### docker-compose.yml Structure

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: claude_nexus
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres']
      interval: 10s
      timeout: 5s
      retries: 5

  proxy:
    image: moonsonglabs/agent-prompttrain-proxy:latest
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/claude_nexus
      STORAGE_ENABLED: 'true'
      DEBUG: 'false'
    volumes:
      - ./credentials:/app/credentials:ro
    ports:
      - '3000:3000'
    restart: unless-stopped

  dashboard:
    image: moonsonglabs/agent-prompttrain-dashboard:latest
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/claude_nexus
      DASHBOARD_API_KEY: ${DASHBOARD_API_KEY}
    ports:
      - '3001:3001'
    restart: unless-stopped

volumes:
  postgres_data:
```

## Environment Variables

### Essential Configuration

```bash
# .env file
# Dashboard authentication
DASHBOARD_API_KEY=your-secure-dashboard-key

# Optional configurations
DEBUG=false
STORAGE_ENABLED=true
SLACK_WEBHOOK_URL=https://hooks.slack.com/...
SLOW_QUERY_THRESHOLD_MS=5000
CLAUDE_API_TIMEOUT=600000
PROXY_SERVER_TIMEOUT=660000
```

### Service-Specific Variables

```yaml
# Override per service
proxy:
  environment:
    - NODE_ENV=production
    - LOG_LEVEL=info
    - ENABLE_CLIENT_AUTH=true

dashboard:
  environment:
    - DASHBOARD_CACHE_TTL=30
    - TZ=UTC
```

## Advanced Deployment

### Using Profiles

Deploy different configurations using profiles:

```yaml
services:
  claude-cli:
    profiles: ['cli']
    image: ghcr.io/anthropics/claude-cli:latest
    environment:
      CLAUDE_API_URL: http://proxy:3000
```

```bash
# Start with CLI profile
docker compose --profile cli up -d

# Start only core services
docker compose up -d
```

### Custom Networks

Isolate services with custom networks:

```yaml
networks:
  frontend:
    driver: bridge
  backend:
    driver: bridge
    internal: true

services:
  proxy:
    networks:
      - frontend
      - backend

  postgres:
    networks:
      - backend
```

### Resource Limits

Set memory and CPU limits:

```yaml
services:
  proxy:
    deploy:
      resources:
        limits:
          cpus: '2.0'
          memory: 2G
        reservations:
          cpus: '0.5'
          memory: 512M
```

## Production Considerations

### 1. Database Persistence

Ensure data persistence:

```yaml
volumes:
  postgres_data:
    driver: local
    driver_opts:
      type: none
      device: /data/agent-prompttrain/postgres
      o: bind
```

### 2. Backup Configuration

Add backup service:

```yaml
services:
  backup:
    image: postgres:15
    depends_on:
      - postgres
    volumes:
      - ./backups:/backups
    command: |
      bash -c 'while true; do
        PGPASSWORD=postgres pg_dump -h postgres -U postgres claude_nexus > /backups/backup-$$(date +%Y%m%d-%H%M%S).sql
        sleep 86400
      done'
```

### 3. SSL/TLS Termination

Add reverse proxy for SSL:

```yaml
services:
  nginx:
    image: nginx:alpine
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./certs:/etc/nginx/certs:ro
    depends_on:
      - proxy
      - dashboard
```

### 4. Health Monitoring

Configure health checks:

```yaml
services:
  proxy:
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:3000/health']
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
```

## Scaling

### Horizontal Scaling

Scale proxy instances:

```bash
# Scale to 3 proxy instances
docker compose up -d --scale proxy=3
```

Add load balancer:

```yaml
services:
  haproxy:
    image: haproxy:alpine
    ports:
      - '3000:3000'
    volumes:
      - ./haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro
```

### Database Optimization

```yaml
services:
  postgres:
    command: |
      postgres
      -c max_connections=200
      -c shared_buffers=1GB
      -c effective_cache_size=3GB
      -c maintenance_work_mem=256MB
```

## Maintenance

### Update Services

```bash
# Pull latest images
docker compose pull

# Recreate services with new images
docker compose up -d --force-recreate
```

### View Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f proxy

# Last 100 lines
docker compose logs --tail=100 proxy
```

### Database Maintenance

```bash
# Access database
docker compose exec postgres psql -U postgres claude_nexus

# Run migrations
docker compose exec proxy bun run db:migrate

# Vacuum database
docker compose exec postgres vacuumdb -U postgres -d claude_nexus -z
```

## Troubleshooting

### Services Won't Start

1. Check port conflicts:

   ```bash
   netstat -tlnp | grep -E '3000|3001|5432'
   ```

2. Verify credentials:

   ```bash
   docker compose exec proxy ls -la /app/credentials
   ```

3. Check database connection:
   ```bash
   docker compose exec proxy pg_isready -h postgres
   ```

### Performance Issues

1. Monitor resource usage:

   ```bash
   docker stats
   ```

2. Check database performance:

   ```bash
   docker compose exec postgres pg_top
   ```

3. Review proxy logs:
   ```bash
   docker compose logs proxy | grep -i slow
   ```

### Data Recovery

1. List backups:

   ```bash
   ls -la ./backups/
   ```

2. Restore from backup:
   ```bash
   docker compose exec -T postgres psql -U postgres claude_nexus < ./backups/backup-20240101-120000.sql
   ```

## Security Hardening

### 1. Use Secrets

```yaml
secrets:
  db_password:
    file: ./secrets/db_password.txt
  dashboard_key:
    file: ./secrets/dashboard_key.txt

services:
  postgres:
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets:
      - db_password
```

### 2. Network Policies

```yaml
services:
  postgres:
    networks:
      - backend
    expose:
      - '5432'
    # Remove ports mapping
```

### 3. Read-Only Volumes

```yaml
volumes:
  - ./credentials:/app/credentials:ro
  - ./config:/app/config:ro
```

## Monitoring Integration

### Prometheus Metrics

```yaml
services:
  prometheus:
    image: prom/prometheus
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - '9090:9090'
```

### Grafana Dashboards

```yaml
services:
  grafana:
    image: grafana/grafana
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    ports:
      - '3002:3000'
```

## Helper Scripts

### Start Script

```bash
#!/bin/bash
# docker-up.sh
source .env
docker compose up -d
```

### Backup Script

```bash
#!/bin/bash
# backup.sh
BACKUP_DIR="./backups/$(date +%Y%m%d)"
mkdir -p "$BACKUP_DIR"
docker compose exec -T postgres pg_dump -U postgres claude_nexus > "$BACKUP_DIR/claude_nexus.sql"
tar -czf "$BACKUP_DIR/credentials.tar.gz" ./credentials/
```

## Next Steps

- [Configure monitoring](../monitoring.md)
- [Set up backups](../backup-recovery.md)
- [Review security](../security.md)
- [Optimize performance](../../05-Troubleshooting/performance.md)
