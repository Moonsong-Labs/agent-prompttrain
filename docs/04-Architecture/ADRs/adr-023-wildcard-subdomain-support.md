# ADR-023: Wildcard Subproject Support

## Status

Superseded by [ADR-024](./adr-024-train-id-header-routing.md)

## Context

The Claude Nexus Proxy needs to support organizations with many subprojects (e.g., `api.staging.example.com`, `api.prod.example.com`, `api.dev.example.com`) without requiring separate credential files for each subproject. This is particularly important for:

1. Large organizations with environment-based subprojects
2. Multi-tenant SaaS applications with customer-specific subprojects
3. Development teams using feature branch deployments

Currently, each subproject requires its own credential file, leading to:

- Credential proliferation and management overhead
- Increased risk of configuration drift
- Difficulty in rotating API keys across environments

## Decision

We will implement wildcard subproject support using a prefix-based approach that is cross-platform compatible:

### 1. Wildcard Credential Files

- Use `_wildcard.` prefix for wildcard credential files
- Example: `_wildcard.example.com.credentials.json` matches `*.example.com`
- This avoids filesystem issues with `*` character on Windows

### 2. Resolution Order

Credentials are resolved in order of specificity:

1. Exact match: `api.staging.example.com.credentials.json`
2. Most specific wildcard: `_wildcard.staging.example.com.credentials.json`
3. Less specific wildcard: `_wildcard.example.com.credentials.json`
4. No match: fallback to default behavior

### 3. Security Boundaries

- Integrate Public Suffix List (PSL) to prevent privilege escalation
- Wildcard matching stops at registrable project boundaries
- Example: `_wildcard.co.uk.credentials.json` will NOT match `example.co.uk`

### 4. Feature Flag Control

- Environment variable: `CNP_WILDCARD_CREDENTIALS`
- Values:
  - `true`: Enable wildcard support
  - `false`: Disable (default)
  - `shadow`: Log matches without changing behavior

### 5. Performance Optimization

- TTL-based caching for credential resolution
- Cache both positive and negative results
- Environment variable: `CNP_RESOLUTION_CACHE_TTL` (default: 5 minutes)
- Maximum cache size: 10,000 entries with LRU eviction

### 6. Domain Normalization

- Convert to lowercase
- Remove ports
- Handle Internationalized Domain Names (IDN) with punycode
- Remove trailing dots
- Collapse consecutive dots

## Consequences

### Positive

- **Simplified credential management**: One file can serve multiple subprojects
- **Reduced configuration drift**: Centralized credential updates
- **Better security**: PSL integration prevents unauthorized access
- **Cross-platform compatibility**: Works on all operating systems
- **Performance**: Caching reduces filesystem operations
- **Backward compatible**: Existing configurations continue to work
- **Safe rollout**: Shadow mode allows testing without risk

### Negative

- **Added complexity**: More code paths to maintain
- **Memory usage**: Cache requires memory (bounded at 10K entries)
- **PSL dependency**: Requires maintaining PSL library
- **Learning curve**: Administrators need to understand wildcard behavior

### Neutral

- **Explicit wildcards**: Requires `_wildcard.` prefix (not automatic)
- **Cache invalidation**: Manual cache clear may be needed for immediate updates

## Implementation Details

### Key Components

1. **AuthenticationService**: Enhanced with wildcard resolution logic
2. **Domain normalization**: Handles IDN, ports, and edge cases
3. **PSL integration**: Prevents privilege escalation attacks
4. **Resolution cache**: Map with TTL-based expiration
5. **Feature flags**: Safe rollout with shadow mode

### Configuration Examples

```
# Wildcard for all staging subprojects
_wildcard.staging.example.com.credentials.json

# Wildcard for all subprojects of example.com
_wildcard.example.com.credentials.json

# Exact match (takes precedence)
api.staging.example.com.credentials.json
```

### Environment Variables

- `CNP_WILDCARD_CREDENTIALS`: Enable/disable feature
- `CNP_RESOLUTION_CACHE_TTL`: Cache TTL in milliseconds
- `CNP_DEBUG_RESOLUTION`: Enable debug logging

## References

- [Public Suffix List](https://publicsuffix.org/)
- [RFC 3490: Internationalizing Domain Names in Applications (IDNA)](https://tools.ietf.org/html/rfc3490)
- Original implementation plan: `/PLAN.md`
