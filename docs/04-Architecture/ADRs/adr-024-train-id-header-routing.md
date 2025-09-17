# ADR-024: Header-Based Train and Account Routing

## Status

Accepted

## Context

Domain-based credential resolution (including wildcard subtrain support from ADR-023) added
significant complexity and operational surprises:

- Many deployments run the proxy behind load balancers or tunnels where the `Host` header
  reflects infrastructure rather than the original tenant identifier.
- Wildcard resolution created implicit credential precedence rules that were hard to audit.
- Multi-account customers wanted to reuse the same train identifier across several Anthropic
  subscriptions without duplicating domain mappings.

At the same time, analytics and storage systems continued to rely on the logical train id, so we
needed a mechanism that clearly separates **who** is making the request (train) from **which
credentials** are used to fulfil it (account).

## Decision

1. **Explicit Headers**
   - `MSL-Train-Id` remains mandatory for analytics but now defaults to `DEFAULT_TRAIN_ID` when absent.
   - `MSL-Account` selects the Anthropic account credential file. When omitted the proxy chooses a
     deterministic account based on the train identifier, falling back to other accounts only when the
     preferred one fails to load.
   - Neither header is forwarded to Anthropic; only configured custom headers (e.g. via
     `ANTHROPIC_CUSTOM_HEADERS`) are propagated.

2. **Filesystem Layout**
   - Account credentials live under `credentials/accounts/<account>.credentials.json` and contain only
     Anthropic authentication data (API key or OAuth fields plus optional Slack configuration).
   - Proxy client API keys move to `credentials/train-client-keys/<train>.client-keys.json`, decoupling
     proxy access control from Anthropic credentials.

3. **Authentication Service Simplification**
   - Domain normalization, wildcard resolution, PSL checks, and related feature flags are removed.
   - The service now enumerates account files, applies safe path guards, and selects accounts based on
     the new headers.

## Consequences

### Positive

- Clear separation between trains (analytics) and accounts (credentials).
- Simpler operational model: new trains require only a header; new accounts require only a credential
  file.
- Eliminates wildcard precedence edge cases and large path traversal surface area.
- Deterministic hashing provides consistent per-train account selection while still distributing load
  across multiple keys.

### Negative

- Existing wildcard configurations must be migrated to explicit account files and header usage.
- Requests that previously relied on implicit domain defaults must now supply the `MSL-Train-Id` header or
  accept the configured fallback.

### Neutral

-
- Documentation and tooling needed updates but no database schema changes were required.

## Migration Notes

1. Move each `*.credentials.json` file from the root `credentials/` directory into
   `credentials/accounts/` and rename the file to the desired account name.
2. Create per-train client key files under `credentials/train-client-keys/` if proxy authentication is
   enabled.
3. Update clients to send `MSL-Train-Id` (and optionally `MSL-Account`) headers.
4. Remove any `CNP_WILDCARD_*` environment variables; they are no longer used.

## References

- Supersedes [ADR-023](./adr-023-wildcard-subdomain-support.md)
- Environment variable reference: [docs/06-Reference/environment-vars.md](../06-Reference/environment-vars.md)
