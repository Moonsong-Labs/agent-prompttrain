# ADR-031: Account Pool Auto-Switching

## Status

Accepted

## Context

Projects with high usage hit Claude's token rate limits (5-hour and 7-day windows), blocking work. There is no automatic failover to alternative accounts. Projects may have multiple Anthropic accounts linked, but the proxy always uses the single default account.

## Decision Drivers

- **Availability**: High-usage projects need uninterrupted access to Claude API
- **Transparency**: Switching should be invisible to clients (no API contract changes)
- **Simplicity**: Use Anthropic's existing OAuth usage API rather than tracking tokens locally
- **Safety**: Conservative behavior when usage data is unavailable

## Considered Options

1. **Reactive 429 handling**
   - Description: Switch accounts only after receiving a 429 from Claude API
   - Pros: Simple, no usage API dependency
   - Cons: Client experiences a failed request before switching; too late

2. **Proactive usage-based switching (selected)**
   - Description: Monitor real-time utilization via Anthropic OAuth usage API and switch before limits hit
   - Pros: Prevents failures, uses authoritative data, configurable thresholds
   - Cons: Depends on usage API availability

3. **Local token counting**
   - Description: Track token usage locally from response metadata
   - Pros: No external API dependency
   - Cons: Complex, inaccurate (doesn't account for usage outside the proxy)

## Decision

Add an `AccountPoolService` that automatically selects the best account from a project's linked Anthropic accounts based on real-time utilization data from the Anthropic OAuth usage API.

### Key Design Decisions

- **Usage source**: Anthropic OAuth usage API (`/api/oauth/usage`) — returns real utilization percentages for 5h and 7d windows, plus a structured `limits[]` array with model-scoped weekly limits (e.g. a separate Claude Fable 5 allowance)
- **Trigger**: Switch at 90% five-hour/session utilization or 95% seven-day/weekly utilization. Active model-scoped weekly limits gate only requests for that model, so a saturated Fable limit never blocks Sonnet/Opus traffic.
- **Threshold config**: Per-account `five_hour_limit_threshold` and `seven_day_limit_threshold` columns in `credentials` (0-1 scale, defaults 0.90 and 0.95). The legacy `token_limit_threshold` remains for rolling-deployment compatibility.
- **Selection strategy**: Sticky least-loaded — stay on current account until threshold exceeded, then switch to least-loaded alternative
- **Reactive failover**: An upstream account-level 429 starts a shared credential/model cooldown and triggers one immediate attempt on a different eligible pooled account. The same credential is not retried.
- **Exhaustion behavior**: Return HTTP 429 with reset information from `Retry-After`, Anthropic rate-limit reset headers, or cached usage `resets_at`
- **Pool activation**: Implicit — projects with 2+ linked Anthropic accounts use the pool; 0-1 accounts use default account directly
- **Bedrock accounts**: Excluded from pool (OAuth usage API is Anthropic-only)
- **Coordination**: PostgreSQL stores affinity, model cooldowns, and in-flight counts across proxy instances; see [ADR-036](./adr-036-postgresql-account-pool-coordination.md)

### Implementation Details

**Core algorithm:**

```
selectAccount(projectId):
  1. Get linked credentials, filter to Anthropic only
     - If < 2 Anthropic accounts -> use default account (no pooling)
  2. Read shared usage for all eligible Anthropic accounts in parallel
     - Filter to accounts under both window-specific thresholds
  3. Atomically reserve an account using shared affinity, cooldowns, utilization,
     and in-flight counts
  4. If all over threshold -> throw AccountPoolExhaustedError (HTTP 429)
```

**Database schema:**

```sql
ALTER TABLE credentials
  ADD COLUMN five_hour_limit_threshold DECIMAL(3,2) NOT NULL DEFAULT 0.90,
  ADD COLUMN seven_day_limit_threshold DECIMAL(3,2) NOT NULL DEFAULT 0.95;
```

> The original `token_limit_threshold` was raised to `0.95` by migration 024.
> Migration 025 supersedes it with separate five-hour and seven-day gates.

**AuthenticationService integration:**

```
authenticate(context):
  1. If MSL-Account header -> use explicit account (unchanged)
  2. Delegate to AccountPoolService.selectAccount()
  3. Fetch credential, refresh token, build headers (unchanged)
```

### Files

| File                                                                 | Description                                 |
| -------------------------------------------------------------------- | ------------------------------------------- |
| `services/proxy/src/services/account-pool-service.ts`                | Core threshold and account selection logic  |
| `services/proxy/src/services/account-pool-state-service.ts`          | PostgreSQL coordination and cooldown state  |
| `services/proxy/src/services/AuthenticationService.ts`               | Delegates to AccountPoolService             |
| `services/proxy/src/controllers/MessageController.ts`                | Handles AccountPoolExhaustedError as 429    |
| `scripts/db/migrations/018-account-pool-threshold.ts`                | Adds `token_limit_threshold` column         |
| `scripts/db/migrations/024-update-account-pool-threshold-default.ts` | Raises legacy threshold from 0.80 to 0.95   |
| `scripts/db/migrations/025-cluster-account-pool-coordination.ts`     | Shared state and separate window thresholds |

## Consequences

### Positive

- High-usage projects automatically fail over to alternative accounts
- Completely transparent to API clients (no contract changes)
- Per-account thresholds allow fine-grained control
- Conservative behavior (treat unknown usage as 100%) prevents over-utilization

### Negative

- Depends on Anthropic OAuth usage API availability
- Selection now performs lightweight PostgreSQL coordination operations
- Only works for Anthropic accounts (Bedrock has no equivalent usage API)

### Risks and Mitigations

- **Risk**: Anthropic usage API rate limits
  - **Mitigation**: Addressed by [ADR-032](./adr-032-centralized-usage-cache.md) with shared caching and extrapolation
- **Risk**: Usage API returns stale data
  - **Mitigation**: The 90% five-hour and 95% seven-day gates provide headroom before hard limits

## Links

- [ADR-032: Centralized Usage Cache](./adr-032-centralized-usage-cache.md)
- [ADR-036: PostgreSQL Account Pool Coordination](./adr-036-postgresql-account-pool-coordination.md)
- [ADR-030: Multi-Provider Support](./adr-030-multi-provider-support.md)

---

Date: 2026-02-24
Authors: AI Agent
