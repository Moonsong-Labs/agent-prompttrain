#!/bin/bash

echo "Starting Agent PromptTrain Development Environment"
echo "=================================================="

# Kill any existing processes on ports 3000 and 3001
echo "Cleaning up existing processes..."
lsof -ti:3000 | xargs -r kill -9 2>/dev/null
lsof -ti:3001 | xargs -r kill -9 2>/dev/null

# Start Proxy Service
echo -e "\nStarting Proxy Service on port 3000..."
cd services/proxy
bun run dev &
PROXY_PID=$!

# Wait for proxy to start
echo "Waiting for proxy to be ready..."
sleep 5

# Test proxy health
echo "Testing proxy health..."
curl -s http://localhost:3000/health | jq . || echo "Proxy health check failed"

# Start Dashboard Service
echo -e "\nStarting Dashboard Service on port 3001..."
cd ../dashboard
PROXY_API_URL=http://localhost:3000 bun run dev &
DASHBOARD_PID=$!

# Wait for dashboard to start
echo "Waiting for dashboard to be ready..."
sleep 5

# Test dashboard health
echo "Testing dashboard health..."
curl -s http://localhost:3001/health | jq . || echo "Dashboard health check failed"

echo -e "\n✅ Services started!"
echo "Proxy PID: $PROXY_PID (http://localhost:3000)"
echo "Dashboard PID: $DASHBOARD_PID (http://localhost:3001)"
echo -e "\nPress Ctrl+C to stop all services"

# Wait for user to stop
trap "kill $PROXY_PID $DASHBOARD_PID 2>/dev/null; echo 'Services stopped'; exit" INT TERM
wait