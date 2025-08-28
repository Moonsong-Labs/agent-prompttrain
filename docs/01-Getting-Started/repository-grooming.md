# Repository Grooming Guide

This document outlines the grooming process for maintaining a clean and healthy Agent PromptTrain repository.

## Overview

Repository grooming is a regular maintenance activity to ensure code quality, reduce technical debt, and maintain consistency across the codebase.

## Grooming Checklist

### 1. Code Quality

- [ ] Run `bun run typecheck` and fix all TypeScript errors
- [ ] Run `bun run format` to ensure consistent formatting
- [ ] Run `bun run lint` and address all ESLint violations
- [ ] Remove or fix any console.log statements (use proper logging)
- [ ] Check for and remove unused imports and dead code

### 2. Technical Debt

- [ ] Review `../04-Architecture/technical-debt.md`
- [ ] Prioritize and fix HIGH priority items first
- [ ] Update technical debt register with resolution dates
- [ ] Document any new technical debt discovered

### 3. Database & Migrations

- [ ] Ensure `scripts/init-database.sql` reflects all schema changes
- [ ] Verify all migrations in `scripts/db/migrations/` are documented
- [ ] Check that migrations are idempotent (safe to run multiple times)
- [ ] Update database documentation if schema changes

### 4. Security & Privacy

- [ ] Review code for exposed secrets or credentials
- [ ] Ensure sensitive data is properly masked in logs
- [ ] Verify API keys are hashed before storage
- [ ] Check that test sample collection sanitizes data

### 5. Performance

- [ ] Look for N+1 query patterns
- [ ] Check for memory leaks (especially in Maps/Sets)
- [ ] Review SQL queries for missing indexes
- [ ] Monitor slow query logs

### 6. Documentation

- [ ] Update ADRs for any architectural decisions
- [ ] Keep CLAUDE.md current with latest changes
- [ ] Ensure all new features are documented
- [ ] Update API documentation for endpoint changes

### 7. Dependencies

- [ ] Review and update outdated dependencies
- [ ] Check for security vulnerabilities with `bun audit`
- [ ] Remove unused dependencies
- [ ] Document any new dependencies added

### 8. Testing

- [ ] Ensure critical paths have test coverage
- [ ] Update test samples if request/response formats change
- [ ] Verify CI/CD pipeline passes all checks
- [ ] Add tests for any bug fixes

## Grooming Process

### Before Starting

1. Create a new branch: `git checkout -b grooming/YYYY-MM-DD`
2. Review recent PRs and issues for context
3. Check CI/CD status for any failing checks

### During Grooming

1. Work through the checklist systematically
2. Create separate commits for different types of changes
3. Document significant changes in commit messages
4. Update relevant documentation as you go

### After Grooming

1. Create a PR with title: `[grooming] <summary of changes>`
2. Include a summary of all changes in the PR description
3. Reference any issues resolved
4. Request review from team members

## Frequency

- **Weekly**: Quick checks (linting, formatting, obvious issues)
- **Bi-weekly**: Full grooming including technical debt review
- **Monthly**: Comprehensive grooming including dependency updates

## Tools & Commands

```bash
# Type checking
bun run typecheck

# Formatting
bun run format

# Linting (when available)
bun run lint

# Run all checks
bun run typecheck && bun run format

# Database migrations
for file in scripts/db/migrations/*.ts; do bun run "$file"; done

# Check for outdated dependencies
bun outdated
```

## Common Issues & Fixes

### TypeScript Errors

- Missing types: Add proper type annotations
- Type mismatches: Update types or fix implementation
- Cannot find module: Check imports and tsconfig paths

### Performance Issues

- N+1 queries: Use joins or window functions
- Memory leaks: Add cleanup for Maps/Sets/Timers
- Slow queries: Add appropriate indexes

### Security Issues

- Exposed secrets: Move to environment variables
- Unmasked sensitive data: Add masking logic
- Missing validation: Add input validation

## References

- [Technical Debt Register](../04-Architecture/technical-debt.md)
- [Database Documentation](../03-Operations/database.md)
- [Architecture Decision Records](../04-Architecture/ADRs/)
- [AI Assistant Guidelines](../../CLAUDE.md)

---

Last Updated: 2024-06-26
