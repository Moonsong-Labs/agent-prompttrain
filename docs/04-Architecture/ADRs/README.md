# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the Agent Prompt Train project.

## What is an ADR?

An Architecture Decision Record captures an important architectural decision made along with its context and consequences.

## ADR Template

All ADRs in this project follow this template:

```markdown
# ADR-XXX: [Title]

## Status

[Proposed | Accepted | Deprecated | Superseded]

## Context

What is the issue that we're seeing that is motivating this decision or change?

## Decision

What is the change that we're proposing and/or doing?

## Consequences

What becomes easier or more difficult to do because of this change?
```

## Current ADRs

| ADR                                                       | Title                                  | Status     | Date       |
| --------------------------------------------------------- | -------------------------------------- | ---------- | ---------- |
| [ADR-001](./adr-001-monorepo-structure.md)                | Monorepo Structure                     | Accepted   | 2024-01-15 |
| [ADR-002](./adr-002-separate-docker-images.md)            | Separate Docker Images                 | Accepted   | 2024-01-20 |
| [ADR-003](./adr-003-conversation-tracking.md)             | Conversation Tracking Design           | Accepted   | 2024-02-01 |
| [ADR-004](./adr-004-proxy-authentication.md)              | Proxy-Level Authentication             | Accepted   | 2024-06-25 |
| [ADR-005](./adr-005-token-usage-tracking.md)              | Comprehensive Token Usage Tracking     | Accepted   | 2024-06-25 |
| [ADR-006](./adr-006-long-running-requests.md)             | Support for Long-Running Requests      | Accepted   | 2024-06-25 |
| [ADR-007](./adr-007-subtask-tracking.md)                  | Sub-task Detection and Tracking        | Accepted   | 2024-06-25 |
| [ADR-008](./adr-008-cicd-strategy.md)                     | CI/CD Strategy with GitHub Actions     | Accepted   | 2024-06-25 |
| [ADR-009](./adr-009-dashboard-architecture.md)            | Dashboard Architecture with HTMX       | Accepted   | 2024-06-25 |
| [ADR-010](./adr-010-docker-cli-integration.md)            | Docker-Based Claude CLI Integration    | Accepted   | 2024-06-25 |
| [ADR-011](./adr-011-future-decisions.md)                  | Future Architectural Decisions         | Proposed   | 2024-06-25 |
| [ADR-012](./adr-012-database-schema-evolution.md)         | Database Schema Evolution Strategy     | Accepted   | 2025-06-26 |
| [ADR-013](./adr-013-typescript-project-references.md)     | TypeScript Project References          | Accepted   | 2025-06-27 |
| [ADR-014](./adr-014-sql-query-logging.md)                 | SQL Query Logging                      | Accepted   | 2025-06-30 |
| [ADR-015](./adr-015-subtask-conversation-migration.md)    | Subtask Conversation Migration         | Accepted   | 2025-01-07 |
| [ADR-016](./adr-016-mcp-server-implementation.md)         | MCP Server Implementation              | Superseded | 2025-01-08 |
| [ADR-017](./adr-017-mcp-prompt-sharing.md)                | MCP Prompt Sharing                     | Accepted   | 2025-01-10 |
| [ADR-018](./adr-018-ai-powered-conversation-analysis.md)  | AI-Powered Conversation Analysis       | Accepted   | 2025-01-12 |
| [ADR-019](./adr-019-dashboard-read-only-mode-security.md) | Dashboard Read-Only Mode Security      | Accepted   | 2025-01-23 |
| [ADR-020](./adr-020-circuit-breaker-removal.md)           | Circuit Breaker Removal                | Accepted   | 2025-08-04 |
| [ADR-021](./adr-021-e2e-testing-strategy.md)              | E2E Testing Strategy                   | Accepted   | —          |
| [ADR-022](./adr-022-multi-architecture-docker-support.md) | Multi-Architecture Docker Support      | Accepted   | —          |
| [ADR-023](./adr-023-wildcard-subdomain-support.md)        | Wildcard Subtrain Support              | Superseded | —          |
| [ADR-024](./adr-024-train-id-header-routing.md)           | Header-Based Train and Account Routing | Accepted   | 2025-09-17 |

## Creating a New ADR

1. Copy the template from `template.md`
2. Name it `adr-XXX-brief-description.md` where XXX is the next number
3. Fill in all sections
4. Update this README with the new ADR
5. Submit PR for review

## Reviewing ADRs

When reviewing an ADR, consider:

- Is the context clearly explained?
- Are alternatives considered?
- Are trade-offs documented?
- Are the consequences realistic?
- Is the decision actionable?

## Superseding ADRs

When an ADR is superseded:

1. Update the original ADR status to "Superseded by ADR-XXX"
2. Link to the new ADR
3. Explain in the new ADR why the original decision is being changed

## References

- [Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) by Michael Nygard
- [ADR Tools](https://github.com/npryce/adr-tools)
- [MADR](https://adr.github.io/madr/) - Markdown Architectural Decision Records
