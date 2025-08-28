# AWS Infrastructure Deployment

This guide covers deploying Agent PromptTrain on AWS EC2 infrastructure with support for multiple environments.

## Environment Architecture

Agent PromptTrain supports two primary environments:

- **Production (`prod`)** - Live production services
- **Staging (`staging`)** - Pre-production testing environment

Each environment is isolated and can be managed independently using the `manage-nexus-proxies.sh` script.

## EC2 Instance Setup

### Instance Requirements

- **OS**: Ubuntu 20.04 LTS or later
- **Instance Type**: t3.medium or larger (minimum 2 vCPU, 4GB RAM)
- **Storage**: 20GB+ EBS volume
- **Security Groups**:
  - Inbound: SSH (22), HTTP (3000), Dashboard (3001)
  - Outbound: All traffic (for Claude API access)

### File Structure

Each EC2 instance should have the following structure in the ubuntu user's home directory:

```
/home/ubuntu/
├── .env                          # Environment configuration
├── agent-prompttrain/                 # Git repository
│   └── scripts/ops/              # Operational scripts
├── credentials/                  # Domain credential files
│   ├── domain1.com.credentials.json
│   └── domain2.com.credentials.json
```

### Required AWS Tags

Each EC2 instance must be tagged appropriately:

1. **Name Tag** (Required)
   - Must contain "Nexus Proxy" (case-insensitive)
   - Example: `"Nexus Proxy Production Server 1"`

2. **env Tag** (Required for environment filtering)
   - Value: `prod` or `staging`
   - This tag determines which environment the instance belongs to

### Example Terraform Configuration

```hcl
resource "aws_instance" "nexus_proxy_prod" {
  count         = 3
  ami           = "ami-0c55b159cbfafe1f0" # Ubuntu 20.04
  instance_type = "t3.medium"

  tags = {
    Name = "Nexus Proxy Production ${count.index + 1}"
    env  = "prod"
    Type = "proxy"
  }

  user_data = <<-EOF
    #!/bin/bash
    # Install Docker
    curl -fsSL https://get.docker.com | bash

    # Clone repository
    git clone https://github.com/yourusername/agent-prompttrain.git /home/ubuntu/agent-prompttrain
    chown -R ubuntu:ubuntu /home/ubuntu/agent-prompttrain

    # Create required directories
    mkdir -p /home/ubuntu/credentials
    chown ubuntu:ubuntu /home/ubuntu/credentials

    # Note: .env file should be placed at /home/ubuntu/.env
    # Note: credentials should be placed in /home/ubuntu/credentials/
  EOF
}

resource "aws_instance" "nexus_proxy_staging" {
  count         = 2
  ami           = "ami-0c55b159cbfafe1f0" # Ubuntu 20.04
  instance_type = "t3.small"

  tags = {
    Name = "Nexus Proxy Staging ${count.index + 1}"
    env  = "staging"
    Type = "proxy"
  }

  user_data = "${file("user-data.sh")}"
}
```

## Environment Management

### Using the Management Script

The `manage-nexus-proxies.sh` script provides environment-aware operations:

```bash
# Check status of all servers (both prod and staging)
./scripts/ops/manage-nexus-proxies.sh status

# Update only production servers
./scripts/ops/manage-nexus-proxies.sh --env prod up

# Stop staging servers for maintenance
./scripts/ops/manage-nexus-proxies.sh --env staging down

# Update specific staging server
./scripts/ops/manage-nexus-proxies.sh --env staging up "Nexus Proxy Staging 1"
```

### Environment Isolation

Each environment should have:

1. **Separate Databases**
   - Production: High-availability RDS instance
   - Staging: Smaller RDS instance or containerized PostgreSQL

2. **Separate Credentials**
   - Use different Claude API keys for each environment
   - Store in separate credential files

3. **Separate Monitoring**
   - Different Slack channels for alerts
   - Separate dashboards for metrics

## Deployment Workflow

### 1. Staging Deployment

