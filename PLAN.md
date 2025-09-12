# Wildcard Subdomain Support Implementation Plan (Revised)

## Overview

This plan outlines the implementation of wildcard subdomain support for claude-nexus-proxy, enabling a single credential configuration to handle multiple subdomains while maintaining the existing per-domain credential system.

## Current System Analysis

### How It Works Now

1. **Domain-based credentials**: Each domain has its own credential file (`domain.com.credentials.json`)
2. **Exact match only**: The system looks for an exact domain match in the credentials directory
3. **Authentication flow**:
   - Extract domain from request host header
   - Look for `{domain}.credentials.json` file
   - Load API key or OAuth credentials
   - Authenticate with Claude API

### Limitations

- No support for subdomain inheritance
- Each subdomain needs its own credential file
- No wildcard pattern matching
- Manual account ID mapping in migrations

## Proposed Solution (Revised)

### 1. Cross-Platform Wildcard Credential Files

**CRITICAL CHANGE**: Windows doesn't allow `*` in filenames. Use one of these approaches:

#### Option A: Prefix-based naming (Recommended)

- `_wildcard.example.com.credentials.json` - Matches all subdomains of example.com
- `_wildcard.staging.example.com.credentials.json` - Matches all subdomains of staging.example.com
- `example.com.credentials.json` - Exact match (takes precedence)

#### Option B: Manifest file

- `wildcard-mappings.json` containing pattern-to-credential mappings
- More flexible but adds complexity

### 2. Domain Resolution Order

When authenticating a request for `api.staging.example.com`:

1. Normalize domain (lowercase, strip port)
2. Check for exact match: `api.staging.example.com.credentials.json`
3. Check for wildcard (if feature flag enabled):
   - `_wildcard.staging.example.com.credentials.json`
   - `_wildcard.example.com.credentials.json`
4. Return authentication error if no match found

### 3. Implementation Changes

#### A. Create Centralized Resolution Service

**CRITICAL**: Don't modify `getSafeCredentialPath()` - it should remain strict for security.

```typescript
private async resolveCredentialPath(domain: string): Promise<string | null> {
  // Check if wildcard feature is enabled
  if (process.env.CNP_WILDCARD_CREDENTIALS !== 'true') {
    return this.getSafeCredentialPath(domain);
  }

  // Normalize domain
  const normalizedDomain = this.normalizeDomain(domain);

  // Check cache with TTL
  const cached = this.resolutionCache.get(normalizedDomain);
  if (cached && cached.expiresAt > Date.now()) {
    logger.debug('Resolution cache hit', {
      domain: normalizedDomain,
      path: cached.path,
      matchType: cached.matchType
    });
    return cached.path;
  }

  // Try exact match first
  const exactPath = this.buildCredentialPath(normalizedDomain, false);
  if (await this.credentialFileExists(exactPath)) {
    this.cacheResolution(normalizedDomain, exactPath, 'exact');
    return exactPath;
  }

  // Try wildcard matches from most specific to least
  const wildcardPath = await this.findWildcardMatch(normalizedDomain);
  if (wildcardPath) {
    this.cacheResolution(normalizedDomain, wildcardPath, 'wildcard');
    return wildcardPath;
  }

  // Cache negative result
  this.cacheResolution(normalizedDomain, null, 'none');
  return null;
}
```

#### B. Domain Normalization

```typescript
private normalizeDomain(domain: string): string {
  // Remove port
  const domainWithoutPort = domain.split(':')[0];
  // Lowercase
  const normalized = domainWithoutPort.toLowerCase();
  // Remove trailing dot if present
  return normalized.replace(/\.$/, '');
}
```

#### C. Lightweight Existence Check

**CRITICAL**: Don't use `loadCredentials()` for existence checks - it's noisy and expensive.

```typescript
private async credentialFileExists(path: string): Promise<boolean> {
  try {
    await fs.promises.access(path, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
```

#### D. Wildcard Pattern Matching

```typescript
private async findWildcardMatch(domain: string): Promise<string | null> {
  const domainParts = domain.split('.');

  // Start from most specific wildcard
  for (let i = 0; i < domainParts.length - 1; i++) {
    const wildcardDomain = domainParts.slice(i + 1).join('.');
    const wildcardPath = this.buildCredentialPath(wildcardDomain, true);

    if (await this.credentialFileExists(wildcardPath)) {
      logger.info('Wildcard match found', {
        domain,
        wildcardPattern: `*.${wildcardDomain}`,
        level: i + 1
      });
      return wildcardPath;
    }
  }

  return null;
}

private buildCredentialPath(domain: string, isWildcard: boolean): string {
  const prefix = isWildcard ? '_wildcard.' : '';
  const filename = `${prefix}${domain}.credentials.json`;
  return path.join(this.credentialsDir, filename);
}
```

#### E. Cache with TTL

```typescript
interface CachedResolution {
  path: string | null;
  matchType: 'exact' | 'wildcard' | 'none';
  expiresAt: number;
}

private resolutionCache = new Map<string, CachedResolution>();

private cacheResolution(
  domain: string,
  path: string | null,
  matchType: 'exact' | 'wildcard' | 'none'
): void {
  const ttlMs = parseInt(process.env.CNP_RESOLUTION_CACHE_TTL || '300000'); // 5 min default
  this.resolutionCache.set(domain, {
    path,
    matchType,
    expiresAt: Date.now() + ttlMs
  });
}

// Public method to clear cache (for admin endpoints or file watchers)
public clearResolutionCache(): void {
  this.resolutionCache.clear();
  logger.info('Credential resolution cache cleared');
}
```

#### F. Update ALL Credential Lookups

