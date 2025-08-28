#!/bin/bash

echo "Testing unrestricted model support..."

# Start the proxy
docker run -d --name test-proxy -p 3000:3000 \
  -e DEBUG=true \
  agent-prompttrain-proxy

echo "Waiting for server to start..."
sleep 3

echo -e "\nTesting various model names:"

# Test with a future/fictional model name
echo -e "\n1. Testing fictional model 'claude-4-ultra-20250101':"
curl -s -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-4-ultra-20250101",
    "messages": [{"role": "user", "content": "test"}],
    "max_tokens": 10
  }' | jq -r '.error.message // "Request accepted"' 2>/dev/null || echo "Request processed"

# Test with the previously failing model
echo -e "\n2. Testing 'claude-3-5-haiku-20241022':"
curl -s -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-haiku-20241022",
    "messages": [{"role": "user", "content": "test"}],
    "max_tokens": 10
  }' | jq -r '.error.message // "Request accepted"' 2>/dev/null || echo "Request processed"

# Test with a custom model name
echo -e "\n3. Testing custom model 'my-custom-claude-model':"
curl -s -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "my-custom-claude-model",
    "messages": [{"role": "user", "content": "test"}],
    "max_tokens": 10
  }' | jq -r '.error.message // "Request accepted"' 2>/dev/null || echo "Request processed"

echo -e "\nChecking logs for validation errors:"
docker logs test-proxy 2>&1 | grep -i "invalid model" || echo "✅ No model validation errors found"

echo -e "\nCleaning up..."
docker stop test-proxy >/dev/null
docker rm test-proxy >/dev/null
echo "Done!"