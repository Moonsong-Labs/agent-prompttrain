# Backup and Recovery Guide

Protect your Agent PromptTrain data with comprehensive backup and disaster recovery procedures.

## Overview

Critical data to backup:

- PostgreSQL database (requests, responses, conversations)
- Credential files (API keys, OAuth tokens)
- Configuration files (.env, custom configs)
- Docker volumes (if using Docker)

## Backup Strategies

### Database Backups

#### Manual Backup

```bash
# Direct PostgreSQL backup
pg_dump -h localhost -U postgres -d claude_nexus > backup-$(date +%Y%m%d-%H%M%S).sql

# Docker environment backup
docker compose exec -T postgres pg_dump -U postgres claude_nexus > backup-$(date +%Y%m%d-%H%M%S).sql

# Compressed backup
docker compose exec -T postgres pg_dump -U postgres claude_nexus | gzip > backup-$(date +%Y%m%d-%H%M%S).sql.gz
```

#### Automated Daily Backups

Create backup script:

```bash
#!/bin/bash
# /scripts/backup-daily.sh

BACKUP_DIR="/backups/daily"
RETENTION_DAYS=7
DB_NAME="claude_nexus"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Create backup directory
mkdir -p $BACKUP_DIR

# Backup database
echo "Starting database backup..."
pg_dump -h localhost -U postgres -d $DB_NAME | gzip > $BACKUP_DIR/db-$TIMESTAMP.sql.gz

# Backup credentials
echo "Backing up credentials..."
tar -czf $BACKUP_DIR/credentials-$TIMESTAMP.tar.gz ./credentials/

# Backup configuration
echo "Backing up configuration..."
cp .env $BACKUP_DIR/env-$TIMESTAMP

# Remove old backups
echo "Cleaning up old backups..."
find $BACKUP_DIR -type f -mtime +$RETENTION_DAYS -delete

echo "Backup completed: $BACKUP_DIR/*-$TIMESTAMP.*"
```

Schedule with cron:

```bash
# Add to crontab
0 2 * * * /path/to/scripts/backup-daily.sh >> /var/log/claude-backup.log 2>&1
```

#### Continuous Archiving (WAL)

For point-in-time recovery:

```bash
# postgresql.conf
archive_mode = on
archive_command = 'cp %p /backup/wal/%f'
wal_level = replica
```

### Credential Backups

#### Secure Credential Backup

```bash
#!/bin/bash
# Encrypt credentials before backup
BACKUP_FILE="credentials-backup-$(date +%Y%m%d).tar.gz.enc"

# Create encrypted backup
tar -czf - credentials/ | openssl enc -aes-256-cbc -salt -out $BACKUP_FILE

# Store encryption key separately
echo "Backup created: $BACKUP_FILE"
echo "Store encryption password securely!"
```

#### Version Control for Credentials

```bash
# Initialize git repo for credentials (local only)
cd credentials/
git init
echo "*.credentials.json" > .gitignore
git add .gitignore
git commit -m "Initial commit"

# Track changes
git add -A
git commit -m "Updated credentials $(date)"
```

### Configuration Backups

```bash
#!/bin/bash
# Backup all configuration files
CONFIG_BACKUP_DIR="/backups/config"
mkdir -p $CONFIG_BACKUP_DIR

# Backup files
cp .env $CONFIG_BACKUP_DIR/.env.$(date +%Y%m%d)
cp docker-compose.yml $CONFIG_BACKUP_DIR/
cp -r scripts/ $CONFIG_BACKUP_DIR/

# Create manifest
cat > $CONFIG_BACKUP_DIR/manifest.txt << EOF
Backup Date: $(date)
Environment: $(hostname)
Services: proxy, dashboard
EOF
```

## Backup Storage

### Local Storage

```bash
# Dedicated backup directory structure
/backups/
├── daily/           # Daily automated backups
├── weekly/          # Weekly full backups
├── monthly/         # Monthly archives
├── credentials/     # Encrypted credential backups
└── config/         # Configuration backups
```

### Remote Storage

#### S3 Backup

```bash
#!/bin/bash
# Upload to S3
aws s3 cp $BACKUP_FILE s3://your-bucket/agent-prompttrain/backups/
aws s3 ls s3://your-bucket/agent-prompttrain/backups/
```

#### rsync to Remote Server

```bash
# Sync backups to remote server
rsync -avz --delete /backups/ user@backup-server:/remote/backups/agent-prompttrain/
```

## Recovery Procedures

### Database Recovery

#### Full Recovery

```bash
# Stop services
docker compose down

# Drop and recreate database
docker compose exec postgres dropdb -U postgres claude_nexus
docker compose exec postgres createdb -U postgres claude_nexus

# Restore from backup
gunzip -c backup-20240101-020000.sql.gz | docker compose exec -T postgres psql -U postgres claude_nexus

# Restart services
docker compose up -d
```

#### Selective Recovery

```bash
# Extract specific tables
pg_restore -t api_requests -d claude_nexus backup.sql

# Recovery specific time range
psql claude_nexus -c "
  COPY (
    SELECT * FROM api_requests
    WHERE created_at BETWEEN '2024-01-01' AND '2024-01-02'
  ) TO '/tmp/partial_backup.csv' CSV HEADER;
"
```

### Credential Recovery

```bash
# Decrypt credential backup
openssl enc -d -aes-256-cbc -in credentials-backup-20240101.tar.gz.enc | tar -xzf -

# Restore to credentials directory
mv credentials/* /app/credentials/

# Verify permissions
chmod 600 /app/credentials/*.json
```

