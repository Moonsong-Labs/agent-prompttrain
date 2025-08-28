# ADR-008: CI/CD Strategy with GitHub Actions

## Status

Accepted

## Context

As a monorepo with multiple services (proxy, dashboard) and shared packages, we needed a continuous integration and deployment strategy that could:

- Build and test all components
- Handle TypeScript compilation across workspaces
- Build Docker images for deployment
- Support both development and production workflows
- Provide fast feedback on pull requests

The choice of CI/CD platform and strategy would significantly impact developer productivity and deployment reliability.

## Decision Drivers

- **Monorepo Support**: Handle Bun workspaces effectively
- **Speed**: Fast feedback on commits and PRs
- **Cost**: Minimize CI/CD expenses
- **Integration**: Native integration with GitHub
- **Flexibility**: Support various deployment targets
- **Simplicity**: Easy to understand and maintain

## Considered Options

1. **GitHub Actions**
   - Description: GitHub's native CI/CD platform
   - Pros: Native integration, free for public repos, good marketplace
   - Cons: Limited free minutes for private repos

2. **GitLab CI**
   - Description: GitLab's integrated CI/CD
   - Pros: Powerful, self-hostable, great for monorepos
   - Cons: Requires GitLab, learning curve

3. **CircleCI**
   - Description: Cloud-based CI/CD service
   - Pros: Fast, good caching, Docker support
   - Cons: Cost, separate service to manage

4. **Jenkins**
   - Description: Self-hosted CI/CD
   - Pros: Fully customizable, free
   - Cons: Maintenance overhead, hosting costs

## Decision

We will use **GitHub Actions** for all CI/CD workflows.

### Implementation Details

1. **Workflow Structure**:

   ```yaml
   name: CI
   on:
     push:
       branches: [main]
     pull_request:
       branches: [main]

   jobs:
     typecheck:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: oven-sh/setup-bun@v1
         - run: bun install
         - run: bun run typecheck

     build:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: oven-sh/setup-bun@v1
         - run: bun install
         - run: bun run build
   ```

2. **Docker Build Strategy**:

   ```yaml
   docker:
     runs-on: ubuntu-latest
     strategy:
       matrix:
         service: [proxy, dashboard]
     steps:
       - uses: docker/setup-buildx-action@v3
       - uses: docker/build-push-action@v5
         with:
           context: .
           file: docker/${{ matrix.service }}/Dockerfile
           tags: agent-prompttrain-${{ matrix.service }}:${{ github.sha }}
   ```

3. **Error Handling**:

   ```yaml
   # Continue on TypeScript errors for development
   - run: bun run typecheck
     continue-on-error: ${{ github.event_name == 'pull_request' }}
   ```

4. **Caching Strategy**:
   - Cache Bun dependencies
   - Cache Docker layers
   - Cache build artifacts between jobs

## Consequences

### Positive

- **Native GitHub Integration**: Seamless PR checks and status
- **Cost Effective**: Free for public repositories
- **Good Ecosystem**: Extensive marketplace of actions
- **Easy Secrets Management**: Built-in secrets handling
- **Matrix Builds**: Parallel builds for multiple services
- **Self-Documenting**: Workflows are code in the repository

### Negative

- **Vendor Lock-in**: Tied to GitHub platform
- **Limited Free Minutes**: Constraints on private repos
- **YAML Complexity**: Complex workflows become hard to read
- **Debugging Challenges**: Limited SSH access for debugging

### Risks and Mitigations

- **Risk**: GitHub Actions outages affect deployments
  - **Mitigation**: Document manual deployment procedures
  - **Mitigation**: Consider backup CI/CD for critical situations

- **Risk**: Secrets exposure in logs
  - **Mitigation**: Use masked secrets
  - **Mitigation**: Careful log output review

## Implementation Notes

- Introduced in PR #1
- Uses official Bun setup action
- Separate workflows for CI and deployment
- TypeScript errors don't block PR reviews (continue-on-error)
- Docker builds use BuildKit for better caching

## Workflow Patterns

1. **PR Validation**:
   - TypeScript checking
   - Build verification
   - Future: automated tests

2. **Main Branch Protection**:
   - Require PR reviews
   - Require CI passing
   - No direct pushes

3. **Release Process**:
   - Tag triggers release workflow
   - Builds production Docker images
   - Pushes to registry

## Future Enhancements

1. **Test Integration**: Add test runs when tests exist
2. **Performance Testing**: Benchmark PRs against main
3. **Security Scanning**: Container and dependency scanning
4. **Deployment Automation**: Auto-deploy to staging
5. **Release Notes**: Automated changelog generation

## Links

- [PR #1: CI/CD Setup](https://github.com/Moonsong-Labs/agent-prompttrain/pull/1)
- [GitHub Actions Documentation](https://docs.github.com/actions)
- [Deployment Guide](../../03-Operations/deployment/)

---

Date: 2024-06-25
Authors: Development Team
