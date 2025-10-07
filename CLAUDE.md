# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## How to Contribute

This project is developed entirely by AI agents. Follow these contribution guidelines to maintain quality and consistency.

### Documentation First

- Keep documentation concise - reference ADRs for architectural details
- Update documentation before implementing features
- Remove temporary files, scripts, and test data before committing

### Consistency & Quality

- Follow existing code patterns and styles (check `package.json` for libraries)
- Run `bun run typecheck` before all commits
- Validate sources and provide references for decisions
- Use established patterns found in neighboring files

### Architectural Decisions

Always reference or create ADRs (docs/04-Architecture/ADRs/) for technical decisions:

- **ADR-001**: Monorepo structure with shared packages
- **ADR-013**: TypeScript project references for type safety
- **ADR-012**: Database schema evolution strategy
- **ADR-027**: Mandatory user authentication (critical: oauth2-proxy required in production)
- **ADR-021**: E2E testing with Playwright

### Contribution Style Guide

To ensure consistency, all contributions should adhere to the following key style points, which are derived from our established architecture and best practices. For deeper context, please refer to the linked documentation.

#### Monorepo & Code Structure

**1. Centralize Shared Logic in `packages/shared`**

- **Rationale**: Enforces a single source of truth for types and utilities shared between the `proxy` and `dashboard` services, preventing code duplication and type mismatches.
- **Reference**: [ADR-001: Monorepo Structure](docs/04-Architecture/ADRs/adr-001-monorepo-structure.md)

**2. Use TypeScript Project References for Type Checking**

- **Rationale**: Ensures correct build order and enables incremental type-checking across the monorepo, which is critical for both local development and CI performance.
- **Reference**: [ADR-013: TypeScript Project References](docs/04-Architecture/ADRs/adr-013-typescript-project-references.md)

**3. Use `kebab-case` for All New File Names**

- **Rationale**: Maintains a consistent and readable file structure across all operating systems and avoids issues with case-sensitivity in version control.
- **Reference**: [Development Guide](docs/01-Getting-Started/development.md)

#### TypeScript & Naming Conventions

**4. Adhere to Standard TypeScript Naming Conventions**

