# Documentation Update Plan: Domain → Train-ID Migration

## Executive Summary

The migration from domain-based to train-id authentication affects **59 documentation files** across the repository. This document provides a prioritized action plan for updating all documentation to reflect the new authentication system.

## Migration Context

- **Old System**: Domain/subdomain-based authentication using Host headers
- **New System**: Train-ID based authentication using X-TRAIN-ID header
- **Backward Compatibility**: ENABLE_HOST_HEADER_FALLBACK provides temporary compatibility

## Priority Classification

### 🔴 CRITICAL - User-Facing Documentation (6 files)

These files are the first touchpoint for users and must be updated immediately:

1. **`/README.md`** - Main project README
   - Lines needing updates: 15, 53-101, 113, 179, 199-206, 357-403, 412-423
   - Actions: Remove domain examples, update to train-id, remove wildcard section
2. **`/docs/02-User-Guide/api-reference.md`** - API Documentation
   - Lines needing updates: 8-10, 115-122, 162-164, 179-180, 186, 199-200, 226-227, 246-247, 251-252, 265, 297-298, 304-305, 470-472, 503-504, 539-540, 560-561, 571-572, 626
   - Actions: Replace all domain parameters with train_id in endpoints and schemas
3. **`/docs/02-User-Guide/authentication.md`** - Authentication Guide
   - Lines needing updates: Entire file (19-337)
   - Actions: Complete rewrite for train-id authentication
4. **`/docs/02-User-Guide/migration-guide.md`** - Migration Guide
   - Actions: Ensure accuracy and completeness
5. **`/docs/02-User-Guide/train-id-authentication.md`** - New Train-ID Guide
   - Actions: Ensure this is comprehensive and replaces old auth docs
6. **`/credentials/README.md`** - Credentials Documentation
   - Lines needing updates: Entire file
   - Actions: Rewrite for train-id based credentials

### 🟠 HIGH PRIORITY - Configuration & Quick Start (5 files)

1. **`/docs/06-Reference/environment-vars.md`** - Environment Variables
   - Lines needing updates: 25-28, 53-58, 186-187, 250-252
   - Actions: Update HOST_HEADER_FALLBACK docs, remove wildcard settings
2. **`/docs/00-Overview/quickstart.md`** - Quick Start Guide
   - Lines needing updates: 23-28, 43-44, 70-71
   - Actions: Update examples to use train-id
3. **`/docs/01-Getting-Started/configuration.md`** - Configuration Guide
   - Actions: Update all domain-based configuration
4. **`/docs/04-Architecture/ADRs/adr-004-proxy-authentication.md`** - Auth ADR
   - Actions: Add deprecation notice or create new ADR for train-id
5. **`/docs/01-Getting-Started/installation.md`** - Installation Guide
   - Actions: Update installation examples

### 🟡 MEDIUM PRIORITY - Architecture & Operations (10+ files)

1. **`/docs/04-Architecture/ADRs/adr-023-wildcard-subdomain-support.md`**
   - Actions: Mark as DEPRECATED, add train-id migration note
2. **`/docs/00-Overview/architecture.md`**
   - Lines needing updates: 20, 106-107, 112, 128, 137-138, 160
3. **`/docs/00-Overview/features.md`**
   - Lines needing updates: 28-30, 36, 144, 146
4. **`/docs/03-Operations/security.md`**
   - Lines needing updates: 30, 95, 127, 138, 156, 178, 188-192, 199-202
5. **`/docs/03-Operations/deployment/docker-compose.md`**
   - Lines needing updates: 45-47, 281
6. **`/services/proxy/README.md`**
   - Actions: Update any domain references
7. **`/services/dashboard/README.md`**
   - Actions: Update domain filtering references
8. **`/scripts/db/migrations/README.md`**
   - Actions: Document migration 012 properly
9. **`/docs/03-Operations/deployment/docker.md`**
   - Actions: Update deployment examples
10. **`/docs/03-Operations/monitoring.md`**
    - Actions: Update monitoring references

### 🟢 LOW PRIORITY - Supporting Documentation (Remaining files)

- Test documentation files
- Script documentation
- Docker README files
- Internal architecture documentation
- AI agent instructions (CLAUDE.md)

## Key Changes Needed Across All Documentation

### 1. Terminology Updates

- Replace "domain" with "train-id" or "train"
- Replace "subdomain" references
- Replace "Host header" with "X-TRAIN-ID header"
- Remove "wildcard" authentication references

### 2. Code Example Updates

```bash
# OLD
curl https://api.example.com/v1/messages \
  -H "Authorization: Bearer YOUR_KEY"

# NEW
curl https://your-proxy.com/v1/messages \
  -H "X-TRAIN-ID: your-train-id" \
  -H "Authorization: Bearer YOUR_KEY"
```

### 3. Configuration File Updates

```json
// OLD: credentials/example.com.credentials.json
// NEW: credentials/your-train-id.credentials.json
```

### 4. API Schema Updates

- Change `domain` fields to `train_id` in all response schemas
- Update query parameter names from `domain` to `train_id`
- Update filter parameters in dashboard APIs

### 5. Database References

- Document that `domain` column is now `train_id`
- Update any SQL examples in documentation

## Implementation Checklist

- [ ] Update all CRITICAL priority files
- [ ] Update all HIGH priority files
- [ ] Update all MEDIUM priority files
- [ ] Update all LOW priority files
- [ ] Review and test all updated documentation
- [ ] Verify all code examples work
- [ ] Update any diagrams or visual documentation
- [ ] Create/update migration scripts documentation
- [ ] Add deprecation notices where appropriate
- [ ] Update changelog with documentation changes

## Notes for Documentation Team

1. **Backward Compatibility**: Document that `ENABLE_HOST_HEADER_FALLBACK=true` provides temporary compatibility
2. **Migration Path**: Ensure clear step-by-step migration instructions exist
3. **Examples**: All examples should use the new train-id system
4. **Deprecation**: Clearly mark domain-based features as deprecated
5. **ADRs**: Consider creating ADR-024 for the train-id migration decision

## Files That May Need New Content

1. **ADR-024**: New ADR documenting the train-id migration decision
2. **Migration Scripts Documentation**: Detailed docs for migration scripts
3. **Train-ID Best Practices**: Guide for choosing and managing train-ids

## Validation Steps

After updates are complete:

1. Search for remaining "domain" references
2. Verify all examples are executable
3. Check internal documentation links
4. Validate migration guide accuracy
5. Test backward compatibility documentation
