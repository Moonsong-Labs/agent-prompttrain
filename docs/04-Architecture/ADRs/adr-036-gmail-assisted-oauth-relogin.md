# ADR-036: Gmail-Assisted Anthropic OAuth Relogin

## Status

Accepted

## Context

Anthropic OAuth credentials occasionally require interactive reauthorization. The authorization
flow sends a one-time login link to the account email address before presenting the final consent
screen. When several credentials need reauthorization, manually finding each message, opening its
link, and copying the final authorization code is slow and error-prone.

All credential addresses can forward to one Gmail inbox, but login emails contain bearer links and
must be handled as secrets. The existing manual relogin flow must also remain available when Gmail
or browser automation is unavailable.

## Decision Drivers

- Minimize repetitive inbox and clipboard work without removing explicit user consent
- Keep login links and authorization codes out of logs and persistent storage
- Isolate browser sessions between Anthropic accounts
- Fail closed when message sender, recipient, age, link host, or OAuth state cannot be validated
- Preserve the current manual and headless relogin workflow

## Considered Options

1. **Gmail API with a controlled Playwright browser**
   - Pros: read-only mailbox access, precise time/sender/recipient filtering, isolated browser
     contexts, deterministic parsing, and automatic final-code capture
   - Cons: one-time Google Cloud OAuth setup; Gmail read-only permission can read the entire
     authorized mailbox; browser automation depends on Anthropic's login UI

2. **Gmail IMAP with an app password**
   - Pros: small implementation and no Google Cloud project
   - Cons: broad mailbox credentials, Google discourages app passwords, and app passwords are not
     available for every Google account security configuration

3. **Domain-level inbound email webhook**
   - Pros: no access to the personal Gmail inbox and strong message isolation
   - Cons: provider-specific infrastructure, changes to production mail routing, and additional
     secret delivery/storage concerns

4. **AI-based email interpretation**
   - Pros: tolerates superficial email template changes
   - Cons: exposes bearer links to another system, can select the wrong link, costs more, and adds
     no useful capability over deterministic MIME and URL parsing

## Decision

Add an opt-in Gmail-assisted mode to the local OAuth scripts:

- `auth:gmail-connect` performs a one-time Google OAuth desktop flow using
  `gmail.readonly` and stores the refresh token under the ignored `credentials/` directory.
- `auth:oauth-relogin --gmail` launches one fresh Playwright browser context per Anthropic
  credential.
- The script enters the stored credential email when the login form can be identified. Manual
  entry remains available if the page changes.
- After the email request, the script polls Gmail only for messages newer than the request and
  validates the sender and intended recipient before examining message content.
- Only HTTPS links on an allowlist of Anthropic-controlled hosts are eligible. The selected link
  stays in memory and is opened in the same browser context.
- The user must review and click the final Anthropic authorization control.
- The browser reads the resulting `code#state` value. The state must exactly match the PKCE flow
  before token exchange.
- `--own-browser` keeps Gmail assistance but replaces the controlled browser with a private window
  of the operator's own browser. The script opens the validated login link in that same private
  session, so the sign-in completes without a verification code, and the final authorization code is
  pasted or read from the clipboard.
- `--no-browser` retains the existing fully manual flow; Gmail assistance is never required by the
  proxy runtime.

No message body, login link, Google token, or Anthropic authorization code may be logged. Gmail
credentials must not be stored in PostgreSQL or committed to Git.

## Consequences

### Positive

- Relogin normally requires only the explicit approval click for each account.
- Each account receives a clean browser context, preventing accidental cross-account reuse.
- Parsing and validation are deterministic and testable without sending email content to AI.
- The feature is local-only and does not add Gmail access to the deployed proxy or dashboard.

### Negative

- claude.ai fronts the login form with Cloudflare and hCaptcha. A Playwright-controlled browser is
  frequently served a challenge instead of the login email, and the emailed link now renders a
  verification code that must be typed back into the originating tab, which the automated context
  cannot submit. `--own-browser` exists because the operator's normal browser clears these checks;
  the controlled-browser mode is best-effort and reports the challenge rather than waiting for a
  message that will never arrive.
- Operators must create a Google OAuth desktop client and authorize Gmail once.
- `gmail.readonly` is a restricted scope with mailbox-wide read capability; Gmail does not provide
  a per-label read scope.
- Anthropic login-page changes may require selector maintenance, although the flow falls back to
  manual email entry.

### Risks and Mitigations

- **Risk**: A compromised local token can read the authorized inbox.
  - **Mitigation**: Prefer a dedicated mailbox containing only Anthropic authentication messages,
    store tokens with owner-only permissions, and make Gmail assistance opt-in.
- **Risk**: A forged or stale message supplies a malicious link.
  - **Mitigation**: Require a fresh internal timestamp, expected sender domain, intended recipient,
    HTTPS, and an Anthropic-controlled hostname.
- **Risk**: Browser session state leaks between accounts.
  - **Mitigation**: Create and close a new non-persistent browser context for every credential.
- **Risk**: UI automation approves unintended access.
  - **Mitigation**: Never automate the final authorization click.

## Links

- [Authentication Guide](../../02-User-Guide/authentication.md)
- [ADR-021: End-to-End Testing Strategy](./adr-021-e2e-testing-strategy.md)
- [Google Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Google Gmail API message filtering](https://developers.google.com/workspace/gmail/api/guides/filtering)
- [Anthropic login documentation](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account)
- [Google app password guidance](https://support.google.com/accounts/answer/185833)

---

Date: 2026-07-22
Authors: Codex
