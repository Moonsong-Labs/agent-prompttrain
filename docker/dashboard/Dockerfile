# Agent Prompt Train Dashboard Service - Production Dockerfile
# Web dashboard for monitoring and analytics

# ===== Builder Stage =====
# Use BUILDPLATFORM to run builder on native architecture for speed
FROM --platform=$BUILDPLATFORM oven/bun:alpine AS builder

WORKDIR /app

# Copy entire monorepo
COPY . .

# Install all dependencies
RUN bun install

# Build production bundle (prompt assets already generated and committed)
RUN cd services/dashboard && DOCKER_BUILD=true bun run build:production

# ===== Runtime Stage =====
FROM oven/bun:alpine AS runtime

# Install runtime dependencies
RUN apk add --no-cache ca-certificates

WORKDIR /app

# Create directories for runtime
RUN mkdir -p services/dashboard/dist && \
    chmod -R 755 /app

# Copy only necessary files from builder
COPY --from=builder /app/services/dashboard/dist ./services/dashboard/dist

# Copy package files for dependencies
COPY --from=builder /app/services/dashboard/dist/package.json ./services/dashboard/dist/
COPY --from=builder /app/package.json ./

# Install only runtime dependencies
RUN cd services/dashboard/dist && bun install --production

# Set ownership
RUN chown -R bun:bun /app

# Set environment
ENV NODE_ENV=production
ENV PORT=3001

USER bun

# Expose dashboard port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Run the dashboard service
CMD ["bun", "services/dashboard/dist/index.js"]