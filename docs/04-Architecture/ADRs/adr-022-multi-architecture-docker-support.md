# ADR-022: Multi-Architecture Docker Support

## Status

Accepted

## Context

The Agent PromptTrain needs to support both x86_64 (amd64) and ARM64 architectures to accommodate:

- Apple Silicon Macs (M1/M2/M3)
- ARM-based cloud instances (AWS Graviton, etc.)
- Raspberry Pi and other ARM devices
- Traditional Intel/AMD servers and workstations

## Decision

We will implement multi-architecture Docker builds using Docker buildx, supporting both linux/amd64 and linux/arm64 platforms.

### Implementation Details

1. **Build Infrastructure**: Use Docker buildx with docker-container driver
2. **CI/CD**: Enable QEMU emulation in GitHub Actions for cross-platform builds
3. **Base Images**: Leverage multi-arch base images (oven/bun:alpine, postgres:16-alpine)
4. **Build Optimization**: Use BUILDPLATFORM for builder stages to avoid QEMU overhead
5. **Local Development**: Maintain backward compatibility with standard docker build

## Consequences

### Positive

- **Broader compatibility**: Native performance on ARM64 devices
- **Improved developer experience**: Apple Silicon users get native containers
- **Cost optimization**: Can leverage cheaper ARM cloud instances
- **Future-proof**: ARM adoption is increasing in server environments

### Negative

- **Build time**: Cross-platform builds via QEMU are slower
- **CI complexity**: Requires QEMU setup and buildx configuration
- **Cache management**: Multi-arch builds need separate cache layers

### Mitigation

- Use GitHub Actions cache (type=gha) to offset QEMU slowness
- Consider native ARM runners for faster builds in future
- Default to current platform for local development

## Technical Approach

### Dockerfiles

```dockerfile
# Use BUILDPLATFORM for builder stages (native speed)
FROM --platform=$BUILDPLATFORM oven/bun:alpine AS builder

# Declare architecture variables for runtime
ARG TARGETARCH
ARG TARGETPLATFORM
```

### Build Scripts

```bash
# Support platform selection via environment
BUILD_PLATFORMS="${BUILD_PLATFORMS:-linux/amd64,linux/arm64}"
docker buildx build --platform $PLATFORMS ...
```

### CI/CD Pipeline

```yaml
- uses: docker/setup-qemu-action@v3
- uses: docker/setup-buildx-action@v3
- uses: docker/build-push-action@v5
  with:
    platforms: linux/amd64,linux/arm64
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

## References

- Docker buildx documentation: https://docs.docker.com/buildx/
- QEMU user emulation: https://www.qemu.org/docs/master/user/index.html
- GitHub Actions Docker build: https://github.com/docker/build-push-action