- **Rationale**: Use `PascalCase` for types and interfaces, and `camelCase` for variables and functions to maintain idiomatic and predictable code.
- **Reference**: [Development Guide: Adding a New API Endpoint](docs/01-Getting-Started/development.md#adding-a-new-api-endpoint)

**5. Use `snake_case` for API and Database Boundaries**

- **Rationale**: Creates a clear distinction between internal code (`camelCase`) and external data contracts (API JSON payloads and database columns), simplifying serialization.
- **Reference**: [API Reference](docs/02-User-Guide/api-reference.md)

#### API & Server Logic

**6. Return Standardized JSON Error Objects**

- **Rationale**: Provides consistent, predictable error feedback for all API clients, which simplifies front-end error handling and debugging.
- **Reference**: [API Reference: Error Responses](docs/02-User-Guide/api-reference.md#error-responses)

**7. Implement `/health` Endpoints for All Services**

- **Rationale**: Provides a standard, essential mechanism for monitoring service health in development, staging, and production environments.
- **Reference**: [Architecture Overview](docs/00-Overview/architecture.md#services)

**8. Externalize All Configuration via Environment Variables**

- **Rationale**: Prevents hardcoding of secrets and configuration, allowing for flexible and secure deployments across different environments.
- **Reference**: [Environment Variables Reference](docs/06-Reference/environment-vars.md)

#### Database

**9. Write Idempotent, Numerically-Prefixed Database Migrations**

- **Rationale**: Ensures that database schema changes are deterministic, repeatable, and can be safely applied without causing errors on subsequent runs.
- **Reference**: [Technical Debt Register: Database Migration Strategy](docs/04-Architecture/technical-debt.md#7--database-migration-strategy-resolved)

**10. Prevent N+1 Queries with Efficient Data Loading**

- **Rationale**: Avoids critical performance bottlenecks by fetching related data in a single query using joins or window functions instead of making multiple sequential queries.
- **Reference**: [Technical Debt Register: N+1 Query Pattern](docs/04-Architecture/technical-debt.md#2--n1-query-pattern-in-conversations-api-resolved)

#### Testing

**11. Use `data-testid` Selectors for All E2E Tests**

- **Rationale**: Decouples tests from fragile UI implementation details like CSS classes or text content, making them more resilient to refactoring and style changes.
- **Reference**: [ADR-021: E2E Testing Strategy](docs/04-Architecture/ADRs/adr-021-e2e-testing-strategy.md)

**12. Separate Test Files by Suffix: `.spec.ts` vs. `.test.ts`**

- **Rationale**: Clearly distinguishes end-to-end tests (`.spec.ts`) from unit/integration tests (`.test.ts`), allowing for targeted test runs and better organization.
- **Reference**: [ADR-021: E2E Testing Strategy](docs/04-Architecture/ADRs/adr-021-e2e-testing-strategy.md#test-organization)

**13. Run Stateful E2E Tests in Serial Mode**

- **Rationale**: Prevents state-based race conditions and ensures reliable test outcomes for complex user journeys that modify application state.
- **Reference**: [ADR-021: E2E Testing Strategy](docs/04-Architecture/ADRs/adr-021-e2e-testing-strategy.md#test-execution-strategy)

#### Build & CI/CD

**14. Use Multi-Stage Docker Builds for Production**

- **Rationale**: Creates smaller, more secure, and more efficient container images by separating build-time dependencies from the final runtime environment.
- **Reference**: [Architecture Overview: Production Deployment](docs/00-Overview/architecture.md#production-deployment)

**15. Enforce Lockfile Integrity with `--frozen-lockfile` in CI**

- **Rationale**: Guarantees reproducible builds by ensuring that the exact dependency versions specified in `bun.lockb` are used in the CI/CD pipeline.
- **Reference**: [Development Guide: CI Workflows](docs/01-Getting-Started/development.md#ci-workflows)

**16. Mandate `typecheck` and `format` as CI Quality Gates**

- **Rationale**: Automatically enforces universal code quality, formatting, and type safety on every pull request before it can be merged.
- **Reference**: [Development Guide: Code Quality and CI](docs/01-Getting-Started/development.md#code-quality-and-ci)

#### Documentation & Commits

**17. Follow the Conventional Commits Specification**

- **Rationale**: Creates a clean, readable, and machine-parsable commit history that aids in automatic changelog generation and semantic versioning.
- **Reference**: [Development Guide: Commit Messages](docs/01-Getting-Started/development.md#commit-messages)

**18. Document All Major Decisions as Architecture Decision Records (ADRs)**

- **Rationale**: Maintains a clear, historical record of key technical decisions, their context, and their consequences for future developers and stakeholders.
- **Reference**: [Repository Grooming Guide: Documentation](docs/01-Getting-Started/repository-grooming.md#6-documentation)

**19. Use Relative Links for All Internal Documentation**

- **Rationale**: Ensures that documentation links remain correct and navigable within the repository, regardless of whether it's viewed on GitHub, a local machine, or another platform.
- **Reference**: [Repository Grooming Guide](docs/01-Getting-Started/repository-grooming.md)

#### Security

**20. Require User Authentication for Production Dashboards**

- **Rationale**: Enforces mandatory user authentication via oauth2-proxy to prevent unauthorized access to sensitive conversation data, metrics, and account information. All actions are attributed to specific users.
- **Reference**: [ADR-027: Mandatory User Authentication](docs/04-Architecture/ADRs/adr-027-mandatory-user-authentication.md)

### AI Agent Rules

- Never commit secrets or API keys
- Ensure `credentials/` directory is in .gitignore (never commit credentials)
- Test all changes before committing
- Create ADRs for non-trivial architectural changes
- Follow [Repository Grooming](docs/01-Getting-Started/repository-grooming.md) for maintenance

## Project Description

Agent Prompt Train - High-performance proxy for Claude API with real-time monitoring dashboard. Built with Bun and Hono framework.

### Repository Structure

```
agent-prompttrain/
├── packages/shared/     # Shared types and utilities
├── services/
│   ├── proxy/          # API proxy service (Port 3000)
│   └── dashboard/      # Monitoring UI (Port 3001)
├── scripts/            # Utility scripts
├── docker/             # Container configurations
├── docs/               # Documentation and ADRs
└── credentials/        # Domain credentials
```

### Services

**Proxy Service** (Port 3000): Forwards requests to Claude API

- Multi-auth support (API keys, OAuth with auto-refresh)
- Conversation tracking with branching (see [ADR-003](docs/04-Architecture/ADRs/adr-003-conversation-tracking.md))
- Token usage monitoring (see [ADR-005](docs/04-Architecture/ADRs/adr-005-token-usage-tracking.md))

**Dashboard Service** (Port 3001): Real-time monitoring interface

- Request history and analytics
- Conversation visualization with branch support
- **⚠️ CRITICAL**: User authentication is MANDATORY via oauth2-proxy in production (see [ADR-027](docs/04-Architecture/ADRs/adr-027-mandatory-user-authentication.md))

### How It Works

Client → Proxy (auth, tracking) → Claude API → Response → Storage (PostgreSQL) → Dashboard

### Data & Configuration

- **Storage**: PostgreSQL with TypeScript migrations (see [ADR-012](docs/04-Architecture/ADRs/adr-012-database-schema-evolution.md))
- **Environment**: See [docs/06-Reference/environment-vars.md](docs/06-Reference/environment-vars.md) for all variables
- **Scripts**: See [scripts/README.md](scripts/README.md) for utility scripts

### Interfaces

- REST API on port 3000 (proxy)
- Web UI on port 3001 (dashboard)
- MCP prompts on /mcp (see [ADR-017](docs/04-Architecture/ADRs/adr-017-mcp-prompt-sharing.md))

### Maintenance

Follow [Repository Grooming](docs/01-Getting-Started/repository-grooming.md) for weekly maintenance tasks.

## Project Development

### Prerequisites

- Bun runtime (exclusive - no Node.js)
- PostgreSQL 12+
- Environment variables configured (`.env` file with `DATABASE_URL`)

### Essential Commands

```bash
# Installation (2 commands)
bun install                           # Install dependencies
bun run scripts/db/migrations/000-init-database.ts  # Initialize database (requires DATABASE_URL in .env)

# Development (3 commands)
bun run dev                          # Run both services
bun run dev:proxy                    # Run proxy only (port 3000)
bun run dev:dashboard                # Run dashboard only (port 3001)

# Build & Test (4 commands)
bun run build                        # Build all packages
bun test                             # Run unit tests
bun run test:e2e:smoke              # Run E2E smoke tests
bun run docker:validate              # Validate Docker build and compose

# Docker (2 commands)
./docker/build-images.sh            # Build Docker images
./docker-up.sh up -d                 # Run full stack with Docker
```

### Pre-commit Checks

Automatic via Husky:

- ESLint fixes for TypeScript/JavaScript
- Prettier formatting for all files
- Note: TypeScript checking is not automated - run manually as noted above

### Debugging

- Set `DEBUG=true` for verbose logging
- Set `DEBUG_SQL=true` for SQL query logging
- See [docs/05-Troubleshooting/debugging.md](docs/05-Troubleshooting/debugging.md) for more

### Additional Resources

- **All ADRs**: [docs/04-Architecture/ADRs/](docs/04-Architecture/ADRs/)
- **Environment Variables**: [docs/06-Reference/environment-vars.md](docs/06-Reference/environment-vars.md)
- **API Reference**: [docs/02-User-Guide/api-reference.md](docs/02-User-Guide/api-reference.md)
- **Deployment Guide**: [docs/03-Operations/deployment/](docs/03-Operations/deployment/)
