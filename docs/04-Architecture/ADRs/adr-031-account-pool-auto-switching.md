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

- **Usage source**: Anthropic OAuth usage API (`/api/oauth/usage`) — returns real utilization percentages for 5h and 7d windows
- **Trigger**: Switch when EITHER the 5-hour OR 7-day utilization exceeds the per-account threshold
- **Threshold config**: Per-account `token_limit_threshold` column in `credentials` table (0-1 scale, default 0.80)
- **Selection strategy**: Sticky least-loaded — stay on current account until threshold exceeded, then switch to least-loaded alternative
- **Exhaustion behavior**: Return HTTP 429 with `estimated_reset` from `resets_at` and `Retry-After` header
- **Pool activation**: Implicit — projects with 2+ linked Anthropic accounts use the pool; 0-1 accounts use default account directly
- **Bedrock accounts**: Excluded from pool (OAuth usage API is Anthropic-only)

### Implementation Details

**Core algorithm:**

```
selectAccount(projectId):
  1. Get linked credentials, filter to Anthropic only
     - If < 2 Anthropic accounts -> use default account (no pooling)
  2. Check sticky account (in-memory map per project)
     - If sticky is under threshold -> return immediately (fast path)
  3. Fetch usage for ALL Anthropic accounts in parallel
     - Filter to accounts under their threshold
     - Pick lowest utilization -> set as new sticky
  4. If all over threshold -> throw AccountPoolExhaustedError (HTTP 429)
```

**Database schema:**

```sql
ALTER TABLE credentials
  ADD COLUMN token_limit_threshold DECIMAL(3,2) NOT NULL DEFAULT 0.80;
```

**AuthenticationService integration:**

```
authenticate(context):
  1. If MSL-Account header -> use explicit account (unchanged)
  2. Delegate to AccountPoolService.selectAccount()
  3. Fetch credential, refresh token, build headers (unchanged)
```

### Files

| File                                                   | Description                                   |
| ------------------------------------------------------ | --------------------------------------------- |
| `services/proxy/src/services/account-pool-service.ts`  | Core pool selection logic with sticky routing |
| `services/proxy/src/services/AuthenticationService.ts` | Delegates to AccountPoolService               |
| `services/proxy/src/controllers/MessageController.ts`  | Handles AccountPoolExhaustedError as 429      |
| `scripts/db/migrations/018-account-pool-threshold.ts`  | Adds `token_limit_threshold` column           |

## Consequences

### Positive

- High-usage projects automatically fail over to alternative accounts
- Completely transparent to API clients (no contract changes)
- Per-account thresholds allow fine-grained control
- Conservative behavior (treat unknown usage as 100%) prevents over-utilization

### Negative

- Depends on Anthropic OAuth usage API availability
- In-memory sticky state is lost on process restart (acceptable — re-selects on next request)
- Only works for Anthropic accounts (Bedrock has no equivalent usage API)

### Risks and Mitigations

- **Risk**: Anthropic usage API rate limits
  - **Mitigation**: Addressed by [ADR-032](./adr-032-centralized-usage-cache.md) with shared caching and extrapolation
- **Risk**: Usage API returns stale data
  - **Mitigation**: Conservative threshold (80% default) provides headroom

## Links

- [ADR-032: Centralized Usage Cache](./adr-032-centralized-usage-cache.md)
- [ADR-030: Multi-Provider Support](./adr-030-multi-provider-support.md)

---

Date: 2026-02-24
Authors: AI Agent
