# ADR-028: Proxy Service Operational Modes

## Status

Accepted

## Context

The proxy service currently runs all endpoints in a single monolithic deployment, serving both Claude Code client requests (API proxy) and Dashboard data requests (internal API). This creates several challenges:

1. **Resource inefficiency**: Deployments that only need API proxy functionality must still load and run dashboard API routes
2. **Security concerns**: API-only deployments require database credentials even when not using the proxy features
3. **Scaling limitations**: Cannot independently scale proxy traffic vs dashboard API traffic
4. **Operational complexity**: Single failure domain for two distinct use cases

The project already uses feature flags extensively (`config.features.*`) and has ADR-027 mandating user authentication for dashboards. We need a way to deploy the proxy service in different configurations based on operational needs.

## Decision Drivers

- **Operational flexibility**: Enable deployment of minimal services for specific use cases
- **Resource optimization**: Reduce memory footprint and startup time for focused deployments
- **Security**: Enforce required credentials only when relevant endpoints are active
- **Backward compatibility**: Existing deployments must continue working without changes
- **Simplicity**: Follow existing configuration patterns in the codebase

## Considered Options

### 1. Single SERVICE_MODE environment variable

- **Description**: Add `SERVICE_MODE` with three values: `full` (default), `proxy`, `api`
- **Pros**:
  - Simple to understand and configure
  - Clear intent with single variable
  - Easy to validate (mutually exclusive modes)
  - Follows existing single-value pattern (e.g., `NODE_ENV`)
- **Cons**:
  - Less flexible for edge cases
  - Cannot mix custom endpoint combinations

### 2. Separate boolean flags per endpoint group

- **Description**: Add `ENABLE_PROXY_ENDPOINTS` and `ENABLE_DASHBOARD_API_ENDPOINTS`
- **Pros**:
  - Maximum flexibility
  - Can enable/disable groups independently
- **Cons**:
  - More complex validation
  - Risk of invalid combinations
  - More configuration to manage

### 3. Separate entry points (different main files)

- **Description**: Create `main-proxy.ts`, `main-api.ts`, `main.ts`
- **Pros**:
  - Cleanest separation
  - Smallest runtime footprint per mode
- **Cons**:
  - More build complexity
  - Harder to maintain
  - Deployment configuration more complex

## Decision

Implement **Option 1: Single SERVICE_MODE environment variable** with three modes:

- `full`: All endpoints (default, backward compatible)
- `proxy`: Only Claude Code endpoints (`/v1/*`, `/mcp`, `/health`, `/token-stats`)
- `api`: Only Dashboard API endpoints (`/api/*`, `/health`)

### Implementation Details

**Configuration layer** (`packages/shared/src/config/index.ts`):

```typescript
service: {
  get mode() {
    const mode = env.string('SERVICE_MODE', 'full')
    if (mode !== 'full' && mode !== 'proxy' && mode !== 'api') {
      throw new Error(`Invalid SERVICE_MODE value: "${mode}". Must be one of: full, proxy, api`)
    }
    return mode as 'full' | 'proxy' | 'api'
  },
}

export function isProxyMode(): boolean {
  return config.service.mode === 'proxy' || config.service.mode === 'full'
}

export function isApiMode(): boolean {
  return config.service.mode === 'api' || config.service.mode === 'full'
}
```

**Route registration** (`services/proxy/src/app.ts`):

```typescript
// Proxy mode endpoints
if (isProxyMode()) {
  app.use('/v1/*', clientAuthMiddleware())
  app.use('/v1/*', projectIdExtractorMiddleware())
  app.post('/v1/messages', c => messageController.handle(c))
  // ... other proxy endpoints
}

// API mode endpoints
if (isApiMode()) {
  app.use('/api/*', apiAuthMiddleware())
  app.route('/api', apiRoutes)
  // ... other API routes
}

// Always available
app.route('/health', healthRoutes)
```

**Validation**:

- API mode requires `DATABASE_URL` (fail fast at startup)
- API mode and full mode require `INTERNAL_API_KEY` (fail fast at startup)
- Invalid mode values rejected at startup with clear error

## Consequences

### Positive

- **Resource optimization**: Proxy-only deployments don't need database, reducing memory footprint
- **Security**: Mode-specific credential validation prevents misconfiguration
- **Operational flexibility**: Can deploy minimal services for specific use cases
- **Backward compatibility**: Default `full` mode maintains existing behavior
- **Clear separation**: Helper functions (`isProxyMode`, `isApiMode`) make code intent explicit
- **Better observability**: Service mode logged at startup for debugging

### Negative

- **Additional configuration**: One more environment variable to manage
- **Testing complexity**: Each mode needs validation in tests
- **Documentation burden**: Must document three deployment patterns instead of one

### Risks and Mitigations

- **Risk**: Developers forget to set SERVICE_MODE in new deployments
  - **Mitigation**: Default to `full` mode for backward compatibility

- **Risk**: Invalid mode combinations cause runtime errors
  - **Mitigation**: Validation at startup fails fast with clear errors

- **Risk**: Mode-specific bugs not caught in full mode testing
  - **Mitigation**: Add integration tests for each mode

## Links

- [ADR-027: Mandatory User Authentication](./adr-027-mandatory-user-authentication.md) - Dashboard requires oauth2-proxy
- [ADR-002: Separate Docker Images](./adr-002-separate-docker-images.md) - Services run independently
- [ADR-004: Proxy Authentication Methods](./adr-004-proxy-authentication.md) - Client API key authentication

## Notes

### Use Cases

**Proxy mode** (`SERVICE_MODE=proxy`):

- Minimal Claude Code API proxy
- No database required (optional for tracking)
- Client API key authentication
- Example: Testing, lightweight proxy-only deployment

**API mode** (`SERVICE_MODE=api`):

- Dashboard backend service
- Requires database and INTERNAL_API_KEY
- Internal API authentication
- Example: Dedicated API service for dashboard

**Full mode** (`SERVICE_MODE=full`):

- All-in-one deployment (default)
- Requires database and INTERNAL_API_KEY
- Both client and internal API authentication
- Example: Development, simple production setups

### Future Considerations

- Could add more granular modes if needed (e.g., `proxy-minimal`, `api-readonly`)
- Could implement mode-specific health checks
- May want to add metrics per mode to track usage patterns

---

Date: 2025-01-10
Authors: Claude Code (AI Agent)
