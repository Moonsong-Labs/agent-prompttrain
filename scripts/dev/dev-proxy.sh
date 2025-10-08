#!/bin/bash
# Load root .env safely
set -a; . ./.env; set +a

# Run the proxy service on its own port
cd services/proxy && PORT=${PROXY_PORT:-3000} bun run dev 
