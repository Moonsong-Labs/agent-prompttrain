# ADR-019: Dashboard Read-Only Mode Security Implications

## Status

Accepted

## Context

The Agent Prompt Train dashboard was modified to support a "read-only mode" that allows access without authentication when `DASHBOARD_API_KEY` is not set. This was implemented to simplify development and quick deployments, but it introduces significant security concerns that need to be documented and addressed.

### Current Implementation

When `DASHBOARD_API_KEY` is not set in the environment:

- The dashboard operates in "read-only mode" (`isReadOnly = true`)
- All authentication checks are bypassed
- Anyone with network access to the dashboard can view all data
- This includes sensitive information such as:
  - All API requests and responses
  - Conversation histories with potentially sensitive content
  - Token usage statistics and costs
  - Account identifiers and usage patterns
  - AI analysis results and insights

## Decision Drivers

- **Developer Experience**: Need for quick local development without authentication setup
- **Security**: Protecting sensitive conversation data and usage information
- **Deployment Safety**: Preventing accidental exposure of data in production
- **Transparency**: Clear communication about security implications
- **Backward Compatibility**: Supporting existing deployments that rely on read-only mode

## Considered Options

1. **Remove Read-Only Mode Entirely**
   - Description: Require `DASHBOARD_API_KEY` in all cases
   - Pros:
     - Eliminates security risk completely
     - Forces secure configuration
     - Simpler security model
   - Cons:
     - Breaks existing deployments
     - Complicates local development
     - More setup friction

2. **Keep Read-Only Mode with Clear Warnings**
   - Description: Maintain current behavior but add prominent security warnings
   - Pros:
     - Preserves backward compatibility
     - Maintains developer convenience
     - Clear about security implications
   - Cons:
     - Security risk remains
     - Users may ignore warnings
     - Potential for misconfiguration

3. **Read-Only Mode for Local Development Only**
   - Description: Enable read-only mode only when explicitly running in development mode
   - Pros:
     - Balances security and convenience
     - Safe by default in production
     - Developer-friendly
   - Cons:
     - Requires additional configuration
     - May confuse users about when auth is required

4. **Implement IP-Based Restrictions for Read-Only Mode**
   - Description: Allow read-only mode but restrict to localhost/private IPs
   - Pros:
     - Safer than unrestricted access
     - Still convenient for local development
   - Cons:
     - Can be bypassed with proxies
     - Complex to implement correctly
     - False sense of security

## Decision

We will **keep read-only mode with clear warnings** (Option 2) for now, but with the following immediate actions:

1. Add prominent security warnings in all documentation
2. Display security warnings in the dashboard UI when in read-only mode
3. Log warnings at startup when read-only mode is active
4. Plan for deprecation in a future major version

### Implementation Details

1. **Documentation Updates**:
   - Add security warnings to README.md
   - Update CLAUDE.md with security implications
   - Enhance security.md with detailed warnings
   - Add warnings to deployment guides

2. **UI Warnings**:

   ```typescript
   // Display banner when in read-only mode
   if (isReadOnly) {
     showWarningBanner(
       'Dashboard is in read-only mode without authentication. Do not use in production!'
     )
   }
   ```

3. **Startup Warnings**:
   ```typescript
   if (!process.env.DASHBOARD_API_KEY) {
     console.warn('⚠️  WARNING: Dashboard running in READ-ONLY MODE without authentication!')
     console.warn('⚠️  This exposes all conversation data to anyone with network access.')
     console.warn('⚠️  Set DASHBOARD_API_KEY environment variable to enable authentication.')
   }
   ```

## Consequences

### Positive

- Maintains backward compatibility
- Preserves developer convenience for local development
- Clear communication reduces risk of accidental exposure
- Provides migration path for existing users

### Negative

- Security vulnerability remains until deprecated
- Risk of users ignoring warnings
- Potential for data exposure if deployed incorrectly
- Technical debt that needs future resolution

### Security Implications

**Critical**: Running the dashboard without `DASHBOARD_API_KEY` exposes:

- All conversation histories
- Token usage and costs
- Account information
- AI analysis results
- Request/response payloads

This mode should **NEVER** be used in production or any environment accessible from the internet.

## Future Recommendations

1. **Phase 1** (Current): Add warnings and documentation
2. **Phase 2** (Next Minor Version): Add deprecation warnings
3. **Phase 3** (Next Major Version): Remove read-only mode or restrict to explicit development mode
4. **Alternative**: Implement a separate "demo mode" with synthetic data for testing

## References

- [Security Guide](../../03-Operations/security.md)
- [Dashboard Architecture (ADR-009)](./adr-009-dashboard-architecture.md)
- Original PR: feat: add read-only mode support for dashboard without API key
