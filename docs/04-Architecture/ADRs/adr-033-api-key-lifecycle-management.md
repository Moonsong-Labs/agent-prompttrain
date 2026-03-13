# ADR-033: API Key Lifecycle Management (Revoke & Delete)

## Status

Accepted

## Context

Project API keys currently support creation, listing, renaming, and revoking. Revoking is a soft-delete that sets `revoked_at` but keeps the row in the database. There is no way to permanently remove a revoked key from the system.

Additionally, the current REST API uses `DELETE` for revoking, which is semantically incorrect — revoking is a state change, not resource removal.

## Decision Drivers

- **RESTful semantics**: HTTP verbs should match their intended purpose
- **Data hygiene**: Owners and key creators should be able to permanently remove revoked keys
- **Security**: Only project owners or key creators should be able to hard-delete keys
- **Safety**: Only already-revoked keys can be deleted to prevent accidental data loss

## Considered Options

1. **Keep DELETE as revoke, add separate hard-delete endpoint**
   - Description: Add `POST /api-keys/:keyId/delete` or `DELETE` with `?permanent=true`
   - Pros: No breaking change to existing API
   - Cons: Non-standard REST, confusing semantics (DELETE doesn't delete)

2. **Move revoke to PATCH, use DELETE for hard-delete**
   - Description: `PATCH` with `{ revoked: true }` for revoking, `DELETE` for permanent removal
   - Pros: Correct REST semantics, clean API design
   - Cons: Breaking change to existing API consumers

## Decision

**Option 2**: Move revoke to PATCH, use DELETE for hard-delete.

### API Design

**PATCH `/api/projects/:projectId/api-keys/:keyId`**

- Body: `{ name?: string | null, revoked?: boolean }`
- When `revoked: true`: sets `revoked_at` and `revoked_by`
- Auth: project owner or key creator

**DELETE `/api/projects/:projectId/api-keys/:keyId`**

- Hard-deletes the key row from the database
- Precondition: key must already be revoked (returns 400 otherwise)
- Auth: project owner or key creator

### HTMX UI Changes

- Revoke button sends PATCH with `{ revoked: true }` instead of DELETE
- New "Delete" button appears on revoked keys, visible to project owner or key creator
- Confirmation dialog before hard-delete

### Type Changes

- `UpdateApiKeyRequest` gains optional `revoked?: boolean` field

### Files Changed

1. `packages/shared/src/types/credentials.ts` — update `UpdateApiKeyRequest`
2. `packages/shared/src/database/queries/api-key-queries.ts` — add revoke logic to update function
3. `services/dashboard/src/routes/api-keys.ts` — modify PATCH handler, change DELETE to hard-delete
4. `services/dashboard/src/routes/projects-ui.ts` — update HTMX routes and UI

## Consequences

### Positive

- REST API semantics are correct (PATCH for state change, DELETE for removal)
- Owners and key creators can clean up revoked keys they no longer need
- Safety guard: only revoked keys can be deleted

### Negative

- Breaking change to the DELETE endpoint behavior for API consumers

### Risks and Mitigations

- **Risk**: Clients using DELETE to revoke will now hard-delete instead
  - **Mitigation**: DELETE now requires the key to be already revoked, so current revoke-via-DELETE calls will get a 400 error rather than silently deleting

## Links

- [ADR-004: Proxy Authentication](./adr-004-proxy-authentication.md)
- [ADR-027: Mandatory User Authentication](./adr-027-mandatory-user-authentication.md)

---

Date: 2026-03-13
Authors: Development Team