Deploy to staging first for testing:

```bash
# Update staging servers with new version
./scripts/ops/manage-nexus-proxies.sh --env staging up

# Run tests against staging
curl https://staging-proxy.yourdomain.com/health

# Monitor staging logs
./scripts/ops/manage-nexus-proxies.sh --env staging status
```

### 2. Production Deployment

After staging validation:

```bash
# Rolling update of production servers
for server in $(aws ec2 describe-instances --filters "Name=tag:env,Values=prod" "Name=tag:Name,Values=*Nexus Proxy*" --query "Reservations[].Instances[].Tags[?Key=='Name'].Value" --output text); do
  ./scripts/ops/manage-nexus-proxies.sh --env prod up "$server"
  sleep 30 # Wait between updates
done
```

## Environment-Specific Configuration

### Production Configuration

```bash
# .env.prod
DATABASE_URL=postgresql://prod-rds.aws.com:5432/claude_nexus
STORAGE_ENABLED=true
DEBUG=false
SLACK_WEBHOOK_URL=https://hooks.slack.com/prod-channel
DASHBOARD_CACHE_TTL=300
```

### Staging Configuration

```bash
# .env.staging
DATABASE_URL=postgresql://staging-rds.aws.com:5432/claude_nexus_staging
STORAGE_ENABLED=true
DEBUG=true
SLACK_WEBHOOK_URL=https://hooks.slack.com/staging-channel
DASHBOARD_CACHE_TTL=60
```

## Multi-Region Deployment

For global deployment across regions:

```bash
# Tag instances with region
aws ec2 create-tags --resources i-1234567890abcdef0 --tags Key=env,Value=prod Key=region,Value=us-east-1

# Future enhancement: filter by region
./scripts/ops/manage-nexus-proxies.sh --env prod --region us-east-1 status
```

## Security Considerations

### IAM Roles

Create environment-specific IAM roles:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ec2:DescribeInstances", "ec2:DescribeTags"],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "ec2:ResourceTag/env": ["prod", "staging"]
        }
      }
    }
  ]
}
```

### Network Isolation

- Production: Dedicated VPC with private subnets
- Staging: Separate VPC or isolated subnets
- No cross-environment communication

## Monitoring by Environment

### CloudWatch Metrics

```bash
# Create environment-specific dashboards
aws cloudwatch put-dashboard \
  --dashboard-name "ClaudeNexusProxy-Production" \
  --dashboard-body file://dashboards/prod-dashboard.json

aws cloudwatch put-dashboard \
  --dashboard-name "ClaudeNexusProxy-Staging" \
  --dashboard-body file://dashboards/staging-dashboard.json
```

### Alerts

Configure environment-specific alerts:

- **Production**: PagerDuty integration for critical alerts
- **Staging**: Email notifications only

## Disaster Recovery

### Backup Strategy

- **Production**: Automated daily backups with 30-day retention
- **Staging**: Weekly backups with 7-day retention

### Failover

```bash
# Quick failover to backup region
./scripts/ops/manage-nexus-proxies.sh --env prod --region us-west-2 up
```

## Cost Optimization

### Environment-Specific Scaling

- **Production**: Auto-scaling based on load
- **Staging**: Fixed smaller instance count

### Resource Tagging

```bash
# Tag all resources for cost tracking
aws ec2 create-tags --resources $INSTANCE_ID --tags \
  Key=Project,Value=ClaudeNexusProxy \
  Key=Environment,Value=prod \
  Key=CostCenter,Value=Engineering
```

## Compliance

### Environment Separation

- Ensure prod/staging data never mix
- Separate access controls per environment
- Audit logs for each environment

### Data Residency

- Production: Data stays in primary region
- Staging: Can use development regions

## Next Steps

- [Configure monitoring](../monitoring.md)
- [Set up CI/CD pipelines](../../04-Architecture/ADRs/adr-008-cicd-strategy.md)
- [Review security best practices](../security.md)
