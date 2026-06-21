# ADR-035: Account Pool Usage Unavailable Fallback

## Status

Accepted

## Context

Account pool auto-switching uses Anthropic's OAuth usage API to avoid selecting accounts whose 5-hour or 7-day utilization exceeds the configured threshold. The original policy from [ADR-031](./adr-031-account-pool-auto-switching.md) treated unavailable usage data as 100% utilization.

Production logs showed this policy could reject all accounts before a proxied request reached the normal authentication path:

- `UsageCacheService` could not retrieve an OAuth usage token for each linked account.
- `AccountPoolService` converted each missing usage result to `maxUtilization = 1`.
- The proxy returned HTTP 429 with "all accounts in pool have exceeded their utilization threshold" even though actual utilization was unknown.

This made credential refresh or usage-endpoint failures indistinguishable from real account exhaustion.

## Decision

Treat unavailable usage as an unknown signal, not as confirmed exhaustion.

Account pool selection now follows this policy:

1. If any account has known usage below its threshold, choose the least-utilized known account.
2. If all accounts with known usage are over threshold but one or more accounts have unavailable usage, choose a deterministic fallback account from the unknown-usage set.
3. If every account has known usage and all are over threshold, return `AccountPoolExhaustedError` with HTTP 429.

The fallback preserves sticky routing when possible. Otherwise it uses the linked account order returned from `project_accounts`. The selected account still flows through `AuthenticationService`, so OAuth refresh failures are surfaced as authentication failures instead of synthetic utilization exhaustion.

This supersedes the "treat unknown usage as 100%" part of [ADR-031](./adr-031-account-pool-auto-switching.md) while preserving proactive threshold enforcement whenever usage data is available.

## Consequences

### Positive

- Usage API or token lookup outages no longer block every proxied request with a misleading pool-exhaustion 429.
- Real over-threshold states still return 429 when usage is known for every account.
- Authentication failures are reported by the authentication path that actually owns OAuth refresh behavior.

### Negative

- During a usage-signal outage, the proxy may send a request to an account that is actually over its Anthropic limit. In that case, the upstream API can still return its own rate-limit response.
- Pool selection is less optimized while all usage data is unavailable because there is no reliable utilization signal.

## Links

- [ADR-031: Account Pool Auto-Switching](./adr-031-account-pool-auto-switching.md)
- [ADR-032: Centralized Usage Cache](./adr-032-centralized-usage-cache.md)

---

Date: 2026-06-21
Authors: AI Agent
