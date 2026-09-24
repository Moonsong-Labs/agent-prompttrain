#!/bin/bash
# Script to run all tests with proper isolation

echo "Running all tests with proper isolation..."

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Track overall success
OVERALL_SUCCESS=0

# Run unit tests
echo -e "\n${GREEN}Running unit tests...${NC}"
if bun test test/unit services/proxy/tests tests/unit services/dashboard/src/routes/__tests__ services/dashboard/src/utils/__tests__ services/proxy/src/routes/__tests__ services/dashboard/src/layout/__tests__ packages/shared/src/**/__tests__; then
    echo -e "${GREEN}✓ Unit tests passed${NC}"
else
    echo -e "${RED}✗ Unit tests failed${NC}"
    OVERALL_SUCCESS=1
fi

# Run integration tests separately
echo -e "\n${GREEN}Running integration tests...${NC}"
if ./scripts/test-integration.sh; then
    echo -e "${GREEN}✓ Integration tests passed${NC}"
else
    echo -e "${RED}✗ Integration tests failed${NC}"
    OVERALL_SUCCESS=1
fi

# Summary
echo -e "\n${GREEN}========================================${NC}"
if [ $OVERALL_SUCCESS -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
else
    echo -e "${RED}✗ Some tests failed${NC}"
fi
echo -e "${GREEN}========================================${NC}"

exit $OVERALL_SUCCESS