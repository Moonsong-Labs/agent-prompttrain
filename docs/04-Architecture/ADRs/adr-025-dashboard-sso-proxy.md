# ADR-025: Dashboard SSO via OAuth2 Proxy Middleware

## Status

Accepted

## Context

The dashboard currently relies on `DASHBOARD_API_KEY` cookies/headers for authentication, with a read-only fallback when the key is absent (see [ADR-019](./adr-019-dashboard-read-only-mode-security.md)). As adoption grows, teams want Google Workspace single sign-on without embedding OAuth logic directly into the dashboard service, which is built on HTMX with minimal JavaScript (see [ADR-009](./adr-009-dashboard-architecture.md)). Deployments commonly terminate TLS and route traffic via Nginx on the same EC2 instance that hosts the Dockerized proxy and dashboard services.

## Decision Drivers

- Maintain the dashboard’s lightweight architecture (no SPA / minimal JS)
- Reuse proven, supportable components for OAuth2/OIDC flows
- Support Google Workspace as the immediate identity provider with room for others later
- Preserve the existing API-key workflow for automation and local development
- Keep configuration simple for single-host EC2 deployments with Nginx

## Decision

Adopt an identity-aware auth proxy (initially [OAuth2 Proxy](https://oauth2-proxy.github.io/oauth2-proxy/)) between Nginx and the dashboard. Nginx uses `auth_request` to delegate authentication to the proxy. On success, OAuth2 Proxy forwards trusted identity headers (e.g., `X-Auth-Request-Email`) to the dashboard. The dashboard now accepts those headers when `DASHBOARD_SSO_ENABLED=true`, while continuing to honor `DASHBOARD_API_KEY` cookies/headers and read-only behavior when no key is configured.

## Options Considered

1. **Embed Google OAuth directly in the dashboard** – rejected: increases code complexity, ties UI to a single IdP, duplicates functionality already solved by auth proxies.
2. **Use AWS Cognito / ALB authentication** – rejected: requires additional AWS infrastructure and does not fit current Nginx deployment model.
3. **Pomerium auth proxy** – deferred: powerful policy engine but heavier operational overhead for a single dashboard.
4. **OAuth2 Proxy sidecar** – chosen: lightweight, battle-tested, easy to run in Docker, documented Nginx patterns.

## Consequences

### Positive

- Minimal changes to application code while gaining Google SSO
- Consistent login UX managed by IdP (MFA, session policies)
- Simple path to extend to other internal services via the same proxy
- API-key automation remains available for integrations and local dev

### Negative

- Nginx configuration becomes more involved (auth_request, header pass-through)
- Requires managing additional secrets (client ID/secret, cookie secret)
- Need to monitor the auth proxy container for updates and availability

### Follow-Up Actions

- Document Nginx and Docker Compose examples for OAuth2 Proxy
- Expose new environment variables: `DASHBOARD_SSO_ENABLED`, `DASHBOARD_SSO_HEADERS`, `DASHBOARD_SSO_ALLOWED_DOMAINS`
- Encourage operators to restrict allowed email domains and secure cookies

## References

- [ADR-019: Dashboard Read-Only Mode Security Implications](./adr-019-dashboard-read-only-mode-security.md)
- [OAuth2 Proxy Documentation](https://oauth2-proxy.github.io/oauth2-proxy/)
- Nginx `auth_request` Directive – [NGINX Docs](https://nginx.org/en/docs/http/ngx_http_auth_request_module.html)