### Point-in-Time Recovery

```bash
# Using WAL archives
# 1. Restore base backup
psql -U postgres -c "SELECT pg_stop_backup();"
rm -rf /var/lib/postgresql/data/*
tar -xzf base-backup.tar.gz -C /var/lib/postgresql/data/

# 2. Configure recovery
cat > /var/lib/postgresql/data/recovery.conf << EOF
restore_command = 'cp /backup/wal/%f %p'
recovery_target_time = '2024-01-15 14:30:00'
recovery_target_action = 'promote'
EOF

# 3. Start PostgreSQL
pg_ctl start
```

## Disaster Recovery Plan

### Recovery Time Objectives

- **RTO** (Recovery Time Objective): 1 hour
- **RPO** (Recovery Point Objective): 24 hours

### DR Procedures

#### 1. Assessment Phase (15 minutes)

```bash
# Check service status
./scripts/health-check.sh

# Identify failure scope
- Database corruption?
- Credential loss?
- Service failure?
- Complete system loss?
```

#### 2. Recovery Decision (5 minutes)

Decision tree:

```
Is database accessible?
├── Yes: Proceed to service recovery
└── No:
    ├── Recent backup available?
    │   ├── Yes: Full database recovery
    │   └── No: Point-in-time recovery
    └── Credentials intact?
        ├── Yes: Continue recovery
        └── No: Restore credentials first
```

#### 3. Recovery Execution (30-40 minutes)

```bash
# Step 1: Stop all services
docker compose down

# Step 2: Restore database
./scripts/restore-database.sh --latest

# Step 3: Restore credentials
./scripts/restore-credentials.sh --encrypted

# Step 4: Verify configuration
./scripts/verify-config.sh

# Step 5: Start services
docker compose up -d

# Step 6: Verify recovery
./scripts/post-recovery-check.sh
```

### Automated Recovery

```bash
#!/bin/bash
# auto-recovery.sh
set -e

echo "Starting automated recovery..."

# Check if manual recovery is needed
if [ -f /tmp/manual-recovery-required ]; then
    echo "Manual intervention required. Exiting."
    exit 1
fi

# Attempt automatic recovery
if ! systemctl is-active --quiet postgresql; then
    echo "PostgreSQL down, attempting restart..."
    systemctl restart postgresql
    sleep 10
fi

if ! curl -f http://localhost:3000/health > /dev/null 2>&1; then
    echo "Proxy unhealthy, restarting..."
    docker compose restart proxy
fi

echo "Recovery attempt completed"
```

## Testing Backups

### Monthly Backup Tests

```bash
#!/bin/bash
# test-recovery.sh

# Create test environment
docker compose -f docker-compose.test.yml up -d

# Restore latest backup
LATEST_BACKUP=$(ls -t /backups/daily/db-*.sql.gz | head -1)
gunzip -c $LATEST_BACKUP | docker compose -f docker-compose.test.yml exec -T postgres psql -U postgres claude_nexus_test

# Verify data integrity
docker compose -f docker-compose.test.yml exec postgres psql -U postgres claude_nexus_test -c "
  SELECT COUNT(*) as request_count,
         MAX(created_at) as latest_request
  FROM api_requests;
"

# Cleanup
docker compose -f docker-compose.test.yml down -v
```

### Recovery Drills

Schedule quarterly drills:

1. **Scenario 1**: Database corruption
2. **Scenario 2**: Credential loss
3. **Scenario 3**: Complete system failure
4. **Scenario 4**: Partial data loss

## Backup Monitoring

### Backup Verification

```sql
-- Track backup history
CREATE TABLE backup_history (
    id SERIAL PRIMARY KEY,
    backup_type VARCHAR(50),
    backup_path TEXT,
    size_bytes BIGINT,
    duration_seconds INTEGER,
    status VARCHAR(20),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Check recent backups
SELECT
    backup_type,
    COUNT(*) as count,
    MAX(created_at) as latest,
    AVG(duration_seconds) as avg_duration
FROM backup_history
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY backup_type;
```

### Alerts

```bash
# Alert on backup failure
if ! ./scripts/backup-daily.sh; then
    curl -X POST $SLACK_WEBHOOK_URL \
        -H 'Content-type: application/json' \
        -d '{"text":"⚠️ Agent PromptTrain backup failed!"}'
fi

# Alert on old backups
LATEST_BACKUP_AGE=$(find /backups/daily -name "db-*.sql.gz" -mtime -1 | wc -l)
if [ $LATEST_BACKUP_AGE -eq 0 ]; then
    echo "WARNING: No recent backups found!"
fi
```

## Best Practices

1. **3-2-1 Rule**
   - 3 copies of data
   - 2 different storage media
   - 1 offsite backup

2. **Regular Testing**
   - Test recovery monthly
   - Document recovery times
   - Update procedures based on tests

3. **Security**
   - Encrypt sensitive backups
   - Restrict backup access
   - Audit backup access logs

4. **Documentation**
   - Keep recovery runbooks updated
   - Document environment-specific details
   - Train team on procedures

## Recovery Checklist

- [ ] Identify failure type and scope
- [ ] Notify stakeholders
- [ ] Locate appropriate backups
- [ ] Prepare recovery environment
- [ ] Execute recovery procedure
- [ ] Verify data integrity
- [ ] Test service functionality
- [ ] Update documentation
- [ ] Conduct post-mortem

## Next Steps

- [Review security practices](./security.md)
- [Set up monitoring](./monitoring.md)
- [Configure high availability](./deployment/docker-compose.md)
- [Plan capacity](../04-Architecture/internals.md)
