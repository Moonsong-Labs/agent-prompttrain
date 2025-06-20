# Deployment Guide

This guide covers deploying Claude Nexus Proxy to production environments.

## Deployment Options

### 1. Docker (Recommended)

The project provides optimized Docker images for each service.

#### Build Images

```bash
# Build both images
./docker/build-images.sh

# Or build individually
docker build -f docker/proxy/Dockerfile -t claude-nexus-proxy .
docker build -f docker/dashboard/Dockerfile -t claude-nexus-dashboard .
```

#### Run with Docker Compose

```bash
# Create .env file
cp .env.example .env
# Edit .env with production values

# Start services
docker-compose up -d

# View logs
docker-compose logs -f
```

#### Run Standalone Containers

```bash
# Run proxy
docker run -d \
  --name claude-proxy \
  -p 3000:3000 \
  -e DATABASE_URL=$DATABASE_URL \
  -e CLAUDE_API_KEY=$CLAUDE_API_KEY \
  -v $(pwd)/credentials:/app/credentials:ro \
  claude-nexus-proxy

# Run dashboard
docker run -d \
  --name claude-dashboard \
  -p 3001:3001 \
  -e DATABASE_URL=$DATABASE_URL \
  -e DASHBOARD_API_KEY=$DASHBOARD_API_KEY \
  claude-nexus-dashboard
```

### 2. Bare Metal with Bun

#### Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

#### Build for Production

```bash
# Install dependencies
bun install --production

# Build all services
bun run build:production
```

#### Run with Process Manager

Using PM2:

```bash
# Install PM2
npm install -g pm2

# Start services
pm2 start services/proxy/dist/index.js --name proxy
pm2 start services/dashboard/dist/index.js --name dashboard

# Save configuration
pm2 save
pm2 startup
```

Using systemd:

```ini
# /etc/systemd/system/claude-proxy.service
[Unit]
Description=Claude Nexus Proxy
After=network.target postgresql.service

[Service]
Type=simple
User=proxy
WorkingDirectory=/opt/claude-nexus-proxy
Environment="DATABASE_URL=postgresql://..."
ExecStart=/usr/local/bin/bun run services/proxy/dist/index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

### 3. Kubernetes

See `kubernetes/` directory for Helm charts and manifests.

## Production Configuration

### Environment Variables

Create production `.env`:

```bash
# Database (use connection pooling)
DATABASE_URL=postgresql://user:pass@db-host:5432/claude_nexus?pool_max=20

# Authentication
DASHBOARD_API_KEY=$(openssl rand -base64 32)

# Features
STORAGE_ENABLED=true
DEBUG=false

# Performance
DASHBOARD_CACHE_TTL=300
SLOW_QUERY_THRESHOLD_MS=2000

# Monitoring
SLACK_WEBHOOK_URL=https://hooks.slack.com/...
```

### Database Setup

1. **Create Production Database**:

```sql
CREATE DATABASE claude_nexus;
CREATE USER claude_proxy WITH PASSWORD 'secure-password';
GRANT CONNECT ON DATABASE claude_nexus TO claude_proxy;
```

2. **Run Migrations**:

```bash
DATABASE_URL=postgresql://... bun run db:migrate
```

3. **Optimize for Performance**:

```sql
-- Increase shared buffers
ALTER SYSTEM SET shared_buffers = '256MB';

-- Enable query optimization
ALTER SYSTEM SET random_page_cost = 1.1;

-- Reload configuration
SELECT pg_reload_conf();
```

### Reverse Proxy Setup

#### Nginx Configuration

```nginx
upstream proxy_backend {
    server 127.0.0.1:3000;
    keepalive 32;
}

upstream dashboard_backend {
    server 127.0.0.1:3001;
    keepalive 16;
}

# Proxy API
server {
    listen 443 ssl http2;
    server_name api.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://proxy_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # For streaming responses
        proxy_buffering off;
        proxy_cache off;
    }
}

# Dashboard
server {
    listen 443 ssl http2;
    server_name dashboard.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://dashboard_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # SSE endpoint
    location /sse {
        proxy_pass http://dashboard_backend/sse;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
    }
}
```

#### Caddy Configuration

```caddyfile
api.yourdomain.com {
    reverse_proxy localhost:3000 {
        flush_interval -1
    }
}

