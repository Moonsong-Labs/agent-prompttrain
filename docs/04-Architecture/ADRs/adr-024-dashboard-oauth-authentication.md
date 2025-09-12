# ADR-024: Dashboard OAuth Authentication

## Status

Accepted

## Context

The dashboard currently uses a simple API key authentication mechanism where users must enter a pre-configured `DASHBOARD_API_KEY` to access the dashboard. This approach has several limitations:

1. **Single shared credential**: All users share the same API key, making it impossible to track individual user actions or implement user-specific permissions
2. **No user identity**: The system cannot identify who is accessing the dashboard
3. **Limited security**: API keys can be easily shared and there's no way to revoke access for specific users
4. **Enterprise requirements**: Many organizations require integration with their existing identity providers (Google Workspace, Active Directory, etc.)

Google Enterprise customers have specifically requested OAuth integration to:

- Leverage their existing Google Workspace user management
- Enforce domain-based access restrictions
- Enable single sign-on (SSO) across their tools
- Meet compliance requirements for user authentication

## Decision

We will implement Google OAuth 2.0 authentication for the dashboard while maintaining backward compatibility with the existing API key authentication. This creates a hybrid authentication system where:

1. **OAuth as primary method**: Users can authenticate using their Google accounts
2. **API key as fallback**: The existing API key authentication remains available
3. **Domain restrictions**: Support for restricting access to specific Google Workspace domains
4. **Minimal user data storage**: Store only essential user information (email, name, Google ID)
5. **Session-based authentication**: Use secure HTTP-only cookies for session management

### Technical Approach

The implementation follows these principles:

1. **Database changes are minimal**: Only add `users` and `sessions` tables
2. **No complex user management**: No roles, permissions, or groups initially
3. **Leverage existing patterns**: Use the existing cookie-based session approach
4. **Secure by default**: HTTP-only cookies, CSRF protection, domain validation
5. **Extensible design**: Can add more OAuth providers or features later

## Consequences

### Positive

1. **Enhanced security**: Individual user authentication with revocable sessions
2. **Enterprise ready**: Meets requirements for Google Workspace integration
3. **User accountability**: Can track actions by individual users
4. **Improved UX**: Single sign-on reduces friction for users
5. **Backward compatible**: Existing API key users are not affected
6. **Future extensibility**: Foundation for adding more auth providers or features

### Negative

1. **Increased complexity**: OAuth flow adds complexity compared to simple API keys
2. **Configuration overhead**: Requires Google Cloud Console setup and configuration
3. **Database dependency**: Dashboard now requires database for session storage
4. **Migration effort**: Existing deployments need to run database migrations

### Neutral

1. **Dual authentication**: Supporting both methods may confuse some users
2. **Session management**: Requires periodic cleanup of expired sessions
3. **Domain restrictions**: May limit flexibility for some use cases

## Implementation Details

### Environment Variables

New environment variables for OAuth configuration:

```bash
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=https://your-domain/dashboard/auth/google/callback
GOOGLE_ALLOWED_DOMAINS=company.com,subsidiary.com  # Optional domain restrictions
SESSION_DURATION_DAYS=30  # Optional, defaults to 30 days
```

### Database Schema

```sql
-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  google_id VARCHAR(255) UNIQUE NOT NULL,
  allowed_domain VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sessions table
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Authentication Flow

1. User clicks "Sign in with Google"
2. Redirect to Google OAuth consent screen
3. User authorizes and is redirected back with authorization code
4. Exchange code for tokens and fetch user profile
5. Validate domain if restrictions are configured
6. Create or update user record
7. Create session with secure token
8. Set HTTP-only cookie with session token
9. Redirect to dashboard

### Security Considerations

1. **CSRF Protection**: State parameter validates OAuth callbacks
2. **Domain Validation**: Enforces enterprise domain restrictions
3. **Secure Cookies**: HTTP-only, secure, sameSite settings
4. **Session Expiry**: Configurable session duration with cleanup
5. **Token Security**: Cryptographically secure session tokens

## References

- [Google OAuth 2.0 Documentation](https://developers.google.com/identity/protocols/oauth2)
- [OAuth 2.0 Security Best Practices](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-security-topics)
- ADR-019: Dashboard Read-Only Mode Security Implications

## Notes

Future enhancements could include:

- Support for additional OAuth providers (GitHub, Microsoft, etc.)
- Role-based access control (RBAC)
- Multi-factor authentication (MFA)
- API token generation for programmatic access
- Audit logging of user actions
