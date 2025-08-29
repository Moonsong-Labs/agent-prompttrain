# Agent Prompt Train Docker Images

This directory contains the Docker configurations for the Agent Prompt Train project, split into two separate microservices following best practices.

## Images

### 1. Proxy Service (`moonsonglabs/agent-prompttrain-proxy`)

- Port: 3000
- Handles Claude API proxying
- Manages authentication and token tracking
- Stores request/response data

### 2. Dashboard Service (`moonsonglabs/agent-prompttrain-dashboard`)

- Port: 3001
- Web UI for monitoring and analytics
- Real-time SSE updates
- Request history browser

## Multi-Architecture Support

The Docker images support both `linux/amd64` (x86_64) and `linux/arm64` (ARM/Apple Silicon) architectures. Multi-platform builds are handled automatically using Docker buildx.

### Supported Platforms

- `linux/amd64` - Intel/AMD processors
- `linux/arm64` - ARM processors, Apple M1/M2/M3

### Platform-Specific Builds

```bash
# Build for current platform only (default: both architectures)
BUILD_PLATFORMS=linux/amd64 ./build-images.sh

# Build for ARM64 only
BUILD_PLATFORMS=linux/arm64 ./build-images.sh

# Build and push multi-arch to registry
BUILD_ACTION=push ./build-images.sh
```

### Verify Multi-Architecture Images

```bash
# Check manifest for multiple platforms
docker buildx imagetools inspect moonsonglabs/agent-prompttrain-proxy:latest
```

## Building Images

### Quick Build

```bash
# Build both images with 'latest' tag (multi-arch by default)
./build-images.sh

# Build with 'latest' and also tag as 'v9'
./build-images.sh v9

# Build with 'latest' and also tag as '1.2.3'
./build-images.sh 1.2.3

# Show help
./build-images.sh --help
```

### Environment Variables

- `BUILD_PLATFORMS` - Target platforms (default: `linux/amd64,linux/arm64`)
- `BUILD_ACTION` - Set to `push` to push to registry, `load` for local (default: `load`)

### Manual Build

```bash
# Build individually with Docker buildx
docker buildx build --platform linux/amd64,linux/arm64 \
  -f proxy/Dockerfile -t moonsonglabs/agent-prompttrain-proxy:v9 ..

# Single platform build
docker build -f proxy/Dockerfile -t moonsonglabs/agent-prompttrain-proxy:v9 ..
```

## Pushing Images

```bash
# Push images with 'latest' tag
./push-images.sh

# Push specific version (also pushes 'latest')
./push-images.sh v9

# Push version only (skip 'latest')
./push-images.sh v9 no

# Show help
./push-images.sh --help
```

**Note:** You must be logged in to Docker Hub first: `docker login`

## Running Services

### Using Docker Compose (Recommended)

The `docker-compose.yml` file is located in this `docker/` directory.

```bash
# From project root (recommended)
./docker-up.sh up -d

# Or from docker directory
cd docker
docker-compose --project-name agent-prompttrain --env-file ../.env up -d

# Run specific service
./docker-up.sh up proxy
./docker-up.sh up dashboard

# View logs
./docker-up.sh logs -f

# Stop services
./docker-up.sh down
```

### Running Individually

```bash
# Proxy service
docker run -p 3000:3000 \
  -v ./credentials:/app/credentials:ro \
  moonsonglabs/agent-prompttrain-proxy:latest

# Dashboard service
docker run -p 3001:3001 \
  -e DASHBOARD_API_KEY=your-key \
  -e PROXY_API_URL=http://localhost:3000 \
  moonsonglabs/agent-prompttrain-dashboard:latest
```

## Environment Variables

### Proxy Service

- `DATABASE_URL` - PostgreSQL connection
- `STORAGE_ENABLED` - Enable storage (default: false)
- `SLACK_WEBHOOK_URL` - Slack notifications
- `CREDENTIALS_DIR` - Domain credential directory

### Dashboard Service

- `DASHBOARD_API_KEY` - Dashboard authentication
- `PROXY_API_URL` - Proxy API endpoint
- `DATABASE_URL` - PostgreSQL connection (read-only)

## Architecture Benefits

Splitting into separate images provides:

- **Independent scaling** - Scale proxy and dashboard separately
- **Smaller images** - Each service only includes what it needs
- **Better security** - Reduced attack surface
- **Easier maintenance** - Update services independently
- **Resource efficiency** - Run only what you need

## Image Details

Both images use:

- Multi-stage builds for optimization
- Bun runtime for performance
- Alpine Linux base for minimal size
- Health checks for container orchestration
- Non-root user for security

## Versioning Strategy

1. **Development builds:** Use `latest` tag
2. **Release candidates:** Use `rc-X` tags (e.g., `rc-1`, `rc-2`)
3. **Production releases:** Use semantic versioning (e.g., `1.0.0`, `1.2.3`)
4. **Major versions:** Use `vX` tags (e.g., `v9`, `v10`)

When building a version tag, the scripts automatically:

- Build images with the `latest` tag first
- Additionally tag them with the specified version
- Provide instructions for pushing both tags
