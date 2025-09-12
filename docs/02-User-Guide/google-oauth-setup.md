# Google OAuth Setup Guide

This guide walks you through setting up Google OAuth 2.0 authentication for the Agent Prompt Train dashboard.

## Prerequisites

- Google Cloud Console access
- Domain ownership verification (for Google Workspace restrictions)
- Dashboard deployed with a public URL

## Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Click "Select a project" → "New Project"
3. Enter a project name (e.g., "Agent Prompt Train Dashboard")
4. Click "Create"

## Step 2: Enable Google APIs

1. In your project, go to "APIs & Services" → "Library"
2. Search for and enable:
   - Google+ API (for user profile information)
   - Admin SDK API (if using domain restrictions)

## Step 3: Configure OAuth Consent Screen

1. Go to "APIs & Services" → "OAuth consent screen"
2. Choose user type:
   - **Internal**: For Google Workspace users only (recommended for enterprises)
   - **External**: For any Google account
3. Fill in the required information:
   - App name: "Agent Prompt Train Dashboard"
   - User support email: Your support email
   - Developer contact: Your email
4. Add scopes:
   - `userinfo.email`
   - `userinfo.profile`
5. Save and continue

## Step 4: Create OAuth Credentials

1. Go to "APIs & Services" → "Credentials"
2. Click "Create Credentials" → "OAuth client ID"
3. Choose "Web application"
4. Configure:
   - Name: "Dashboard OAuth Client"
   - Authorized JavaScript origins:
     ```
     https://dashboard.example.com
     http://localhost:3001  (for development)
     ```
   - Authorized redirect URIs:
     ```
     https://dashboard.example.com/dashboard/auth/google/callback
     http://localhost:3001/dashboard/auth/google/callback  (for development)
     ```
5. Click "Create"
6. Save the Client ID and Client Secret

## Step 5: Configure Environment Variables

Add these to your `.env` file or deployment configuration:

```bash
# Google OAuth Configuration
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=https://dashboard.example.com/dashboard/auth/google/callback

# Optional: Restrict to specific domains
GOOGLE_ALLOWED_DOMAINS=company.com,subsidiary.com

# Optional: Session duration (default: 30 days)
SESSION_DURATION_DAYS=7
```

## Step 6: Run Database Migrations

The OAuth implementation requires new database tables:

```bash
# Run the OAuth migration
bun run scripts/db/migrations/012-add-oauth-tables.ts
```

## Step 7: Verify Setup

1. Restart the dashboard service
2. Navigate to the login page
3. You should see "Sign in with Google" button
4. Test the OAuth flow

## Google Workspace Configuration

For enterprise deployments using Google Workspace:

### Domain Verification

1. Verify domain ownership in Google Search Console
2. Add verified domains to `GOOGLE_ALLOWED_DOMAINS`

### Organizational Settings

1. In Google Admin Console:
   - Go to "Security" → "API Controls"
   - Add your OAuth client ID to trusted apps
   - Configure data access permissions

### User Access

1. Ensure users have:
   - Active Google Workspace accounts
   - Permission to use third-party apps
   - Access to required APIs

## Troubleshooting

### Common Issues

1. **"Access blocked" error**
   - Ensure OAuth consent screen is configured
   - For internal apps, user must be in your Google Workspace

2. **"Domain not allowed" error**
   - Check `GOOGLE_ALLOWED_DOMAINS` configuration
   - Verify user's email domain matches

3. **"Redirect URI mismatch"**
   - Ensure `GOOGLE_REDIRECT_URI` matches exactly
   - Check for trailing slashes
   - Verify protocol (http vs https)

4. **Session not persisting**
   - Check cookie settings in browser
   - Ensure `secure` flag matches protocol
   - Verify database connection

### Debug Mode

Enable debug logging:

```bash
DEBUG=true
LOG_LEVEL=debug
```

Check logs for:

- OAuth state validation
- Token exchange errors
- Domain validation failures
- Database connection issues

## Security Best Practices

1. **Keep secrets secure**
   - Never commit OAuth credentials
   - Use environment variables or secrets management
   - Rotate credentials periodically

2. **Use HTTPS in production**
   - OAuth requires secure connections
   - Cookies are marked secure in production

3. **Implement domain restrictions**
   - Always use `GOOGLE_ALLOWED_DOMAINS` for enterprise
   - Validate against your organization's domains

4. **Monitor sessions**
   - Implement session cleanup
   - Monitor for suspicious activity
   - Set appropriate session durations

## References

- [Google OAuth 2.0 Documentation](https://developers.google.com/identity/protocols/oauth2)
- [Google Cloud Console](https://console.cloud.google.com)
- [Google Admin Console](https://admin.google.com)
