#!/bin/bash
# Convenience script to run docker compose from the docker directory

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Check if .env file exists
if [ ! -f "$SCRIPT_DIR/.env" ]; then
    echo "Warning: .env file not found in project root!"
    echo "Please create it first:"
    echo "  cp .env.example .env"
    echo "  nano .env  # Add your API keys"
    echo ""
fi

# Run docker compose from the docker directory, but use the .env file from project root
cd "$SCRIPT_DIR/docker" && docker compose --project-name agent-prompttrain-local --env-file "$SCRIPT_DIR/.env" "$@"