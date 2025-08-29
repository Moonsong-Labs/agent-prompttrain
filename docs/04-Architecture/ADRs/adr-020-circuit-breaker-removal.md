# ADR 020: Circuit Breaker Removal

## Status

Accepted

## Context

Agent Prompt Train initially implemented a circuit breaker pattern to protect Claude API from being overwhelmed during outages. The circuit breaker would open after detecting failures, preventing requests from reaching Claude API and returning immediate errors to clients.

However, this protective mechanism has proven problematic:

1. **False Positives**: The circuit breaker sometimes trips on legitimate client errors (e.g., malformed requests), blocking valid requests
2. **Reduced Visibility**: When the circuit breaker opens, it masks the actual Claude API errors, making debugging difficult
3. **Unnecessary Complexity**: Claude API has its own rate limiting and protection mechanisms
4. **Operational Overhead**: Monitoring and tuning circuit breaker thresholds requires ongoing maintenance

## Decision

Remove the circuit breaker implementation entirely and allow Claude API errors to pass through directly to clients after retry attempts.

## Implementation Details

The following changes were made:

1. **Removed Circuit Breaker Wrapper**: Modified `ClaudeApiClient` to call retry logic directly without circuit breaker protection
2. **Deleted Implementation Files**:
   - `/services/proxy/src/utils/circuit-breaker.ts`
   - `/packages/shared/src/utils/circuit-breaker.ts`
3. **Cleaned Up Exports**: Removed circuit breaker exports from `/packages/shared/src/index.ts`
4. **Removed Configuration**: Deleted circuit breaker configuration from shared config and environment variables:
   - `CIRCUIT_BREAKER_FAILURE_THRESHOLD`
   - `CIRCUIT_BREAKER_SUCCESS_THRESHOLD`
   - `CIRCUIT_BREAKER_TIMEOUT`
   - `CIRCUIT_BREAKER_VOLUME_THRESHOLD`
   - `CIRCUIT_BREAKER_ERROR_PERCENTAGE`

## Consequences

### Positive

- **Simplified Architecture**: Removed unnecessary abstraction layer
- **Better Error Transparency**: Claude API errors are now visible to clients and operators
- **Reduced Configuration**: No need to tune circuit breaker parameters
- **Maintained Resilience**: Retry logic with exponential backoff still provides protection against transient failures

### Negative

- **Potential for Cascading Failures**: Without circuit breaker, a degraded Claude API could be overwhelmed by retry attempts
- **Increased Load During Outages**: Every request will attempt retries rather than failing fast

### Mitigations

1. **Robust Retry Logic**: Existing exponential backoff with jitter prevents thundering herd
2. **Claude API Protection**: Rely on Claude's own rate limiting and load shedding
3. **Enhanced Monitoring**: Monitor proxy 5xx error rates for early detection of issues
4. **Manual Intervention**: Operators can disable features or implement emergency measures during severe outages

## References

- Original circuit breaker implementation in shared utilities
- ADR-006: Long-running request support (mentions circuit breaker timeout configuration)
