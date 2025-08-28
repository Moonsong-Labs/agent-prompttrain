# Agent PromptTrain Service - Production Dockerfile
# Optimized for minimal size and security

# ===== Builder Stage =====
# Use BUILDPLATFORM to run builder on native architecture for speed
FROM --platform=$BUILDPLATFORM oven/bun:alpine AS builder

WORKDIR /app

# Copy entire monorepo
COPY . .

# Install all dependencies
RUN bun install

# Build production bundle
RUN cd services/proxy && bun run build:production

# ===== Runtime Stage =====
FROM oven/bun:alpine AS runtime

# Install runtime dependencies
RUN apk add --no-cache ca-certificates

WORKDIR /app

# Create directories for runtime
RUN mkdir -p credentials services/proxy/dist client-setup && \
    chmod -R 755 /app

# Copy only necessary files from builder
COPY --from=builder /app/services/proxy/dist ./services/proxy/dist
COPY --from=builder /app/client-setup ./client-setup

# Copy package files for dependencies
COPY --from=builder /app/services/proxy/dist/package.json ./services/proxy/dist/
COPY --from=builder /app/package.json ./

# Install only runtime dependencies
RUN cd services/proxy/dist && bun install --production

# Set ownership
RUN chown -R bun:bun /app

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

USER bun

# Expose proxy port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Run the proxy service
CMD ["bun", "services/proxy/dist/index.js"]