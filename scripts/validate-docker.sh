#!/usr/bin/env bash
# Docker Validation Script
# Validates that Docker images and docker-compose build correctly
# Can be run locally or in CI

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# Get the script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Change to project root
cd "$PROJECT_ROOT"

# Log file for docker-compose output
COMPOSE_LOG_FILE="$PROJECT_ROOT/docker-compose-logs.txt"

# Cleanup function - always runs on exit
cleanup() {
    local exit_code=$?
    echo ""
    echo -e "${BLUE}Cleaning up...${NC}"

    # Save logs before cleanup
    if docker compose -f docker/docker-compose.yml ps > /dev/null 2>&1; then
        echo -e "${YELLOW}Saving docker-compose logs...${NC}"
        docker compose -f docker/docker-compose.yml logs > "$COMPOSE_LOG_FILE" 2>&1 || true
        echo -e "${GREEN}✓ Logs saved to $COMPOSE_LOG_FILE${NC}"
    fi

    # Teardown compose stack
    docker compose -f docker/docker-compose.yml down --volumes --remove-orphans > /dev/null 2>&1 || true

    if [ $exit_code -eq 0 ]; then
        echo -e "${GREEN}✓ Cleanup complete${NC}"
    else
        echo -e "${YELLOW}⚠ Cleanup complete (validation failed)${NC}"
    fi

    exit $exit_code
}

# Register cleanup trap
trap cleanup EXIT ERR INT TERM

echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}Docker Validation${NC}"
echo -e "${BLUE}======================================${NC}"
echo ""

# Step 1: Check prerequisites
echo -e "${BLUE}[1/8] Checking prerequisites...${NC}"

check_command() {
    if ! command -v "$1" &> /dev/null; then
        echo -e "${RED}✗ Error: $1 is not installed or not in PATH${NC}"
        exit 1
    fi
}

check_command docker
# Check for docker compose (subcommand) support
if ! docker compose version > /dev/null 2>&1; then
    echo -e "${RED}✗ Error: 'docker compose' is not available${NC}"
    echo -e "${YELLOW}Please upgrade Docker to a version that supports the 'compose' subcommand${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Docker and docker compose are available${NC}"

