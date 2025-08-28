#!/bin/bash
# Test script to verify dashboard API endpoints

DASHBOARD_URL="http://localhost:3001"
API_KEY="alan"

echo "Testing Agent PromptTrain Dashboard API..."
echo "=================================="

# Test health endpoint (no auth required)
echo -e "\n1. Health Check:"
curl -s "$DASHBOARD_URL/health" | jq '.' 2>/dev/null || echo "Health check failed"

# Test API info endpoint
echo -e "\n2. API Info:"
curl -s "$DASHBOARD_URL/api" | jq '.' 2>/dev/null || echo "API info failed"

# Test requests endpoint
echo -e "\n3. Recent Requests (with auth):"
curl -s -H "X-Dashboard-Key: $API_KEY" "$DASHBOARD_URL/api/requests?limit=5" | jq '.' 2>/dev/null || echo "Requests endpoint failed"

# Test storage stats
echo -e "\n4. Storage Statistics:"
curl -s -H "X-Dashboard-Key: $API_KEY" "$DASHBOARD_URL/api/storage-stats" | jq '.' 2>/dev/null || echo "Stats endpoint failed"

# Test dashboard HTML (should redirect to login without auth)
echo -e "\n5. Dashboard Page (no auth - should redirect):"
curl -s -I "$DASHBOARD_URL/" | grep -E "(HTTP|Location)" || echo "Dashboard redirect failed"

# Test dashboard with auth header
echo -e "\n6. Dashboard Page (with auth):"
curl -s -H "X-Dashboard-Key: $API_KEY" "$DASHBOARD_URL/" | grep -o "<title>.*</title>" || echo "Dashboard page failed"

# Test specific domain stats if available
echo -e "\n7. Domain-specific stats:"
curl -s -H "X-Dashboard-Key: $API_KEY" "$DASHBOARD_URL/api/storage-stats?domain=example.com" | jq '.' 2>/dev/null || echo "Domain stats failed"

echo -e "\n=================================="
echo "Dashboard API test complete"