**CRITICAL**: All methods must use the resolver, not just authentication.

```typescript
// In authenticateNonPersonalDomain and authenticatePersonalDomain:
const credentialPath = await this.resolveCredentialPath(context.host)
if (!credentialPath) {
  throw new AuthenticationError('No credentials configured for domain', {
    domain: context.host,
    requestId: context.requestId,
  })
}
const credentials = loadCredentials(credentialPath)

// In getSlackConfig:
const credentialPath = await this.resolveCredentialPath(domain)
if (!credentialPath) {
  return null
}
const credentials = loadCredentials(credentialPath)

// In getClientApiKey:
const credentialPath = await this.resolveCredentialPath(domain)
if (!credentialPath) {
  return null
}
const credentials = loadCredentials(credentialPath)
```

### 4. Configuration Format

No changes needed to the credential file format. The wildcard pattern is only in the filename:

```json
// File: _wildcard.example.com.credentials.json
{
  "type": "api_key",
  "accountId": "acc_example_wildcard",
  "api_key": "sk-ant-...",
  "client_api_key": "cnp_live_..."
}
```

### 5. Feature Flags and Environment Variables

```bash
# Enable wildcard credential resolution (default: false)
CNP_WILDCARD_CREDENTIALS=true

# Cache TTL in milliseconds (default: 300000 = 5 minutes)
CNP_RESOLUTION_CACHE_TTL=300000

# Debug credential resolution
CNP_DEBUG_RESOLUTION=true
```

### 6. Migration Strategy

#### Phase 1: Core Implementation (Week 1)

1. Implement centralized resolver with feature flag (disabled)
2. Add domain normalization
3. Implement lightweight existence check
4. Add caching with TTL
5. Update all credential lookup methods

#### Phase 2: Testing and Validation (Week 2)

1. Unit tests for resolution precedence
2. Integration tests with real files
3. Performance benchmarks
4. Cross-platform compatibility tests

#### Phase 3: Gradual Rollout (Week 3)

1. Enable feature flag in development
2. Create first wildcard credentials
3. Monitor logs and metrics
4. Enable in staging

#### Phase 4: Production Deployment (Week 4)

1. Enable feature flag in production (selected domains)
2. Monitor performance and cache hit rates
3. Gradually migrate high-subdomain accounts
4. Full rollout

### 7. Security Considerations

1. **Input Validation**: Never allow wildcards in user input domains
2. **Path Traversal**: Wildcards only allowed as prefix `_wildcard.`
3. **Precedence**: Exact matches always win over wildcards
4. **Audit Logging**: Log which credential file was matched
5. **Feature Flag**: Can disable instantly if issues arise

### 8. Performance Optimization

1. **Resolution Cache**: TTL-based with configurable duration
2. **Negative Caching**: Cache "not found" results too
3. **Lightweight Checks**: Use fs.access instead of JSON parsing
4. **Metrics**: Track cache hit rates and resolution times

### 9. Observability and Monitoring

```typescript
// Enhanced logging
logger.info('Credential resolved', {
  domain: normalizedDomain,
  credentialPath,
  matchType: 'exact' | 'wildcard',
  wildcardLevel: 1, // for wildcard matches
  cacheHit: true | false,
  resolutionTimeMs: elapsed
});

// Metrics to track
- credential_resolution_total{match_type="exact|wildcard|none"}
- credential_resolution_duration_ms
- credential_cache_hits_total
- credential_cache_misses_total
- wildcard_usage_by_level{level="1|2|3+"}
```

### 10. Testing Plan

#### Unit Tests

```typescript
describe('Credential Resolution', () => {
  it('should prefer exact match over wildcard')
  it('should match most specific wildcard first')
  it('should normalize domains (lowercase, strip port)')
  it('should respect feature flag')
  it('should cache results with TTL')
  it('should handle Windows-safe filenames')
})
```

#### Integration Tests

- Test with real credential files
- Test with multiple subdomains
- Test cache expiration
- Test feature flag toggle

#### Performance Tests

- Benchmark resolution time with many candidates
- Measure cache effectiveness
- Test with 1000+ unique domains

### 11. Rollback Plan

1. Set `CNP_WILDCARD_CREDENTIALS=false`
2. Clear resolution cache
3. Monitor for any failed authentications
4. All exact-match credentials continue working

### 12. Success Metrics

1. **Credential File Reduction**: 70%+ for multi-subdomain accounts
2. **Resolution Performance**: < 1ms for cache hits, < 10ms for misses
3. **Cache Hit Rate**: > 95% after warm-up
4. **Zero Breaking Changes**: Existing exact matches unaffected
5. **Cross-Platform**: Works on Linux, macOS, and Windows

## Implementation Checklist

- [ ] Create feature branch
- [ ] Implement domain normalization
- [ ] Create centralized resolver
- [ ] Add lightweight existence check
- [ ] Implement caching with TTL
- [ ] Update all credential lookups
- [ ] Add feature flag support
- [ ] Write comprehensive tests
- [ ] Update documentation
- [ ] Create ADR-024
- [ ] Performance benchmarks
- [ ] Staging deployment
- [ ] Production rollout

## Future Enhancements

1. **Pattern-based permissions**: Different permissions for different subdomains
2. **Dynamic subdomain creation**: Auto-provision credentials for new subdomains
3. **Hierarchical account structure**: Parent accounts managing child subdomains
4. **Hot reload**: Watch credential directory for changes
5. **Admin API**: Endpoints to manage wildcard mappings

## Decision Record

This implementation will be documented in ADR-024: Wildcard Subdomain Support, detailing the architectural decisions and trade-offs made.
