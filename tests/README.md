# Agent PromptTrain Tests

This directory contains automated tests for the Agent PromptTrain.

## Test Structure

```
tests/
├── unit/           # Unit tests for individual components
├── integration/    # Integration tests for service interactions
├── e2e/           # End-to-end tests with real services
└── fixtures/      # Test data and mocks
```

## Running Tests

```bash
# Run all tests
bun test

# Run specific test suite
bun test unit
bun test integration
bun test e2e

# Run with coverage
bun test --coverage

# Run in watch mode
bun test --watch
```

## Test Categories

### Unit Tests

- Credential loading and validation
- OAuth token refresh logic
- Request/response processing
- Authentication middleware
- Token usage tracking

### Integration Tests

- Proxy to Claude API communication
- Database storage operations
- Credential file handling
- OAuth refresh flow
- Conversation tracking

### End-to-End Tests

- Full request flow through proxy
- Claude CLI integration
- Multi-domain authentication
- Error handling scenarios
- Performance benchmarks

## Writing Tests

Tests use Bun's built-in test runner with the following conventions:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'

describe('FeatureName', () => {
  beforeEach(() => {
    // Setup
  })

  afterEach(() => {
    // Cleanup
  })

  it('should do something', () => {
    // Test implementation
    expect(result).toBe(expected)
  })
})
```

## Test Data Collection

Enable test sample collection to capture real request/response data:

```bash
COLLECT_TEST_SAMPLES=true bun run dev:proxy
```

Samples are stored in `test-samples/` and can be used to create realistic test fixtures.
