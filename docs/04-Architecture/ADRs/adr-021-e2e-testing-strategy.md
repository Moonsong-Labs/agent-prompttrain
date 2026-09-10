# ADR-021: End-to-End Testing Strategy with Playwright

## Status

Accepted

## Context

The Agent Prompt Train project has been operating without comprehensive automated testing, which was identified as technical debt in ADR-011. As the application grows in complexity with features like conversation tracking, sub-task detection, and AI-powered analysis, the need for automated testing becomes critical to maintain quality and prevent regressions.

The dashboard service, built with HTMX (ADR-009), presents unique testing challenges:

- Server-side rendering with HTML-over-the-wire updates
- Server-Sent Events (SSE) for real-time data
- Complex user interactions across multiple pages
- Authentication requirements with API keys

## Decision

We will implement end-to-end testing using Playwright with the following architecture:

### Framework Choice: Playwright

- **Cross-browser support**: Test on Chromium, Firefox, and WebKit
- **Built-in waiting mechanisms**: Handles dynamic content and network requests
- **Powerful debugging**: Trace viewer, screenshots, and video recording
- **TypeScript support**: Consistent with project's language choice
- **Authentication helpers**: StorageState for session persistence

### Test Architecture

1. **Simplified Page Object Model**
   - Use simple helper functions over complex class hierarchies
   - Focus on data-testid selectors for stability
   - Avoid over-abstraction to maintain readability

2. **Test Organization**
   - `e2e/smoke-tests/`: Quick validation of all pages (rendering, console errors)
   - `e2e/journeys/`: Critical user workflows (viewing requests, analyzing conversations)
   - `e2e/utils/`: Shared utilities (auth, console monitoring)

3. **Console Error Monitoring**
   - Custom ConsoleMonitor utility to catch JavaScript errors
   - Filtering patterns for third-party noise (analytics, extensions)
   - Automatic failure on unexpected console errors

4. **Authentication Strategy**
   - Set the test user's `X-Auth-Request-Email` header at BrowserContext level
   - Use a fresh browser context for each test; preserve storage within a test for theme persistence
   - Keep `DASHBOARD_API_KEY` configured for dashboard-to-proxy API authentication

### CI/CD Integration

Building on the existing GitHub Actions infrastructure (ADR-008):

1. **PR Workflow** (Quick Feedback)
   - Run smoke tests only (@smoke tag)
   - Single browser (Chromium)
   - ~2 minute execution time

2. **Nightly Workflow** (Comprehensive)
   - All tests including journeys
   - Full browser matrix
   - Performance budget validation

3. **Test Execution Strategy**
   - Serial execution for auth-dependent tests (avoid race conditions)
   - Parallel execution for independent test files
   - Fail immediately on setup errors; keep independent browser jobs running for diagnostics

### Test Data Management

- Use existing database for test isolation
- No mocking of backend services (true e2e)
- Leverage Docker Compose for consistent environments (ADR-002)

### CI Environment

Both PR smoke tests and nightly tests use an empty PostgreSQL test database. The
`scripts/e2e/setup-database.ts` script applies the production bootstrap SQL and
subsequent migrations, then inserts synthetic projects, requests, and analysis
data. It requires an explicit `E2E_DATABASE_URL` naming a database ending in
`_test` and refuses an already initialized database.

With `TEST_START_SERVERS=true`, Playwright starts the built proxy and dashboard,
waits for their health endpoints, and stops both after testing. Set
`E2E_DATABASE_URL`, `DASHBOARD_API_KEY`, and optionally `TEST_BASE_URL` and
`TEST_PROXY_URL`. No live provider credentials are required. Install browsers
with `bunx playwright install --with-deps` so Linux system libraries are present.

The nightly matrix keeps all browser jobs running after a failure so each browser
produces diagnostics. Stateful journeys remain serial. Test setup and service
startup failures fail the job before browser assertions begin.

Theme assertions wait for CSS transitions to finish and check the configured
theme colors. Navigation links use the theme's link color in both light and dark
mode. Journeys assert seeded content rather than skipping checks on empty pages.

## Consequences

### Positive

- **Quality Assurance**: Automated detection of regressions before deployment
- **Developer Confidence**: Safe refactoring with immediate feedback
- **Documentation**: Tests serve as living documentation of user workflows
- **CI/CD Integration**: Seamless integration with existing GitHub Actions
- **Cross-browser Coverage**: Ensure compatibility across major browsers
- **Performance Monitoring**: Catch performance regressions early

### Negative

- **Maintenance Overhead**: Tests require updates when UI changes
- **Execution Time**: Full test suite takes 5-10 minutes
- **Flakiness Risk**: Network and timing issues can cause intermittent failures
- **Resource Usage**: Browser automation requires significant CI resources

### Neutral

- **Learning Curve**: Team needs to learn Playwright APIs and best practices
- **Test Data**: Requires careful management to avoid test interdependencies

## Implementation Notes

### Key Files Created

- `playwright.config.ts` - Playwright configuration
- `e2e/utils/console-monitor.ts` - Console error detection
- `e2e/smoke-tests/all-pages.spec.ts` - Smoke test coverage
- `e2e/journeys/critical-journeys.spec.ts` - User journey tests
- `.github/workflows/e2e-nightly.yml` - Nightly test workflow

### Running Tests Locally

```bash
# Install Playwright browsers
bunx playwright install --with-deps chromium

# Run all tests
bun run test:e2e:all

# Run smoke tests only
bun run test:e2e:smoke

# Run with UI mode for debugging
bunx playwright test --ui
```

### Performance Budgets

- Page load: < 2 seconds (CI: < 3 seconds)
- First interaction: < 1 second
- Navigation: < 500ms

## Related ADRs

- ADR-008: CI/CD Strategy (provides GitHub Actions infrastructure)
- ADR-009: Dashboard Architecture (HTMX patterns affect test strategies)
- ADR-011: Future Decisions (identified testing as pending decision)
- ADR-013: TypeScript Project References (affects test project structure)

## References

- [Playwright Documentation](https://playwright.dev)
- [Playwright CI dependencies](https://playwright.dev/docs/ci)
- [Playwright service lifecycle](https://playwright.dev/docs/test-webserver)
- [Testing HTMX Applications](https://htmx.org/essays/testing/)
- Implementation PR: #110
