# Operations Scripts

This directory contains operational scripts for managing Agent PromptTrain deployments.

## Scripts

### manage-nexus-proxies.sh

Manages Agent PromptTrain Docker containers across all EC2 instances tagged with "Nexus Proxy" in their name.

**Features:**

- Automatically discovers EC2 instances using AWS CLI
- Supports environment-based filtering using AWS tags
- **Automatically pulls latest code before updates** (git pull)
- Executes commands in parallel across multiple servers
- Provides colored output for better visibility

**Usage:**

```bash
./manage-nexus-proxies.sh [--env {prod|staging}] {up|down|status} [server-name]
```

**Commands:**

- `up` - Pull latest code (git pull) and start/update the agent-prompttrain-proxy container
- `down` - Stop the agent-prompttrain-proxy container
- `status` - Check container status

**Options:**

- `--env {prod|staging}` - Filter servers by environment tag (optional)
- `server-name` - Target specific server (optional)

**Examples:**

```bash
# Check status on all servers
./manage-nexus-proxies.sh status

# Start proxy on all production servers
./manage-nexus-proxies.sh --env prod up

# Check status on specific staging server
./manage-nexus-proxies.sh --env staging status server1

# Stop proxy on all staging servers
./manage-nexus-proxies.sh --env staging down
```

**Environment Tags:**
The script filters EC2 instances based on the `env` tag:

- `env=prod` - Production servers (displayed in RED)
- `env=staging` - Staging servers (displayed in YELLOW)
- No tag or unknown value - Displayed as "unknown"

**Requirements:**

- AWS CLI configured with appropriate credentials
- SSH access to EC2 instances as `ubuntu` user
- EC2 instances must have:
  - "Nexus Proxy" in their Name tag
  - Optional `env` tag with value `prod` or `staging`
  - Git repository cloned at `~/agent-prompttrain` on each server
  - Git access configured (for pulling from origin/main)
  - `.env` file located at `~/.env` (in user's home directory)
  - `credentials` directory at `~/credentials` (if using credential files)

### update-proxy.sh

Updates Agent PromptTrain Docker containers to a specific version.

**Usage:**

```bash
./update-proxy.sh <version> [service]
```

**Arguments:**

- `version` - Docker image version (e.g., `v8`, `latest`)
- `service` - Optional: `proxy` or `dashboard` (defaults to both)

**Examples:**

```bash
# Update both services to latest
./update-proxy.sh latest

# Update only proxy to v8
./update-proxy.sh v8 proxy

# Update only dashboard to v9
./update-proxy.sh v9 dashboard
```

## AWS Infrastructure Requirements

For the `manage-nexus-proxies.sh` script to work properly, EC2 instances must be tagged appropriately:

1. **Name Tag** (Required): Must contain "Nexus Proxy" (case-insensitive)
2. **env Tag** (Optional): Should be either "prod" or "staging" for environment filtering

Example AWS tags:

```
Name: "Nexus Proxy Server 1"
env: "prod"
```

## Security Considerations

- The scripts use SSH with `StrictHostKeyChecking=no` for automation
- Ensure AWS CLI credentials have minimal required permissions:
  - `ec2:DescribeInstances` for instance discovery
- SSH keys should be properly secured and rotated regularly
- Consider using AWS Systems Manager Session Manager for enhanced security
