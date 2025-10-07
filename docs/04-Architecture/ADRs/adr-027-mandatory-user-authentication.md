# ADR-027: Mandatory User Authentication for Dashboard

## Status

Accepted

## Context

The dashboard previously supported three authentication modes:

1. **Read-only mode** - No authentication (when `DASHBOARD_API_KEY` not set)
2. **API Key authentication** - Simple shared key via cookie or header
3. **SSO via oauth2-proxy** - Optional Google Workspace integration

This multi-mode approach created several issues:

### Security Concerns

- Read-only mode exposed all conversation data without authentication
- Deployments without `DASHBOARD_API_KEY` were vulnerable to data exposure
- API key authentication lacked user identity tracking
- No way to attribute actions to specific users

### Operational Complexity

- Three different authentication paths increased code complexity
- Read-only mode required special handling throughout the codebase
- Inconsistent authentication state between deployments
- Difficult to enforce consistent security policies

### User Experience Issues

- Login page was unnecessary when using oauth2-proxy
- No visibility into which user performed actions
- Confusing authentication setup for new deployments

## Decision

We will **enforce mandatory user authentication** for all dashboard access:

### Authentication Requirements

**Production Environment:**

- oauth2-proxy headers are **MANDATORY**
- User identity extracted from `X-Auth-Request-Email` (or configured headers)
- No unauthenticated access permitted
- oauth2-proxy must be deployed in front of the dashboard

**Development Environment:**

- `DASHBOARD_DEV_USER_EMAIL` environment variable provides bypass
- Allows local development without oauth2-proxy setup
- Clearly marked as development-only in documentation

### Removed Functionality

- `DASHBOARD_API_KEY` environment variable (removed entirely)
- Read-only mode (no longer supported)
- API key authentication via cookie/header (removed)
- Login/logout pages (oauth2-proxy handles authentication)
- Rate limiting for read-only mode (no longer needed)

### New Configuration

```bash
# Production - oauth2-proxy headers (mandatory)
DASHBOARD_SSO_HEADERS=X-Auth-Request-Email
DASHBOARD_SSO_ALLOWED_DOMAINS=example.com

# Development - bypass oauth2-proxy
DASHBOARD_DEV_USER_EMAIL=dev@localhost
```

### Implementation Details

**Authentication Middleware** (`services/dashboard/src/middleware/auth.ts`):

```typescript
// Simplified authentication flow:
1. Check DASHBOARD_DEV_USER_EMAIL (development bypass)
   → If set, authenticate as that user
2. Check oauth2-proxy headers (production)
   → Extract email from configured headers
   → Validate against domain allowlist if configured
3. Reject with 401 if neither succeeds
```

**AuthContext Type:**

```typescript
type AuthContext = {
  isAuthenticated: boolean
  principal: string // Always contains user email
  source: 'dev' | 'sso' // Authentication source
}
```

**Service-to-Service Authentication:**

- Dashboard→Proxy API communication continues using `INTERNAL_API_KEY`
- This is separate from user authentication
- Used for internal service-to-service calls

## Consequences

### Positive

**Security:**

- ✅ No unauthenticated access to sensitive data
- ✅ All actions attributed to specific users
- ✅ Enforces proper authentication in production
- ✅ Reduces attack surface (fewer authentication paths)

**Code Quality:**

- ✅ Removed ~200 lines of authentication-related code
- ✅ Simplified authentication logic (2 paths instead of 3)
- ✅ Eliminated read-only mode special cases throughout codebase
- ✅ Single source of truth for user identity

**Operations:**

- ✅ Clear authentication requirements for production
- ✅ Simple development setup with env variable
- ✅ oauth2-proxy handles session management
- ✅ User email visible in dashboard nav bar

### Negative

**Breaking Changes:**

- ⚠️ Existing deployments using `DASHBOARD_API_KEY` will break
- ⚠️ Requires oauth2-proxy deployment in production
- ⚠️ Scripts/automation using API key must be updated

**Migration Required:**

- Deployments must configure oauth2-proxy
- Update environment variables
- Remove `DASHBOARD_API_KEY` references
- Add `INTERNAL_API_KEY` for service-to-service auth
- For development, set `DASHBOARD_DEV_USER_EMAIL`

### Neutral

**Documentation:**

- Extensive documentation updates required (23 files affected)
- Clear migration guide needed for existing users
- ADR-019 (Read-Only Mode Security) superseded by this decision

## Migration Guide

### From API Key Authentication

**Before:**

```bash
DASHBOARD_API_KEY=your-secret-key
```

**After (Production):**

```bash
# Remove DASHBOARD_API_KEY entirely
# Configure oauth2-proxy (see deployment guide)
DASHBOARD_SSO_HEADERS=X-Auth-Request-Email
DASHBOARD_SSO_ALLOWED_DOMAINS=your-company.com

# For dashboard→proxy communication
INTERNAL_API_KEY=your-internal-key
```

**After (Development):**

```bash
# Remove DASHBOARD_API_KEY
DASHBOARD_DEV_USER_EMAIL=dev@localhost
INTERNAL_API_KEY=dev-internal-key
```

### oauth2-proxy Configuration

See [ADR-025: Dashboard SSO via OAuth2 Proxy](./adr-025-dashboard-sso-proxy.md) for detailed oauth2-proxy setup.

Minimal configuration:

```yaml
# oauth2-proxy deployment
- OAUTH2_PROXY_PROVIDER=google
- OAUTH2_PROXY_CLIENT_ID=<google-client-id>
- OAUTH2_PROXY_CLIENT_SECRET=<google-client-secret>
- OAUTH2_PROXY_COOKIE_SECRET=<generated-secret>
- OAUTH2_PROXY_EMAIL_DOMAINS=your-company.com
- OAUTH2_PROXY_UPSTREAMS=http://dashboard:3001
```

## Related Decisions

- Supersedes: [ADR-019: Dashboard Read-Only Mode Security](./adr-019-dashboard-read-only-mode-security.md)
- Builds on: [ADR-025: Dashboard SSO via OAuth2 Proxy](./adr-025-dashboard-sso-proxy.md)
- Related: [ADR-004: Proxy Authentication Methods](./adr-004-proxy-authentication.md)

## References

- oauth2-proxy documentation: https://oauth2-proxy.github.io/oauth2-proxy/
- Security considerations: [docs/03-Operations/security.md](../../03-Operations/security.md)
- Environment variables: [docs/06-Reference/environment-vars.md](../../06-Reference/environment-vars.md)
