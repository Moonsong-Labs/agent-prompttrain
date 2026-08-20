# ADR-036: PostgreSQL Account Pool Coordination

## Status

Accepted

## Context

The proxy runs multiple service instances, but account-pool affinity, OAuth usage
caching, refresh deduplication, cooldowns, and request counts were process-local.
Each instance therefore polled Anthropic independently and could continue routing
requests to an account that another instance had just observed returning HTTP 429.
The generic retry policy also retried that same credential after short local
delays, even when Anthropic supplied a longer `Retry-After` value.

## Decision

Use PostgreSQL, which is already required by the proxy, as the coordination plane
for account-pool runtime state.

The database stores:

- the last successful OAuth usage response and its refresh schedule;
- a short refresh lease so only one proxy instance polls an account at a time;
- exponential failure backoff and the next allowed refresh time;
- per-credential, per-model upstream cooldowns;
- project-to-credential affinity; and
- the number of requests currently using each credential.

On an account-level Anthropic 429, the proxy records a model cooldown using the
upstream `Retry-After` or rate-limit reset headers, releases the account
reservation, and immediately tries one different eligible pooled account. The
ordinary Claude API retry policy does not retry 429 responses on the same
credential. If no account remains, the proxy returns HTTP 429 and preserves the
best known reset information for the client.

Usage refreshes use a 30-second PostgreSQL lease. Successful results are shared
for five minutes. Failures retain and conservatively extrapolate the last good
result, while scheduling the next attempt with exponential backoff and jitter.
Manual dashboard refreshes have a cluster-wide 30-second cooldown.

The utilization gates are independent: 90% for the five-hour/session window and
95% for seven-day/weekly windows. Model-scoped weekly limits use the seven-day
threshold.

## Consequences

### Positive

- Adding proxy instances no longer multiplies OAuth usage polling.
- Every instance avoids accounts that recently returned a model-specific 429.
- Client retry behavior follows Anthropic's real reset guidance.
- Shared affinity and in-flight counts make routing state observable and
  consistent across instances.

### Negative

- Account selection and cache refresh now depend on small PostgreSQL operations.
- The migration must be applied before deploying this proxy version.
- PostgreSQL is a coordination store rather than a dedicated distributed cache;
  this is acceptable at the current account and request scale.

## Alternatives Considered

- **Add another proxy instance only**: rejected because it multiplies usage
  polling and does not share cooldown knowledge.
- **Redis coordination**: rejected because PostgreSQL already provides the
  required atomic updates and avoids another production dependency.
- **Retry every 429 with backoff**: rejected because account quota exhaustion is
  better handled by immediate credential rotation and the upstream reset time.

## Links

- [ADR-031: Account Pool Auto-Switching](./adr-031-account-pool-auto-switching.md)
- [ADR-032: Centralized Usage Cache](./adr-032-centralized-usage-cache.md)
- [ADR-012: Database Schema Evolution Strategy](./adr-012-database-schema-evolution.md)
- [Anthropic API rate limits](https://platform.claude.com/docs/en/api/rate-limits)
- [Anthropic API errors](https://platform.claude.com/docs/en/api/errors)

---

Date: 2026-08-13
Authors: AI Agent
