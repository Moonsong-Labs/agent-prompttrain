#!/bin/bash
# Load root .env safely
set -a; . ./.env; set +a

# Run the dashboard service on its own port
cd services/dashboard && PORT=${DASHBOARD_PORT:-3001} bun run dev