# Check if Docker daemon is running
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}✗ Error: Docker daemon is not running${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Docker daemon is running${NC}"
echo ""

# Step 2: Environment preparation
echo -e "${BLUE}[2/8] Preparing environment...${NC}"

# Copy .env.example to .env if not exists
if [ ! -f "$PROJECT_ROOT/.env" ]; then
    echo -e "${YELLOW}No .env file found, copying from .env.example${NC}"
    cp "$PROJECT_ROOT/.env.example" "$PROJECT_ROOT/.env"
    echo -e "${GREEN}✓ Created .env from .env.example${NC}"
else
    echo -e "${GREEN}✓ .env file exists${NC}"
fi

# Set environment variables for build
export BUILD_PLATFORMS="${BUILD_PLATFORMS:-linux/amd64}"
export BUILD_ACTION="${BUILD_ACTION:-load}"

echo -e "${YELLOW}Build configuration:${NC}"
echo -e "  Platform: ${BUILD_PLATFORMS}"
echo -e "  Action: ${BUILD_ACTION}"
echo ""

# Step 3: Cleanup existing state
echo -e "${BLUE}[3/8] Cleaning up existing Docker state...${NC}"
docker compose -f docker/docker-compose.yml down --volumes --remove-orphans > /dev/null 2>&1 || true
echo -e "${GREEN}✓ Cleaned up existing containers and volumes${NC}"
echo ""

# Step 4: Build images
echo -e "${BLUE}[4/8] Building Docker images...${NC}"
if [ -f "$PROJECT_ROOT/docker/build-images.sh" ]; then
    chmod +x "$PROJECT_ROOT/docker/build-images.sh"
    "$PROJECT_ROOT/docker/build-images.sh"
else
    echo -e "${RED}✗ Error: docker/build-images.sh not found${NC}"
    exit 1
fi

# Verify images exist
echo ""
echo -e "${YELLOW}Verifying images were built...${NC}"
if ! docker images | grep -q "agent-prompttrain-proxy"; then
    echo -e "${RED}✗ Error: proxy image was not built${NC}"
    exit 1
fi
if ! docker images | grep -q "agent-prompttrain-dashboard"; then
    echo -e "${RED}✗ Error: dashboard image was not built${NC}"
    exit 1
fi
echo -e "${GREEN}✓ All required images exist${NC}"
echo ""

# Step 5: Start compose stack
echo -e "${BLUE}[5/8] Starting docker-compose stack...${NC}"
docker compose -f docker/docker-compose.yml up -d

# Wait for containers to be in running state
echo -e "${YELLOW}Waiting for containers to start...${NC}"
max_wait=30
wait_count=0
while [ $wait_count -lt $max_wait ]; do
    running_count=$(docker compose -f docker/docker-compose.yml ps --status running | grep -c "running" || echo "0")
    if [ "$running_count" -ge 2 ]; then
        echo -e "${GREEN}✓ Containers started${NC}"
        break
    fi
    wait_count=$((wait_count + 1))
    echo -e "${YELLOW}  Waiting... ($wait_count/$max_wait)${NC}"
    sleep 1
done

if [ $wait_count -eq $max_wait ]; then
    echo -e "${RED}✗ Error: Containers failed to start within ${max_wait} seconds${NC}"
    docker compose -f docker/docker-compose.yml ps
    exit 1
fi
echo ""

# Step 6: Wait for services to be healthy
echo -e "${BLUE}[6/8] Waiting for services to be healthy...${NC}"

wait_for_health() {
    local url=$1
    local service_name=$2
    local max_retries=30
    local retry_count=0
    local wait_time=2

    echo -e "${YELLOW}Checking $service_name health at $url${NC}"

    while [ $retry_count -lt $max_retries ]; do
        if curl -f -s "$url" > /dev/null 2>&1; then
            echo -e "${GREEN}✓ $service_name is healthy${NC}"
            return 0
        fi

        retry_count=$((retry_count + 1))

        # Exponential backoff with max 10s
        if [ $wait_time -lt 10 ]; then
            wait_time=$((wait_time * 2))
            if [ $wait_time -gt 10 ]; then
                wait_time=10
            fi
        fi

        echo -e "${YELLOW}  Attempt $retry_count/$max_retries - waiting ${wait_time}s...${NC}"
        sleep $wait_time
    done

    echo -e "${RED}✗ $service_name failed to become healthy after $max_retries attempts${NC}"
    return 1
}

# Check PostgreSQL
echo -e "${YELLOW}Checking PostgreSQL...${NC}"
retry_count=0
max_retries=30
while [ $retry_count -lt $max_retries ]; do
    if docker compose -f docker/docker-compose.yml exec -T postgres pg_isready -U postgres > /dev/null 2>&1; then
        echo -e "${GREEN}✓ PostgreSQL is ready${NC}"
        break
    fi
    retry_count=$((retry_count + 1))
    echo -e "${YELLOW}  Attempt $retry_count/$max_retries - waiting 2s...${NC}"
    sleep 2
done

if [ $retry_count -eq $max_retries ]; then
    echo -e "${RED}✗ PostgreSQL failed to become ready${NC}"
    exit 1
fi

# Check Proxy health endpoint
wait_for_health "http://localhost:3000/health" "Proxy service" || exit 1

# Check Dashboard health endpoint
wait_for_health "http://localhost:3001/health" "Dashboard service" || exit 1

echo ""

# Step 7: Basic smoke tests
echo -e "${BLUE}[7/8] Running smoke tests...${NC}"

# Test proxy health endpoint returns 200
if curl -f -s -I "http://localhost:3000/health" | grep -q "200"; then
    echo -e "${GREEN}✓ Proxy /health returns 200${NC}"
else
    echo -e "${RED}✗ Proxy /health did not return 200${NC}"
    exit 1
fi

# Test dashboard health endpoint returns 200
if curl -f -s -I "http://localhost:3001/health" | grep -q "200"; then
    echo -e "${GREEN}✓ Dashboard /health returns 200${NC}"
else
    echo -e "${RED}✗ Dashboard /health did not return 200${NC}"
    exit 1
fi

# Verify expected services are running using docker compose
expected_services=("postgres" "proxy" "dashboard")
for service in "${expected_services[@]}"; do
    if docker compose -f docker/docker-compose.yml ps "$service" --status running | grep -q "$service"; then
        echo -e "${GREEN}✓ Service $service is running${NC}"
    else
        echo -e "${RED}✗ Service $service is not running${NC}"
        docker compose -f docker/docker-compose.yml ps "$service"
        exit 1
    fi
done

echo ""

# Step 8: Summary
echo -e "${BLUE}[8/8] Validation Summary${NC}"
echo -e "${GREEN}======================================${NC}"
echo -e "${GREEN}✓ Docker images built successfully${NC}"
echo -e "${GREEN}✓ docker-compose stack started${NC}"
echo -e "${GREEN}✓ All health checks passed${NC}"
echo -e "${GREEN}✓ Smoke tests passed${NC}"
echo -e "${GREEN}======================================${NC}"
echo ""
echo -e "${GREEN}Docker validation completed successfully!${NC}"
echo ""

# Cleanup will run automatically via trap
