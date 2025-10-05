#!/usr/bin/env bash
set -euo pipefail

# Colors for minimal readable logs
GREEN="\033[0;32m"; YELLOW="\033[0;33m"; RED="\033[0;31m"; NC="\033[0m"
log() { echo -e "${GREEN}[all-in]${NC} $*"; }
warn() { echo -e "${YELLOW}[all-in] WARN:${NC} $*" >&2; }
err() { echo -e "${RED}[all-in] ERROR:${NC} $*" >&2; }

# Defaults
: "${PGDATA:=/var/lib/postgresql/data}"
: "${DB_NAME:=agent_prompttrain}"
: "${DB_USER:=postgres}"
: "${DB_PASSWORD:=postgres}"
: "${PGPORT:=5432}"
: "${PORT:=3000}"
: "${HOST:=0.0.0.0}"
: "${DASHBOARD_PORT:=3001}"
: "${PROXY_API_URL:=http://localhost:3000}"
: "${CREDENTIALS_DIR:=/app/credentials}"

export DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@localhost:${PGPORT}/${DB_NAME}"
export STORAGE_ENABLED="${STORAGE_ENABLED:-true}"
export ENABLE_CLIENT_AUTH="${ENABLE_CLIENT_AUTH:-false}"
export CREDENTIALS_DIR

# Let the official postgres entrypoint handle DB init via /docker-entrypoint-initdb.d
# We only need to start postgres in background using its entrypoint if not already running.

# Start postgres using the official entrypoint script in the background
log "Starting PostgreSQL via official entrypoint..."
POSTGRES_ENV=(
  -e POSTGRES_USER="${DB_USER}"
  -e POSTGRES_PASSWORD="${DB_PASSWORD}"
  -e POSTGRES_DB="${DB_NAME}"
)

# If PGDATA is empty, the official entrypoint will initialize and run scripts in /docker-entrypoint-initdb.d
# Run postgres in background
su-exec postgres /usr/local/bin/docker-entrypoint.sh postgres -p "${PGPORT}" -h 127.0.0.1 &
PG_PID=$!

# Wait for port to be ready
for i in $(seq 1 60); do
  if pg_isready -h 127.0.0.1 -p "${PGPORT}" -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if ! kill -0 "$PG_PID" 2>/dev/null; then
    err "PostgreSQL process exited early"
    exit 1
  fi
  [ $i -eq 60 ] && { err "PostgreSQL did not become ready in time"; exit 1; }
done

# Start Proxy
log "Starting Proxy on ${HOST}:${PORT}..."
BUN_PROXY_CMD=(bun services/proxy/dist/index.js)
BUN_DASHBOARD_CMD=(bun services/dashboard/dist/index.js)

# Prepare per-process ports to avoid clobbering
: "${PROXY_PORT:=${PORT:-3000}}"

# Start services in background with per-process env
PORT="${PROXY_PORT}" HOST="${HOST}" STORAGE_ENABLED="${STORAGE_ENABLED}" ENABLE_CLIENT_AUTH="${ENABLE_CLIENT_AUTH}" CREDENTIALS_DIR="${CREDENTIALS_DIR}" DATABASE_URL="${DATABASE_URL}" \
  "${BUN_PROXY_CMD[@]}" & PROXY_PID=$!
log "Proxy PID=${PROXY_PID}"

PORT="${DASHBOARD_PORT}" HOST="${HOST}" PROXY_API_URL="${PROXY_API_URL}" DATABASE_URL="${DATABASE_URL}" \
  "${BUN_DASHBOARD_CMD[@]}" & DASH_PID=$!
log "Dashboard PID=${DASH_PID}"

# Graceful shutdown
term_handler() {
  warn "Shutting down..."
  kill -TERM "$DASH_PID" 2>/dev/null || true
  kill -TERM "$PROXY_PID" 2>/dev/null || true
  su-exec postgres pg_ctl -D "$PGDATA" -w stop >/dev/null || true
}
trap term_handler TERM INT

# Wait on children
wait -n "$PROXY_PID" "$DASH_PID" || true
term_handler
wait || true