dashboard.yourdomain.com {
    reverse_proxy localhost:3001
}
```

## Scaling

### Horizontal Scaling

1. **Proxy Service** - Stateless, scale freely:

```bash
# Docker Swarm
docker service scale proxy=5

# Kubernetes
kubectl scale deployment proxy --replicas=5
```

2. **Dashboard Service** - Also stateless:

```bash
docker service scale dashboard=3
```

3. **Database** - Use read replicas for dashboard:

```bash
# Primary for writes (proxy)
DATABASE_URL=postgresql://primary:5432/claude_nexus

# Read replica for dashboard
DATABASE_URL=postgresql://replica:5432/claude_nexus
```

### Performance Tuning

1. **Connection Pooling**:

```bash
DATABASE_URL=postgresql://...?pool_max=50&pool_idle_timeout=10000
```

2. **Disable Non-Essential Features**:

```bash
STORAGE_ENABLED=false  # If not needed
DEBUG=false
COLLECT_TEST_SAMPLES=false
```

3. **Optimize Dashboard**:

```bash
DASHBOARD_CACHE_TTL=600  # 10-minute cache
```

## Monitoring

### Health Checks

Both services expose health endpoints:

```bash
# Proxy health
curl http://localhost:3000/health

# Dashboard health
curl http://localhost:3001/health
```

### Metrics Collection

1. **Application Metrics**:

   - Token usage: `/token-stats`
   - Request counts by domain
   - Response times

2. **System Metrics**:

```bash
# Docker stats
docker stats

# Process monitoring
pm2 monit
```

### Logging

1. **Centralized Logging**:

```yaml
# docker-compose.yml
services:
  proxy:
    logging:
      driver: 'json-file'
      options:
        max-size: '10m'
        max-file: '3'
```

2. **Log Aggregation**:

```bash
# Ship to ELK/Loki/etc
docker logs proxy | logstash -f logstash.conf
```

## Security Hardening

### Network Security

1. **Firewall Rules**:

```bash
# Only allow HTTPS
ufw allow 443/tcp
ufw deny 3000/tcp
ufw deny 3001/tcp
```

2. **Internal Network**:

```yaml
# docker-compose.yml
networks:
  internal:
    internal: true
  external:
    internal: false
```

### File Permissions

```bash
# Secure credentials
chmod 700 /opt/claude-nexus-proxy/credentials
chmod 600 /opt/claude-nexus-proxy/credentials/*

# Application files
chown -R proxy:proxy /opt/claude-nexus-proxy
chmod -R 755 /opt/claude-nexus-proxy
```

## Backup and Recovery

### Automated Backups

```bash
# Backup script (add to cron)
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/backups

# Database backup
pg_dump $DATABASE_URL | gzip > $BACKUP_DIR/db_$DATE.sql.gz

# Credentials backup
tar czf $BACKUP_DIR/credentials_$DATE.tar.gz /opt/claude-nexus-proxy/credentials

# Retention (keep 7 days)
find $BACKUP_DIR -name "*.gz" -mtime +7 -delete
```

### Disaster Recovery

1. **Database Recovery**:

```bash
gunzip < backup.sql.gz | psql $DATABASE_URL
```

2. **Service Recovery**:

```bash
# Restore credentials
tar xzf credentials_backup.tar.gz -C /

# Restart services
docker-compose up -d
```

## Maintenance

### Rolling Updates

```bash
# Update proxy without downtime
docker service update --image claude-nexus-proxy:new proxy

# Update dashboard
docker service update --image claude-nexus-dashboard:new dashboard
```

### Database Maintenance

```bash
# Vacuum and analyze
psql $DATABASE_URL -c "VACUUM ANALYZE;"

# Reindex for performance
psql $DATABASE_URL -c "REINDEX DATABASE claude_nexus;"
```

## Troubleshooting Production Issues

### High Memory Usage

```bash
# Check memory usage
docker stats

# Limit container memory
docker run -m 1g claude-nexus-proxy
```

### Slow Queries

```bash
# Enable slow query logging
SLOW_QUERY_THRESHOLD_MS=1000

# Check pg_stat_statements
SELECT query, mean_exec_time, calls
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;
```

### Connection Issues

```bash
# Test database connection
psql $DATABASE_URL -c "SELECT 1;"

# Check proxy logs
docker logs proxy --tail 100

# Verify credentials
ls -la credentials/
```
