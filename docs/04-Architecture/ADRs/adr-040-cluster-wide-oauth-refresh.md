# ADR-040: Cluster-Wide OAuth Refresh and Dead Account Failover

## Status

Accepted

## Context

Anthropic rotates the OAuth refresh token on every refresh. When a refresh token
that was already used is presented again, the authorization server revokes the
active refresh token ([RFC 9700 §4.14.2](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2)),
while the access token issued by the first refresh keeps working until it
expires.

The proxy deduplicated refreshes only inside one process. With several proxy
instances, two of them could refresh the same account within the same second:
one stored the new tokens, the other was rejected, and the stored refresh token
was revoked as a side effect. The account kept working for one access token
lifetime (8 hours), then could no longer refresh. In production this silently
disabled about half of the pooled accounts.

A dead account then kept failing requests:

- an access token failure returned HTTP 401 without trying another pooled
  account, and without moving the project affinity away from the account;
- the account still looked available, because a failed usage fetch keeps the
  last good usage, extrapolated upward slowly. Since it was no longer used, the
  dead account looked the least busy and was preferred when the current account
  reached its threshold.

A project could therefore stay pinned to a dead account for hours.

## Decision

1. **Refresh under a cluster-wide lock.** A token refresh runs in a PostgreSQL
   transaction holding `pg_advisory_xact_lock` on the credential. The credential
   is re-read once the lock is held: if another instance refreshed it while this
   one waited, its stored access token is used and Anthropic is not called. New
   tokens are written on the locked connection, so a refresh uses a single pool
   connection. The token request times out after 30 seconds so the lock is
   never held indefinitely.
2. **Record rejected refresh tokens.** When Anthropic answers `invalid_grant`,
   the SHA-256 of the rejected refresh token is stored in
   `credentials.oauth_refresh_rejected_token_hash`, only if the credential still
   holds that refresh token. The account counts as rejected while the hash
   matches its refresh token, so storing new tokens (refresh or relogin) clears
   it without writing the column, like the alert hash of migration 028. A proxy
   started before migration 029 therefore still stores refreshed tokens. Other
   failures (5xx, network errors, other 4xx) are not recorded, so an Anthropic
   incident cannot disable accounts until a relogin.
3. **Skip rejected accounts in the pool.** Pool selection ignores accounts with
   a rejected refresh token, so they are neither polled for usage nor chosen.
4. **Fail over on access token failures.** When a pooled account cannot provide
   an access token, the proxy releases its reservation and selects another
   pooled account, until one works or the pool is exhausted. The new selection
   takes over the project affinity. A project default account (fewer than two
   linked accounts) has no alternative and still returns HTTP 401.

The transaction-scoped lock is used instead of a session lock because it is
released with the transaction even through a connection pooler.

## Consequences

### Positive

- Proxy instances can no longer revoke each other's refresh tokens.
- A dead account no longer fails requests for a pooled project, and the logs
  name the account that failed to refresh.
- Accounts needing a relogin can be listed with
  `oauth_refresh_rejected_token_hash = encode(sha256(convert_to(oauth_refresh_token, 'UTF8')), 'hex')`.

### Negative

- A refresh holds a PostgreSQL connection for the token request (usually under
  one second); instances waiting for the lock hold one connection each.
- Until migration 029 is applied, rejections are not recorded (an error is
  logged) and pools keep trying dead accounts, failing over on each request.
- Clients that refresh the same refresh token without this lock (another
  deployment, Claude Code logged in with the same session) can still race.
  `scripts/replay-sample.ts` refreshes through the proxy code for this reason.

## Alternatives Considered

- **Single refresher instance**: rejected because it adds leader election, and
  request handlers would still need to wait for the leader's result.
- **Session-level advisory lock**: rejected because it can leak on a pooled
  connection when the unlock fails or a transaction pooler is used.
- **Disable an account on any 400/401 refresh error**: rejected because a broad
  upstream incident would disable every account until a relogin.

## Links

- [ADR-036: PostgreSQL Account Pool Coordination](./adr-036-postgresql-account-pool-coordination.md)
- [ADR-031: Account Pool Auto-Switching](./adr-031-account-pool-auto-switching.md)
- [ADR-026: Database Credential Management](./adr-026-database-credential-management.md)
- [RFC 9700: Best Current Practice for OAuth 2.0 Security](https://www.rfc-editor.org/rfc/rfc9700.html)

---

Date: 2026-10-21
Authors: AI Agent
