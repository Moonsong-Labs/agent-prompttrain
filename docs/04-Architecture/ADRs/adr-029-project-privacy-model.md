# ADR-029: Project Privacy Model

## Status

Accepted

## Context

The system needs to support private projects to protect sensitive conversations and data within organizations. While the dashboard is an internal tool used within a company, different teams or departments may need to keep their Claude API usage and conversations confidential from other internal teams.

## Decision

We implement a **selective privacy model** focused on protecting conversation content while maintaining project visibility for organizational transparency:

### Privacy Scope

1. **Private projects are visible** in project lists and detail views to all authenticated users
   - Rationale: Internal transparency about what projects exist within the organization
   - Users can see project names, creation dates, and member counts

2. **Conversations and requests are filtered** based on project membership
   - Only project members can view conversations, requests, and message content
   - Non-members receive empty results when querying private project data

3. **Member lists and API keys are visible** to all authenticated users
   - Rationale: This is an internal company dashboard where team composition transparency is valued
   - Partial API key visibility helps with debugging and audit trails

### Technical Implementation

#### Database Schema

- `projects.is_private` boolean column (default: false)
- `project_members` table for user-project relationships
- No changes needed to existing schema

#### Privacy Filtering

- Applied at the SQL query level using LEFT JOIN with project_members
- Pattern: `(p.is_private = false OR pm.user_email IS NOT NULL)`
- Centralized helper functions in `packages/shared/src/utils/auth.ts`

#### User Identification

- User email extracted from authentication headers (oauth2-proxy or AWS ALB OIDC)
- Email normalization applied for consistent comparison
- Project ownership automatically granted to project creator

### Security Considerations

1. **SQL Injection Prevention**: Parameter placeholders validated with regex pattern `/^\$\d+$/`
2. **XSS Prevention**: API keys stored in data attributes rather than inline JavaScript
3. **Email Normalization**: Case-insensitive email comparison to prevent bypass

### Performance Optimization

Recommended indexes:

```sql
CREATE INDEX idx_project_members_project_user ON project_members(project_id, user_email);
CREATE INDEX idx_project_members_user ON project_members(user_email);
CREATE INDEX idx_projects_private ON projects(is_private) WHERE is_private = true;
```

## Consequences

### Positive

- Conversations and sensitive data are protected from unauthorized access
- Simple privacy model that's easy to understand and implement
- Minimal performance impact with proper indexing
- Maintains organizational transparency about project existence

### Negative

- Project metadata (name, members) visible to all internal users
- No fine-grained permissions (view-only vs edit)
- Manual member management required (no automatic team sync)

### Neutral

- Privacy is binary (public/private) with no intermediate visibility levels
- All project members have equal access (no role-based viewing)

## Future Considerations

1. **Role-based access**: Implement viewer/editor/admin roles
2. **Team integration**: Sync with corporate directory or SSO groups
3. **Audit logging**: Track who views private project data
4. **Data classification**: Support multiple privacy levels beyond binary

## References

- [ADR-003: Conversation Tracking](adr-003-conversation-tracking.md)
- [ADR-027: Mandatory User Authentication](adr-027-mandatory-user-authentication.md)
- Database schema: `scripts/db/migrations/012-project-terminology.ts`
