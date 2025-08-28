# ADR-002: Separate Docker Images for Each Service

## Status

Accepted

## Context

Given our monorepo structure (ADR-001), we need to decide how to package and deploy our services. The proxy and dashboard services have different requirements, dependencies, and scaling characteristics. We need a deployment strategy that supports independent scaling, security isolation, and optimal image sizes.

## Decision Drivers

- **Security**: Minimize attack surface for each service
- **Scalability**: Services may need different scaling strategies
- **Image Size**: Reduce deployment time and storage costs
- **Maintenance**: Easy to update individual services
- **Resource Usage**: Different services have different resource requirements

## Considered Options

1. **Single Combined Image**
   - Description: One Docker image containing both proxy and dashboard
   - Pros: Simple deployment, single artifact
   - Cons: Large image size, can't scale independently, security concerns

2. **Separate Images with Shared Base**
   - Description: Individual images extending a common base image
   - Pros: Some code reuse, smaller individual images
   - Cons: Base image maintenance overhead, limited benefit with Bun

3. **Completely Separate Images**
   - Description: Independent Docker images for each service
   - Pros: Maximum flexibility, optimal size, independent scaling
   - Cons: Multiple artifacts to manage

## Decision

We will use **completely separate Docker images** for each service:

- `agent-prompttrain-proxy`: Contains only the proxy service
- `agent-prompttrain-dashboard`: Contains only the dashboard service

### Implementation Details

Proxy Dockerfile (`docker/proxy/Dockerfile`):

```dockerfile
FROM oven/bun:1 as builder
WORKDIR /app
COPY package.json bun.lockb ./
COPY packages/shared/package.json ./packages/shared/
COPY services/proxy/package.json ./services/proxy/
RUN bun install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY services/proxy ./services/proxy
RUN cd packages/shared && bun run build
RUN cd services/proxy && bun run build

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=builder /app/services/proxy/dist ./dist
COPY --from=builder /app/services/proxy/package.json ./
RUN bun install --production

EXPOSE 3000
CMD ["bun", "dist/index.js"]
```

Dashboard Dockerfile (`docker/dashboard/Dockerfile`):

```dockerfile
FROM oven/bun:1 as builder
WORKDIR /app
COPY package.json bun.lockb ./
COPY packages/shared/package.json ./packages/shared/
COPY services/dashboard/package.json ./services/dashboard/
RUN bun install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY services/dashboard ./services/dashboard
RUN cd packages/shared && bun run build
RUN cd services/dashboard && bun run build

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=builder /app/services/dashboard/dist ./dist
COPY --from=builder /app/services/dashboard/public ./public
COPY --from=builder /app/services/dashboard/package.json ./
RUN bun install --production

EXPOSE 3001
CMD ["bun", "dist/index.js"]
```

## Consequences

### Positive

- **Optimal Size**: Each image contains only necessary code and dependencies
- **Independent Scaling**: Can run multiple proxy instances with one dashboard
- **Security Isolation**: Compromised dashboard can't access proxy credentials
- **Faster Deployments**: Smaller images mean faster pulls and starts
- **Clear Boundaries**: Forces proper service separation
- **Multi-Architecture Support**: Images support both linux/amd64 and linux/arm64 (see ADR-022)

### Negative

- **Multiple Builds**: Need to build and maintain multiple Docker images
- **Registry Management**: More images to tag and push
- **Orchestration Complexity**: Need to coordinate multiple containers

### Risks and Mitigations

- **Risk**: Version mismatch between services
  - **Mitigation**: Use semantic versioning and coordinate releases

- **Risk**: Increased operational complexity
  - **Mitigation**: Use Docker Compose for local development, Kubernetes for production

- **Risk**: Duplicate build steps
  - **Mitigation**: Use build scripts to automate common tasks

## Links

- [ADR-001: Monorepo Structure](./adr-001-monorepo-structure.md)
- [Docker Best Practices](https://docs.docker.com/develop/dev-best-practices/)
- [Deployment Guide](../../03-Operations/deployment/docker.md)

## Notes

This approach aligns with microservices best practices and allows us to optimize each service independently. The additional complexity is manageable with proper tooling and actually reduces operational risks by isolating failures.

---

Date: 2024-01-20
Authors: Development Team
