# Agent Prompt Train All-in-One Demo Image
# Runs PostgreSQL, Proxy, and Dashboard in a single container

# ===== Builder Stage =====
# Use BUILDPLATFORM to run builder on native architecture for speed
FROM --platform=$BUILDPLATFORM oven/bun:alpine AS builder

WORKDIR /app

# Copy entire monorepo
COPY . .

# Install all dependencies
RUN bun install

# Build production bundles for both services
ENV DOCKER_BUILD=true
RUN bun run build:production

# Install only runtime deps for each service into dist folders
RUN cd services/proxy/dist && bun install --production
RUN cd services/dashboard/dist && bun install --production

# ===== Runtime Stage =====
FROM postgres:16-alpine AS runtime

# Declare build arguments for architecture detection
ARG TARGETARCH
ARG TARGETPLATFORM

# Install utilities and Bun (architecture-aware)
RUN apk add --no-cache bash curl su-exec tini ca-certificates && \
    # The Bun install script automatically detects architecture
    # It maps: linux/amd64 -> x64, linux/arm64 -> aarch64
    curl -fsSL https://bun.sh/install | bash && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun && \
    # Verify Bun installation
    bun --version

# Environment defaults (can be overridden at run time)
# Postgres
ENV PGDATA=/var/lib/postgresql/data \
    DB_NAME=agent_prompttrain \
    DB_USER=postgres \
    DB_PASSWORD=postgres \
    PGPORT=5432 \
    POSTGRES_DB=agent_prompttrain \
    POSTGRES_USER=postgres \
    POSTGRES_PASSWORD=postgres

# Proxy
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    STORAGE_ENABLED=true \
    ENABLE_CLIENT_AUTH=false \
    CREDENTIALS_DIR=/app/credentials

# Dashboard
ENV DASHBOARD_PORT=3001 \
    PROXY_API_URL=http://localhost:3000

WORKDIR /app

# Create directories for runtime
RUN mkdir -p \
    services/proxy/dist \
    services/dashboard/dist \
    scripts \
    client-setup \
    credentials

# Copy only necessary files from builder
COPY --from=builder /app/services/proxy/dist ./services/proxy/dist
COPY --from=builder /app/services/dashboard/dist ./services/dashboard/dist
COPY --from=builder /app/scripts/init-database.sql ./scripts/init-database.sql
# Also place init SQL into Postgres init directory for first-run bootstrap
COPY --from=builder /app/scripts/init-database.sql /docker-entrypoint-initdb.d/01-init.sql
COPY --from=builder /app/client-setup ./client-setup

# Copy package.json for dependency metadata (not strictly needed at runtime)
COPY --from=builder /app/services/proxy/dist/package.json ./services/proxy/dist/package.json
COPY --from=builder /app/services/dashboard/dist/package.json ./services/dashboard/dist/package.json
COPY --from=builder /app/package.json ./package.json

# Add entrypoint (keeps Postgres in background and runs services)
COPY docker/all-in/all-in-entrypoint.sh /usr/local/bin/all-in-entrypoint.sh
RUN chmod +x /usr/local/bin/all-in-entrypoint.sh

# Expose ports for proxy and dashboard
EXPOSE 3000 3001

# Use tini as PID1 for proper signal handling
ENTRYPOINT ["/sbin/tini", "-g", "--"]
CMD ["/usr/local/bin/all-in-entrypoint.sh"]
