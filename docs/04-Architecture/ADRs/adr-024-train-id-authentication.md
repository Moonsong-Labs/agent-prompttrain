# ADR-024: Train-ID Based Authentication

## Status

Accepted

## Context

The original Agent Prompt Train system used domain-based authentication, where different domains (e.g., `api.example.com`, `staging.example.com`) would route to different credential files. This approach had several limitations:

1. **Infrastructure Complexity**: Required DNS configuration for each project/environment
2. **Local Development Friction**: Needed hosts file modifications for local testing
3. **Security Concerns**: Domain spoofing could potentially access wrong credentials
4. **Scaling Issues**: Managing many subdomains became cumbersome
5. **Claude CLI Integration**: Complex setup requiring domain configuration

The wildcard subdomain feature (ADR-023) attempted to address some of these issues but added more complexity.

## Decision

We have migrated from domain-based to train-id based authentication using the `X-TRAIN-ID` HTTP header. This change:

1. **Simplifies Infrastructure**: Single endpoint for all projects
2. **Improves Security**: Explicit header prevents accidental credential mixing
3. **Better Developer Experience**: No DNS/hosts configuration needed
4. **Claude CLI Compatible**: Works seamlessly with `ANTHROPIC_CUSTOM_HEADERS`
5. **Consistent Hashing**: Deterministic mapping of train-ids to accounts

### Key Design Decisions

1. **Header Choice**: `X-TRAIN-ID` follows HTTP header conventions
2. **Default Value**: "default" train-id when header is not provided
3. **Account Mapping**: SHA-256 consistent hashing for load distribution
4. **Backward Compatibility**: Optional `ENABLE_HOST_HEADER_FALLBACK` for migration

## Implementation

### Train-ID Extraction

```typescript
// middleware/train-id-extractor.ts
export const trainIdExtractor = async (c: Context, next: Next) => {
  const trainId = c.req.header('X-TRAIN-ID')
  c.set('trainId', trainId || 'default')
  await next()
}
```

### Account Mapping

```typescript
// services/AuthenticationService.ts
private mapTrainIdToAccount(trainId: string): string | null {
  const hash = crypto.createHash('sha256').update(trainId).digest()
  const hashValue = hash.readUInt32BE(0)
  const index = hashValue % this.availableAccounts.length
  return this.availableAccounts[index]
}
```

### Credential Structure

```
credentials/
├── account-001.credentials.json
├── account-002.credentials.json
└── account-003.credentials.json
```

### Database Migration

All `domain` columns have been migrated to `train_id`:

- Added `train_id` column with NOT NULL constraint
- Migrated existing domain data to train_id
- Created indexes for performance
- Marked domain column as deprecated (nullable)

## Consequences

### Positive

1. **Simplified Deployment**: No DNS configuration needed
2. **Better Security**: Explicit header prevents mistakes
3. **Easier Testing**: No hosts file modifications
4. **Claude CLI Integration**: Native support via ANTHROPIC_CUSTOM_HEADERS
5. **Load Distribution**: Consistent hashing across accounts
6. **Cleaner Architecture**: Single authentication mechanism

### Negative

1. **Breaking Change**: All clients must be updated
2. **Migration Required**: Database and credential files need migration
3. **Documentation Update**: All docs reference domains

### Neutral

1. **Header Requirement**: Clients must send X-TRAIN-ID header
2. **Default Behavior**: Unspecified train-id defaults to "default"
3. **Account Sharing**: Multiple train-ids map to same credentials

## Migration Path

1. **Enable Backward Compatibility**: `ENABLE_HOST_HEADER_FALLBACK=true`
2. **Run Migrations**: Database and credential file migrations
3. **Update Clients**: Add X-TRAIN-ID header to requests
4. **Monitor Usage**: Track deprecated host header usage
5. **Disable Compatibility**: Remove fallback after migration

## Related ADRs

- **Supersedes**: ADR-023 (Wildcard Subdomain Support)
- **Related**: ADR-003 (Conversation Tracking)
- **Related**: ADR-005 (Token Usage Tracking)

## References

- [Migration Guide](../../02-User-Guide/migration-guide.md)
- [Train-ID Authentication Guide](../../02-User-Guide/train-id-authentication.md)
- [RFC 6648](https://tools.ietf.org/html/rfc6648) - X- Header Deprecation (we still use X- for clarity)
